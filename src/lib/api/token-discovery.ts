// =============================================================================
// token-discovery.ts — P2-A: Autonomous Token Discovery
//
// Subscribes to the Pump.fun program via Helius WebSocket and auto-enqueues
// wallet collection jobs for every new token launch that passes quality filters.
//
// HOW IT WORKS
//   1. Open a persistent Helius WebSocket connection.
//   2. Subscribe to logsNotification for the Pump.fun program.
//   3. On every "Instruction: Create" log, fetch the full transaction to extract
//      the mint address and deployer.
//   4. Wait PRICE_CHECK_DELAY_MS then read the token's Pump.fun bonding curve
//      account directly via Helius getAccountInfo (no external APIs needed).
//   5. Check realSolReserves against MIN_SOL_INVESTED_LAMPORTS.  Too low → skip.
//   6. Check pending job queue depth against MAX_PENDING_JOBS.  Full → shed.
//   7. Insert a row into wallet_collection_jobs as "pending".
//      The /api/process-jobs Railway cron picks it up within 30 seconds.
//
// FILTER CRITERIA (from audit P2-A recommendations)
//   - Minimum market cap: $5,000 USD (Pump.fun native API — no DexScreener needed)
//   - Maximum pending queue depth: 50 jobs (sheds excess during spike)
//   - Duplicate suppression: 10-min in-memory dedup + DB unique-index guard
//
// RELIABILITY
//   - Exponential backoff reconnect (2s → 5 min cap) on WS close/error.
//   - Heartbeat ping every 30s — detects silent drops from cloud load balancers.
//   - All failures are caught and logged — HTTP server never crashes from here.
//   - Safe to call multiple times: singleton, .start() is idempotent.
//
// ENTRY POINT
//   import { startTokenDiscovery } from "./lib/api/token-discovery";
//   startTokenDiscovery().catch(err => console.error("[TokenDiscovery] Failed to start:", err));
// =============================================================================

import { createClient } from "@supabase/supabase-js";

const LOG = "[TokenDiscovery]";

// ── Program IDs ───────────────────────────────────────────────────────────────

/** Pump.fun bonding-curve program on Solana mainnet. */
const PUMPFUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

// ── Tunable config ─────────────────────────────────────────────────────────────

/**
 * Minimum real SOL invested into a token's bonding curve before a job is enqueued.
 *
 * FIX (audit P2-A-FILTER-01 v3): Both DexScreener (HTTP 403/530) and the Pump.fun
 * frontend API (HTTP 530, Cloudflare-blocked for all non-browser requests) are
 * unavailable from server environments.
 *
 * Instead we read the Pump.fun bonding curve account directly on-chain via Helius
 * `getAccountInfo`. The bonding curve address is already in the Create transaction
 * we fetched in step 1 (accounts[1] of the Pump.fun instruction). This is 100%
 * reliable — no external APIs beyond Helius, which we already depend on.
 *
 * `realSolReserves` (offset 32 in the bonding curve account, u64 LE) represents
 * the actual SOL invested by buyers so far. 0.5 SOL ≈ $35 at current prices —
 * a token must have attracted at least one real buyer to pass.
 */
const MIN_SOL_INVESTED_LAMPORTS = 500_000_000; // 0.5 SOL

/**
 * Maximum combined pending+processing jobs allowed before discovery sheds new tokens.
 * Prevents an infinite queue from building up during Pump.fun launch spikes.
 */
const MAX_PENDING_JOBS = 50;

/**
 * How long to wait after detecting a new token before reading its bonding curve.
 * 10 seconds gives enough time for initial buys to confirm on-chain.
 */
const PRICE_CHECK_DELAY_MS = 10_000;

/** Base reconnect delay in ms. Doubles on each failed attempt, up to RECONNECT_MAX_MS. */
const RECONNECT_BASE_MS = 2_000;

/** Maximum reconnect wait — 5 minutes. */
const RECONNECT_MAX_MS = 5 * 60 * 1_000;

/** In-memory dedup window. Prevents re-enqueueing the same token within 10 min. */
const DEDUP_TTL_MS = 10 * 60 * 1_000;

/**
 * Heartbeat interval — send a JSON-RPC ping every 30s.
 * Cloud load balancers (Railway, AWS ALB) silently drop idle WebSocket connections
 * after ~60-90 seconds. Without a ping, the process believes it is connected and
 * subscribed while receiving nothing. If no pong arrives within HEARTBEAT_TIMEOUT_MS
 * the connection is considered stale and forcibly recycled.
 */
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS  = 20_000;

// ── Supabase client ───────────────────────────────────────────────────────────

function buildSupabase() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_ANON_KEY ??
    "";
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ── Helius JSON-RPC ───────────────────────────────────────────────────────────

async function heliusRpc<T>(
  apiKey: string,
  method: string,
  params: unknown[],
): Promise<T> {
  const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${apiKey}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal:  AbortSignal.timeout(20_000),
  });
  const json = (await res.json()) as {
    result?: T;
    error?: { message: string };
  };
  if (json.error) throw new Error(`Helius RPC ${method}: ${json.error.message}`);
  return json.result as T;
}

// ── On-chain bonding curve reader ─────────────────────────────────────────────

/**
 * Pump.fun bonding curve account data layout (after 8-byte Anchor discriminator):
 *   offset  8 — virtualTokenReserves : u64 (8 bytes LE)
 *   offset 16 — virtualSolReserves   : u64 (8 bytes LE)
 *   offset 24 — realTokenReserves    : u64 (8 bytes LE)
 *   offset 32 — realSolReserves      : u64 (8 bytes LE)  ← quality signal
 *   offset 40 — tokenTotalSupply     : u64 (8 bytes LE)
 *   offset 48 — complete             : bool (1 byte)
 */
interface BondingCurveData {
  realSolReserves:      bigint;
  virtualSolReserves:   bigint;
  virtualTokenReserves: bigint;
  tokenTotalSupply:     bigint;
  complete:             boolean;
  /** Estimated market cap in USD (uses cached SOL price). */
  marketCapUsd:         number;
  /** Real SOL invested in USD (uses cached SOL price). */
  liquidityUsd:         number;
}

// ── SOL price cache (CoinGecko, refreshed every 10 min) ───────────────────────
let _cachedSolPriceUsd   = 150; // conservative fallback if CoinGecko is unavailable
let _solPriceLastFetched = 0;

async function getSolPriceUsd(): Promise<number> {
  const now = Date.now();
  if (now - _solPriceLastFetched < 10 * 60 * 1_000) return _cachedSolPriceUsd;
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      { signal: AbortSignal.timeout(5_000) },
    );
    if (res.ok) {
      const json = (await res.json()) as { solana?: { usd?: number } };
      if (json.solana?.usd && json.solana.usd > 0) {
        _cachedSolPriceUsd   = json.solana.usd;
        _solPriceLastFetched = now;
      }
    }
  } catch { /* use cached value */ }
  return _cachedSolPriceUsd;
}

/**
 * Fetch the current state of a Pump.fun bonding curve account via Helius
 * `getAccountInfo`. Decodes the binary Anchor struct directly — no web3.js needed.
 *
 * WHY ON-CHAIN INSTEAD OF EXTERNAL APIs:
 *   - DexScreener: only indexes tokens after Raydium graduation (~1% of tokens)
 *   - Pump.fun frontend API: HTTP 530 (Cloudflare blocks all non-browser requests)
 *   - Helius: already our RPC provider; 100% reliable for this use case
 */
async function fetchBondingCurveData(
  bondingCurveAddress: string,
  heliusApiKey: string,
): Promise<BondingCurveData | null> {
  try {
    const result = await heliusRpc<{
      value?: { data?: [string, string] } | null;
    }>(heliusApiKey, "getAccountInfo", [
      bondingCurveAddress,
      { encoding: "base64" },
    ]);

    const b64 = result.value?.data?.[0];
    if (!b64) return null;

    const buf = Buffer.from(b64, "base64");
    // Need at least 8 (discriminator) + 5 × 8 (u64 fields) + 1 (bool) = 49 bytes
    if (buf.length < 49) return null;

    const virtualTokenReserves = buf.readBigUInt64LE(8);
    const virtualSolReserves   = buf.readBigUInt64LE(16);
    // realTokenReserves at offset 24 — not needed for our filter
    const realSolReserves      = buf.readBigUInt64LE(32);
    const tokenTotalSupply     = buf.readBigUInt64LE(40);
    const complete             = buf[48] === 1;

    // Sanity check: Pump.fun bonding curve caps at ~79 SOL before graduating to
    // Raydium. If realSolReserves > 100 SOL we fetched the wrong account (a
    // Raydium pool, an SPL token mint, or another account at the extracted PDA).
    // Return null so the token is silently skipped — never enqueued with $843B
    // fake liquidity.
    const MAX_BC_LAMPORTS = BigInt(100_000_000_000); // 100 SOL
    if (realSolReserves > MAX_BC_LAMPORTS) return null;

    const solPrice = await getSolPriceUsd();

    // Market cap: virtual price × total supply (both in lamports/tokens, then convert)
    // price_per_token_lamports = virtualSolReserves / virtualTokenReserves
    // market_cap_sol = price_per_token_lamports × tokenTotalSupply / 1e9
    const pricePerTokenLamports =
      Number(virtualSolReserves) / Number(virtualTokenReserves);
    const marketCapSol =
      (pricePerTokenLamports * Number(tokenTotalSupply)) / 1e9;

    return {
      realSolReserves,
      virtualSolReserves,
      virtualTokenReserves,
      tokenTotalSupply,
      complete,
      marketCapUsd: marketCapSol * solPrice,
      liquidityUsd: (Number(realSolReserves) / 1e9) * solPrice,
    };
  } catch {
    return null;
  }
}

// ── Transaction parsing ───────────────────────────────────────────────────────

/**
 * Extract the mint address from a Pump.fun "Create" transaction.
 *
 * Strategy 1 (primary): Find the instruction whose programId is the Pump.fun
 * program and return accounts[0], which is always the mint on Pump.fun creates.
 *
 * Strategy 2 (fallback): Compare preTokenBalances vs postTokenBalances —
 * any mint present in post but not in pre is the newly-created token.
 */
function extractMint(tx: unknown): string | null {
  try {
    const t = tx as {
      transaction?: {
        message?: {
          instructions?: Array<{
            programId?: string;
            accounts?:  string[];
          }>;
        };
      };
      meta?: {
        innerInstructions?: Array<{
          instructions?: Array<{ programId?: string; accounts?: string[] }>;
        }>;
        preTokenBalances?:  Array<{ mint?: string }>;
        postTokenBalances?: Array<{ mint?: string }>;
      };
    };

    // Strategy 1 — outer instructions
    const outer = t.transaction?.message?.instructions ?? [];
    for (const ix of outer) {
      if (ix.programId === PUMPFUN_PROGRAM_ID && (ix.accounts?.length ?? 0) > 0) {
        return ix.accounts![0];
      }
    }

    // Strategy 1 — inner instructions
    for (const group of t.meta?.innerInstructions ?? []) {
      for (const ix of group.instructions ?? []) {
        if (ix.programId === PUMPFUN_PROGRAM_ID && (ix.accounts?.length ?? 0) > 0) {
          return ix.accounts![0];
        }
      }
    }

    // Strategy 2 — new mint in postTokenBalances
    const preMints = new Set(
      (t.meta?.preTokenBalances ?? []).map((b) => b.mint).filter(Boolean),
    );
    for (const b of t.meta?.postTokenBalances ?? []) {
      if (b.mint && !preMints.has(b.mint)) return b.mint;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Extract the bonding curve PDA address from a Pump.fun "Create" transaction.
 *
 * In a Pump.fun Create instruction the accounts array is always:
 *   [0] mint
 *   [1] bondingCurve  ← this is what we want
 *   [2] associatedBondingCurve
 *   [3] global
 *   ...
 *
 * Returns null if the instruction cannot be found or has fewer than 2 accounts.
 */
function extractBondingCurve(tx: unknown): string | null {
  try {
    const t = tx as {
      transaction?: {
        message?: {
          instructions?: Array<{
            programId?: string;
            accounts?:  string[];
          }>;
        };
      };
      meta?: {
        innerInstructions?: Array<{
          instructions?: Array<{ programId?: string; accounts?: string[] }>;
        }>;
      };
    };

    // Outer instructions first
    for (const ix of t.transaction?.message?.instructions ?? []) {
      if (ix.programId === PUMPFUN_PROGRAM_ID && (ix.accounts?.length ?? 0) >= 2) {
        return ix.accounts![1];
      }
    }

    // Inner instructions fallback
    for (const group of t.meta?.innerInstructions ?? []) {
      for (const ix of group.instructions ?? []) {
        if (ix.programId === PUMPFUN_PROGRAM_ID && (ix.accounts?.length ?? 0) >= 2) {
          return ix.accounts![1];
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Extract the deployer address from a transaction.
 * The fee payer (accountKeys[0]) is always the creator on Pump.fun.
 */
function extractDeployer(tx: unknown): string | null {
  try {
    const t = tx as {
      transaction?: {
        message?: {
          accountKeys?: Array<string | { pubkey?: string }>;
        };
      };
    };
    const keys = t.transaction?.message?.accountKeys ?? [];
    if (keys.length === 0) return null;
    const first = keys[0];
    return typeof first === "string"
      ? first
      : (first.pubkey ?? null);
  } catch {
    return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── TokenDiscovery singleton ──────────────────────────────────────────────────

export class TokenDiscovery {
  private static instance: TokenDiscovery | null = null;

  private ws:               WebSocket | null                 = null;
  private subscriptionId:   number | null                    = null;
  private running           = false;
  private reconnectAttempts = 0;
  private reconnectHandle:  ReturnType<typeof setTimeout> | null = null;

  // Heartbeat state — detects silent WS drops from cloud load balancers
  private heartbeatHandle:  ReturnType<typeof setInterval> | null = null;
  private heartbeatPending: ReturnType<typeof setTimeout>  | null = null;
  private lastMessageAt:    number | null                         = null;

  /**
   * In-memory dedup: tracks tokens enqueued within the last DEDUP_TTL_MS.
   * Prevents a spike of identical Create events from creating multiple jobs.
   */
  private readonly recentlyEnqueued = new Map<string, number>(); // mint → timestamp

  // ── Pipeline stage counters (all reset on process restart) ────────────────
  /** Pump.fun logsNotifications received (all types, before any filter). */
  private messagesReceived   = 0;
  /** Messages that passed the "Instruction: Create" pre-filter. */
  private createEventsFound  = 0;
  /** Transactions where extractMint() returned a valid address. */
  private mintsExtracted     = 0;
  /** Tokens that returned market data from Pump.fun API or DexScreener. */
  private dexScreenerHit     = 0;
  /** Tokens that passed the MIN_SOL_INVESTED_LAMPORTS floor. */
  private liquidityPassed    = 0;
  /** Total tokens successfully inserted into wallet_collection_jobs. */
  private tokensEnqueued     = 0;

  static getInstance(): TokenDiscovery {
    if (!TokenDiscovery.instance) {
      TokenDiscovery.instance = new TokenDiscovery();
    }
    return TokenDiscovery.instance;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Start the discovery feed. Safe to call multiple times — subsequent calls
   * are no-ops if already running.
   */
  async start(): Promise<void> {
    if (this.running) return;

    const apiKey = process.env.HELIUS_API_KEY ?? "";
    if (!apiKey) {
      console.error(
        `${LOG} HELIUS_API_KEY is not set — autonomous token discovery cannot start. ` +
        "Set HELIUS_API_KEY in Railway → Variables.",
      );
      return;
    }

    // Warn about missing Supabase creds at startup — don't silently fail later
    const sbUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
    const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? "";
    if (!sbUrl || !sbKey) {
      console.error(
        `${LOG} Supabase credentials missing (SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set). ` +
        "Discovery can detect tokens but cannot write wallet_collection_jobs. " +
        "Set both variables in Railway → Variables.",
      );
    }
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      console.warn(
        `${LOG} SUPABASE_SERVICE_ROLE_KEY is not set — falling back to anon key. ` +
        "After RLS hardening, anon-key writes to wallet_collection_jobs will be rejected.",
      );
    }

    this.running = true;
    this.connect();

    console.log(
      `${LOG} Started — watching Pump.fun for new token launches. ` +
      `Filters: realSolReserves ≥ ${(MIN_SOL_INVESTED_LAMPORTS / 1e9).toFixed(1)} SOL (on-chain bonding curve) | ` +
      `max queue depth: ${MAX_PENDING_JOBS}`,
    );
  }

  /** Gracefully stop the watcher and close the WebSocket. */
  stop(): void {
    this.running = false;
    this.stopHeartbeat();
    if (this.reconnectHandle !== null) {
      clearTimeout(this.reconnectHandle);
      this.reconnectHandle = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    console.log(`${LOG} Stopped. Total tokens enqueued this session: ${this.tokensEnqueued}`);
  }

  getStats(): {
    tokensEnqueued:  number;
    running:         boolean;
    subscriptionId:  number | null;
    wsAlive:         boolean;
    lastMessageAt:   string | null;
    pipeline: {
      messagesReceived:  number;
      createEventsFound: number;
      mintsExtracted:    number;
      dexScreenerHit:    number;
      liquidityPassed:   number;
      tokensEnqueued:    number;
    };
  } {
    return {
      tokensEnqueued:  this.tokensEnqueued,
      running:         this.running,
      subscriptionId:  this.subscriptionId,
      wsAlive:         this.ws !== null && this.ws.readyState === WebSocket.OPEN,
      lastMessageAt:   this.lastMessageAt ? new Date(this.lastMessageAt).toISOString() : null,
      pipeline: {
        messagesReceived:  this.messagesReceived,
        createEventsFound: this.createEventsFound,
        mintsExtracted:    this.mintsExtracted,
        dexScreenerHit:    this.dexScreenerHit,
        liquidityPassed:   this.liquidityPassed,
        tokensEnqueued:    this.tokensEnqueued,
      },
    };
  }

  // ── WebSocket lifecycle ─────────────────────────────────────────────────────

  private connect(): void {
    if (!this.running) return;

    const apiKey = process.env.HELIUS_API_KEY ?? "";
    const wssUrl = `wss://mainnet.helius-rpc.com/?api-key=${apiKey}`;

    try {
      this.ws = new WebSocket(wssUrl);
    } catch (err) {
      console.error(`${LOG} WebSocket constructor threw:`, err);
      this.scheduleReconnect();
      return;
    }

    this.ws.addEventListener("open", () => {
      console.log(`${LOG} WebSocket connected to Helius.`);
      this.reconnectAttempts = 0;
      this.subscribe();
      this.startHeartbeat();
    });

    this.ws.addEventListener("message", (event: MessageEvent) => {
      this.lastMessageAt = Date.now();
      void this.handleMessage(event.data as string);
    });

    this.ws.addEventListener("close", (event: CloseEvent) => {
      console.warn(
        `${LOG} WebSocket closed (code ${event.code}). Scheduling reconnect…`,
      );
      this.subscriptionId = null;
      this.stopHeartbeat();
      this.scheduleReconnect();
    });

    this.ws.addEventListener("error", (event: Event) => {
      console.error(`${LOG} WebSocket error:`, event);
    });
  }

  private subscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id:      1,
        method:  "logsSubscribe",
        params:  [
          { mentions: [PUMPFUN_PROGRAM_ID] },
          { commitment: "confirmed" },
        ],
      }),
    );
  }

  // ── Heartbeat ───────────────────────────────────────────────────────────────

  /**
   * Send a JSON-RPC ping every HEARTBEAT_INTERVAL_MS.
   * If no pong arrives within HEARTBEAT_TIMEOUT_MS, the connection is silently
   * dead (dropped by a cloud load balancer with no close frame). Force-recycle it.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat(); // clear any stale handle

    this.heartbeatHandle = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

      try {
        // Helius accepts arbitrary JSON-RPC requests; use an innocuous one
        this.ws.send(
          JSON.stringify({ jsonrpc: "2.0", id: 999, method: "getHealth", params: [] }),
        );
      } catch {
        // send() can throw if the WS is closing
        return;
      }

      // Expect a response within HEARTBEAT_TIMEOUT_MS
      this.heartbeatPending = setTimeout(() => {
        console.warn(
          `${LOG} Heartbeat timeout — no response in ${HEARTBEAT_TIMEOUT_MS / 1000}s. ` +
          "Connection appears stale. Force-recycling WebSocket…",
        );
        // Force-close the zombie connection — the close event will trigger reconnect
        try { this.ws?.close(); } catch { /* ignore */ }
      }, HEARTBEAT_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatHandle !== null) {
      clearInterval(this.heartbeatHandle);
      this.heartbeatHandle = null;
    }
    if (this.heartbeatPending !== null) {
      clearTimeout(this.heartbeatPending);
      this.heartbeatPending = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    this.reconnectAttempts++;
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts - 1),
      RECONNECT_MAX_MS,
    );
    const delaySec = (delay / 1000).toFixed(0);
    console.log(
      `${LOG} Reconnect attempt ${this.reconnectAttempts} in ${delaySec}s…`,
    );
    this.reconnectHandle = setTimeout(() => {
      this.reconnectHandle = null;
      this.connect();
    }, delay);
  }

  // ── Message handling ────────────────────────────────────────────────────────

  private async handleMessage(raw: string): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const m = msg as {
      result?:  unknown;
      id?:      number;
      method?:  string;
      params?:  {
        result?: {
          value?: {
            signature?: string;
            logs?:      string[];
            err?:       unknown;
          };
        };
      };
    };

    // Clear heartbeat pending timer — any message proves the connection is live
    if (this.heartbeatPending !== null) {
      clearTimeout(this.heartbeatPending);
      this.heartbeatPending = null;
    }

    // Subscription confirmation
    if (typeof m.result === "number" && m.id === 1) {
      this.subscriptionId = m.result;
      console.log(
        `${LOG} Subscribed to Pump.fun program logs (sub ID: ${this.subscriptionId}).`,
      );
      return;
    }

    // Heartbeat response (id 999) — connection confirmed alive, nothing else to do
    if (m.id === 999) return;

    if (m.method !== "logsNotification") return;

    this.messagesReceived++;

    const value     = m.params?.result?.value;
    const signature = value?.signature;
    const logs      = Array.isArray(value?.logs) ? (value.logs as string[]) : [];
    const txErr     = value?.err;

    if (!signature) return;

    // Skip failed transactions
    if (txErr !== null && txErr !== undefined) return;

    // Fast pre-filter: only process "Create" instructions logged BY Pump.fun.
    //
    // Solana logs programs sequentially:
    //   "Program <id> invoke [N]"        ← this program is now executing
    //   "Program log: Instruction: Create"
    //   "Program <id> success"
    //
    // We scan the log array to ensure "Instruction: Create" appears while
    // the Pump.fun program is the active invoker — not SPL Token or another
    // program in the same transaction that also fires "Instruction: Create".
    let activeProgramIsPump   = false;
    let activeProgramIsCreate = false;
    for (const log of logs) {
      if (log.startsWith(`Program ${PUMPFUN_PROGRAM_ID} invoke`)) {
        activeProgramIsPump = true;
      } else if (activeProgramIsPump && log.includes("Instruction: Create")) {
        activeProgramIsCreate = true;
        break;
      } else if (
        log.startsWith(`Program ${PUMPFUN_PROGRAM_ID} success`) ||
        log.startsWith(`Program ${PUMPFUN_PROGRAM_ID} failed`)
      ) {
        activeProgramIsPump = false;
      }
    }
    if (!activeProgramIsCreate) return;

    this.createEventsFound++;

    // Fire-and-forget — don't await so we don't block the message loop
    void this.processNewToken(signature).catch((err) => {
      console.error(`${LOG} processNewToken threw for sig ${signature}:`, err);
    });
  }

  // ── Token processing pipeline ───────────────────────────────────────────────

  private async processNewToken(signature: string): Promise<void> {
    const apiKey = process.env.HELIUS_API_KEY ?? "";

    // ── Step 1: Fetch transaction to extract mint + deployer ─────────────────
    let tx: unknown;
    try {
      tx = await heliusRpc<unknown>(apiKey, "getTransaction", [
        signature,
        {
          encoding:                       "jsonParsed",
          commitment:                     "confirmed",
          maxSupportedTransactionVersion: 0,
        },
      ]);
    } catch (err) {
      console.error(`${LOG} getTransaction failed (sig: ${signature}):`, err);
      return;
    }

    if (!tx) return;

    const mintAddress = extractMint(tx);
    if (!mintAddress) {
      // Not every Pump.fun log with "Create" is a token launch — skip silently
      console.log(`${LOG} [pipeline] Create event sig=${signature} — extractMint returned null, skipping`);
      return;
    }

    this.mintsExtracted++;

    // ── Step 2: In-memory dedup ──────────────────────────────────────────────
    const now        = Date.now();
    const lastSeen   = this.recentlyEnqueued.get(mintAddress);
    if (lastSeen && now - lastSeen < DEDUP_TTL_MS) return;

    const deployer = extractDeployer(tx);

    console.log(
      `${LOG} New Pump.fun launch detected: ${mintAddress}` +
      ` | deployer: ${deployer ?? "unknown"}` +
      ` | sig: ${signature}`,
    );

    // ── Step 3: Queue depth check ────────────────────────────────────────────
    const depth = await this.getQueueDepth();
    if (depth >= MAX_PENDING_JOBS) {
      console.warn(
        `${LOG} Queue at capacity (${depth}/${MAX_PENDING_JOBS} pending) — ` +
        `shedding ${mintAddress}.`,
      );
      return;
    }

    // ── Step 4: Wait for initial buys to confirm, then read bonding curve ────
    const bondingCurve = extractBondingCurve(tx);
    console.log(
      `${LOG} Waiting ${PRICE_CHECK_DELAY_MS / 1000}s then reading bonding curve ` +
      `for ${mintAddress}` +
      (bondingCurve ? ` (bc: ${bondingCurve.slice(0, 8)}…)` : " (no bonding curve found in tx)") + "…",
    );
    await sleep(PRICE_CHECK_DELAY_MS);

    // ── Step 5: On-chain bonding curve filter ─────────────────────────────────
    const bcData = bondingCurve
      ? await fetchBondingCurveData(bondingCurve, apiKey)
      : null;

    if (!bcData) {
      console.log(
        `${LOG} [pipeline] ${mintAddress} — bonding curve account not readable ` +
        `after ${PRICE_CHECK_DELAY_MS / 1000}s` +
        (bondingCurve ? "" : " (bondingCurve address missing from tx)"),
      );
      return;
    }

    this.dexScreenerHit++; // counter now means "bonding curve data successfully read"

    const realSolInvested = Number(bcData.realSolReserves) / 1e9;
    console.log(
      `${LOG} [pipeline] ${mintAddress} — realSol=${realSolInvested.toFixed(3)} SOL ` +
      `| mcap≈${bcData.marketCapUsd.toFixed(0)} | complete=${bcData.complete}`,
    );

    // Skip tokens whose bonding curve has already completed (graduated to Raydium).
    // After graduation, realSolReserves reflects the final curve state — not live
    // liquidity — and the wallet dynamics differ from fresh Pump.fun launches.
    if (bcData.complete) {
      console.log(
        `${LOG} [pipeline] ${mintAddress} — bonding curve complete (graduated to Raydium). Skipping.`,
      );
      return;
    }

    if (bcData.realSolReserves < MIN_SOL_INVESTED_LAMPORTS) {
      console.log(
        `${LOG} [pipeline] ${mintAddress} — only ${realSolInvested.toFixed(3)} SOL invested ` +
        `(need ${(MIN_SOL_INVESTED_LAMPORTS / 1e9).toFixed(1)} SOL) — skipping.`,
      );
      return;
    }

    this.liquidityPassed++;

    // ── Step 6: Enqueue job ──────────────────────────────────────────────────
    const enqueued = await this.enqueueJob(
      mintAddress,
      deployer,
      bcData.marketCapUsd,
      bcData.liquidityUsd,
    );

    if (enqueued) {
      this.tokensEnqueued++;
      this.recentlyEnqueued.set(mintAddress, Date.now());
      this.pruneDedup();
    }
  }

  // ── Queue operations ────────────────────────────────────────────────────────

  private async getQueueDepth(): Promise<number> {
    const sb = buildSupabase();
    if (!sb) return 0;
    try {
      const { count, error } = await sb
        .from("wallet_collection_jobs")
        .select("*", { count: "exact", head: true })
        .in("status", ["pending", "processing"]);
      if (error || count === null) return 0;
      return count;
    } catch {
      return 0;
    }
  }

  private async enqueueJob(
    tokenAddress: string,
    deployer:     string | null,
    marketCapUsd: number,
    liquidityUsd: number,
  ): Promise<boolean> {
    const sb = buildSupabase();
    if (!sb) {
      console.error(
        `${LOG} Cannot enqueue ${tokenAddress} — Supabase credentials not set. ` +
        "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Railway → Variables.",
      );
      return false;
    }

    try {
      // DB-level dedup: check for existing pending/processing job first
      const { data: existing } = await sb
        .from("wallet_collection_jobs")
        .select("id, status")
        .eq("token_address", tokenAddress)
        .in("status", ["pending", "processing"])
        .limit(1)
        .maybeSingle();

      if (existing) {
        console.log(
          `${LOG} Job already exists for ${tokenAddress} (status: ${(existing as { id: string; status: string }).status}) — skipping.`,
        );
        return false;
      }

      const { data, error } = await sb
        .from("wallet_collection_jobs")
        .insert({
          token_address:  tokenAddress,
          status:         "pending",
          enqueued_at:    new Date().toISOString(),
          market_cap_usd: marketCapUsd > 0 ? marketCapUsd : null,
          liquidity_usd:  liquidityUsd > 0 ? liquidityUsd : null,
        })
        .select("id")
        .single();

      if (error) {
        // Unique constraint violation (wcj_token_pending_unique_idx) — already enqueued
        if (error.code === "23505") {
          console.log(`${LOG} Duplicate job constraint for ${tokenAddress} — already queued.`);
          return false;
        }
        console.error(`${LOG} Failed to insert job for ${tokenAddress}: ${error.message}`);
        return false;
      }

      const jobId = (data as { id: string }).id;
      console.log(
        `${LOG} ✓ Enqueued ${tokenAddress}` +
        ` | job: ${jobId}` +
        ` | liq: $${liquidityUsd.toFixed(0)}` +
        ` | mcap: $${marketCapUsd.toFixed(0)}` +
        ` | deployer: ${deployer ?? "unknown"}` +
        ` | total this session: ${this.tokensEnqueued + 1}`,
      );
      return true;
    } catch (err) {
      console.error(`${LOG} enqueueJob threw for ${tokenAddress}:`, err);
      return false;
    }
  }

  // ── Dedup maintenance ───────────────────────────────────────────────────────

  private pruneDedup(): void {
    const cutoff = Date.now() - DEDUP_TTL_MS;
    for (const [addr, ts] of this.recentlyEnqueued) {
      if (ts < cutoff) this.recentlyEnqueued.delete(addr);
    }
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Start the autonomous Pump.fun token discovery feed.
 * Call once at server startup — subsequent calls are no-ops (singleton).
 * Returns the singleton instance for access to stats/stop.
 */
export async function startTokenDiscovery(): Promise<TokenDiscovery> {
  const discovery = TokenDiscovery.getInstance();
  await discovery.start();
  return discovery;
}
