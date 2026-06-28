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
//   4. Wait DEXSCREENER_DELAY_MS for DexScreener to index the new token.
//   5. Check liquidity against MIN_LIQUIDITY_USD.  Too low → skip.
//   6. Check pending job queue depth against MAX_PENDING_JOBS.  Full → shed.
//   7. Insert a row into wallet_collection_jobs as "pending".
//      The /api/process-jobs Railway cron picks it up within 30 seconds.
//
// FILTER CRITERIA (from audit P2-A recommendations)
//   - Minimum initial liquidity: $5,000 USD
//   - Maximum pending queue depth: 50 jobs (sheds excess during spike)
//   - Duplicate suppression: 10-min in-memory dedup + DB unique-index guard
//
// RELIABILITY
//   - Exponential backoff reconnect (2s → 5 min cap) on WS close/error.
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

/** Tokens with less than this USD liquidity are skipped — keeps out low-quality launches. */
const MIN_LIQUIDITY_USD = 5_000;

/**
 * Maximum combined pending+processing jobs allowed before discovery sheds new tokens.
 * Prevents an infinite queue from building up during Pump.fun launch spikes.
 */
const MAX_PENDING_JOBS = 50;

/**
 * How long to wait after detecting a new token before querying DexScreener.
 * DexScreener typically indexes a new Pump.fun pair within 5–15 seconds of launch.
 */
const DEXSCREENER_DELAY_MS = 12_000;

/** Base reconnect delay in ms. Doubles on each failed attempt, up to RECONNECT_MAX_MS. */
const RECONNECT_BASE_MS = 2_000;

/** Maximum reconnect wait — 5 minutes. */
const RECONNECT_MAX_MS = 5 * 60 * 1_000;

/** In-memory dedup window. Prevents re-enqueueing the same token within 10 min. */
const DEDUP_TTL_MS = 10 * 60 * 1_000;

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

// ── DexScreener ───────────────────────────────────────────────────────────────

interface DexScreenerPair {
  pairAddress?:  string;
  dexId?:        string;
  priceUsd?:     string;
  liquidity?:    { usd?: number };
  marketCap?:    number;
  quoteToken?:   { symbol?: string };
}

interface TokenPrice {
  liquidityUsd: number;
  marketCapUsd: number;
  pairAddress:  string | undefined;
}

async function fetchTokenPrice(tokenAddress: string): Promise<TokenPrice | null> {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/tokens/v1/solana/${tokenAddress}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { pairs?: DexScreenerPair[] };

    // Only use SOL-denominated pairs (same filter as the price-refresh scheduler)
    const solPairs = (json.pairs ?? []).filter(
      (p) => p.quoteToken?.symbol?.toUpperCase() === "SOL",
    );
    if (solPairs.length === 0) return null;

    const best = solPairs.sort(
      (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
    )[0];

    return {
      liquidityUsd: best.liquidity?.usd ?? 0,
      marketCapUsd: best.marketCap ?? 0,
      pairAddress:  best.pairAddress,
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

  /**
   * In-memory dedup: tracks tokens enqueued within the last DEDUP_TTL_MS.
   * Prevents a spike of identical Create events from creating multiple jobs.
   */
  private readonly recentlyEnqueued = new Map<string, number>(); // mint → timestamp

  /** Total tokens auto-enqueued since this process started. */
  private tokensEnqueued = 0;

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

    this.running = true;
    this.connect();

    console.log(
      `${LOG} Started — watching Pump.fun for new token launches. ` +
      `Filters: liquidity ≥ $${MIN_LIQUIDITY_USD.toLocaleString()} | ` +
      `max queue depth: ${MAX_PENDING_JOBS}`,
    );
  }

  /** Gracefully stop the watcher and close the WebSocket. */
  stop(): void {
    this.running = false;
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

  getStats(): { tokensEnqueued: number; running: boolean; subscriptionId: number | null } {
    return {
      tokensEnqueued:  this.tokensEnqueued,
      running:         this.running,
      subscriptionId:  this.subscriptionId,
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
    });

    this.ws.addEventListener("message", (event: MessageEvent) => {
      void this.handleMessage(event.data as string);
    });

    this.ws.addEventListener("close", (event: CloseEvent) => {
      console.warn(
        `${LOG} WebSocket closed (code ${event.code}). Scheduling reconnect…`,
      );
      this.subscriptionId = null;
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

    // Subscription confirmation
    if (typeof m.result === "number" && m.id === 1) {
      this.subscriptionId = m.result;
      console.log(
        `${LOG} Subscribed to Pump.fun program logs (sub ID: ${this.subscriptionId}).`,
      );
      return;
    }

    if (m.method !== "logsNotification") return;

    const value     = m.params?.result?.value;
    const signature = value?.signature;
    const logs      = Array.isArray(value?.logs) ? (value.logs as string[]) : [];
    const txErr     = value?.err;

    if (!signature) return;

    // Skip failed transactions
    if (txErr !== null && txErr !== undefined) return;

    // Fast pre-filter: only process "Create" instructions
    const isCreate = logs.some(
      (l) =>
        l.includes("Instruction: Create") ||
        l.includes("Program log: Instruction: Create"),
    );
    if (!isCreate) return;

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
      return;
    }

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

    // ── Step 4: Wait for DexScreener to index the new token ─────────────────
    console.log(
      `${LOG} Waiting ${DEXSCREENER_DELAY_MS / 1000}s for DexScreener ` +
      `to index ${mintAddress}…`,
    );
    await sleep(DEXSCREENER_DELAY_MS);

    // ── Step 5: Liquidity filter ─────────────────────────────────────────────
    const priceData = await fetchTokenPrice(mintAddress);

    if (!priceData) {
      console.log(
        `${LOG} No DexScreener SOL pair found for ${mintAddress} — skipping ` +
        "(token may have no liquidity or isn't indexed yet).",
      );
      return;
    }

    if (priceData.liquidityUsd < MIN_LIQUIDITY_USD) {
      console.log(
        `${LOG} ${mintAddress} below liquidity floor ` +
        `($${priceData.liquidityUsd.toFixed(0)} < $${MIN_LIQUIDITY_USD.toLocaleString()}) — skipping.`,
      );
      return;
    }

    // ── Step 6: Enqueue job ──────────────────────────────────────────────────
    const enqueued = await this.enqueueJob(
      mintAddress,
      deployer,
      priceData.marketCapUsd,
      priceData.liquidityUsd,
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
