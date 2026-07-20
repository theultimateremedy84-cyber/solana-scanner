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

import { createHash } from "crypto";
// P2-D: use the canonical service-role singleton — no local createClient call.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { PostLaunchWatcher } from "../postLaunchWatcher";

// ── Helius daily credit budget ───────────────────────────────────────────────
// Shared with PostLaunchWatcher via globalThis — both files access the same
// running counter without needing a shared module import.
// ── In-memory CU log batch ───────────────────────────────────────────────────
// Entries accumulate here and are flushed to Supabase in bulk every 60 seconds.
// Fire-and-forget: _consumeHC never awaits Supabase — the budget guard stays sync.
interface CuLogEntry {
  logged_at:     string;
  label:         string;
  component:     string;
  cu_amount:     number;
  hourly_used:   number;
  hourly_budget: number;
  daily_used:    number;
  daily_budget:  number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any;
if (!g.__cuLogBatch__) g.__cuLogBatch__ = [] as CuLogEntry[];
if (!g.__cuLogFlushing__) g.__cuLogFlushing__ = false;

function _enqueueCuLog(entry: CuLogEntry) {
  g.__cuLogBatch__.push(entry);
  // Flush immediately if batch is large; otherwise the interval handles it.
  if (g.__cuLogBatch__.length >= 50) _flushCuLog();
}

async function _flushCuLog() {
  if (g.__cuLogFlushing__ || g.__cuLogBatch__.length === 0) return;
  g.__cuLogFlushing__ = true;
  const batch: CuLogEntry[] = g.__cuLogBatch__.splice(0, g.__cuLogBatch__.length);
  try {
    const { error } = await supabaseAdmin.from("helius_cu_log").insert(batch);
    if (error) {
      // Non-fatal: put batch back so we retry next flush cycle
      console.warn("[HeliusBudget] CU log flush failed:", error.message);
      g.__cuLogBatch__.unshift(...batch);
    }
  } catch (err) {
    console.warn("[HeliusBudget] CU log flush error:", err instanceof Error ? err.message : String(err));
    g.__cuLogBatch__.unshift(...batch);
  } finally {
    g.__cuLogFlushing__ = false;
  }
}

// Start the 60-second flush interval once (survives hot-reloads via globalThis guard).
if (!g.__cuLogInterval__) {
  g.__cuLogInterval__ = setInterval(_flushCuLog, 60_000);
}

// ── Helius daily credit budget ───────────────────────────────────────────────
// Shared with PostLaunchWatcher via globalThis — both files access the same
// running counter without needing a shared module import.
function _consumeHC(cuAmount: number, label: string): boolean {
  const now = Date.now();

  // ── Daily bucket ────────────────────────────────────────────────────────────
  // FIX (P0 #5): calendar UTC day instead of rolling 24h window.
  const todayUtc = new Date().toISOString().slice(0, 10);
  if (!g.__heliusBudget__ || g.__heliusBudget__.calendarDay !== todayUtc) {
    g.__heliusBudget__ = {
      budget:      parseInt(process.env.HELIUS_DAILY_BUDGET ?? "0", 10) || 0,
      used:        0,
      calendarDay: todayUtc,
      warned:      false,
    };
  }
  const b = g.__heliusBudget__ as { budget: number; used: number; calendarDay: string; warned: boolean };

  // ── Hourly bucket ───────────────────────────────────────────────────────────
  // Resets every 60 minutes. Controlled by HELIUS_HOURLY_BUDGET env var.
  // NOTE: omitting the env var does NOT disable the cap — it falls back to a
  // conservative default of 1000 CUs/hr. To actually disable enforcement,
  // set HELIUS_HOURLY_BUDGET=0 explicitly. To raise the cap, set an explicit
  // higher number (e.g. 50000) in Railway Variables.
  if (!g.__heliusHourly__ || now - g.__heliusHourly__.window >= 3_600_000) {
    g.__heliusHourly__ = {
      budget: parseInt(process.env.HELIUS_HOURLY_BUDGET ?? "0", 10) || 0,
      used:   0,
      window: now,
      warned: false,
    };
  }
  const h = g.__heliusHourly__ as { budget: number; used: number; window: number; warned: boolean };

  // ── Hourly cap check ────────────────────────────────────────────────────────
  if (h.budget > 0 && h.used + cuAmount > h.budget) {
    if (!h.warned) {
      h.warned = true;
      const resetsIn = Math.ceil((h.window + 3_600_000 - now) / 60_000);
      console.warn(
        `[HeliusBudget] ⚠️  Hourly cap reached (${h.used}/${h.budget} CUs used this hour). ` +
        `Skipping "${label}" — resets in ~${resetsIn} min. ` +
        `Raise HELIUS_HOURLY_BUDGET in Railway Variables to increase the limit.`,
      );
    }
    return false;
  }

  // ── Daily cap check ─────────────────────────────────────────────────────────
  if (b.budget > 0 && b.used + cuAmount > b.budget) {
    if (!b.warned) {
      b.warned = true;
      console.warn(
        `[HeliusBudget] ⚠️  Daily budget exhausted (${b.used}/${b.budget} CUs used). ` +
        `Skipping "${label}" until tomorrow. ` +
        `Raise HELIUS_DAILY_BUDGET in Railway Variables to increase the limit.`,
      );
    }
    return false;
  }

  // ── Consume from both buckets ───────────────────────────────────────────────
  if (h.budget > 0) h.used += cuAmount;
  if (b.budget > 0) b.used += cuAmount;

  // ── Log to Supabase (fire-and-forget, batched) ──────────────────────────────
  // FIX (Disk IO budget incident, 2026-07-08): every raw WebSocket
  // "notification" event used to persist its own row here. Pump.fun's log
  // volume is high enough that this alone wrote ~7.8M rows to helius_cu_log
  // in 3 days (~30 rows/sec, sustained 24/7) — a firehose of continuous
  // INSERTs that exhausted the Supabase project's Disk IO budget. Almost
  // every one of those "notification" events is filtered out immediately
  // and never turns into a real Helius call, so persisting a DB row per
  // event carried no value — it was pure telemetry noise.
  //
  // Real Helius-billed calls (getAccountInfo, getTransaction) are still
  // logged individually below; they're orders of magnitude lower volume and
  // are the numbers that actually matter for the credit budget dashboard.
  // The in-memory hourly/daily budget accounting above (h.used / b.used)
  // still runs for every event regardless — only the DB write is skipped.
  const isRawNotification = label.endsWith("/notification");
  if (!isRawNotification) {
    // Extract the component prefix from the label (e.g. "TokenDiscovery" from
    // "TokenDiscovery/getTransaction") for the dashboard's stacked-bar grouping.
    const component = label.split("/")[0] ?? label;
    _enqueueCuLog({
      logged_at:     new Date().toISOString(),
      label,
      component,
      cu_amount:     cuAmount,
      hourly_used:   h.used,
      hourly_budget: h.budget,
      daily_used:    b.used,
      daily_budget:  b.budget,
    });
  }

  return true;
}

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
 * Maximum number of unenriched wallet×token pairs (hollow pairs) allowed before
 * discovery starts shedding new tokens.
 *
 * WHY THIS EXISTS:
 *   processNewToken() already checks getQueueDepth() (pending collection jobs, max 50),
 *   but that only guards the COLLECTION stage. Each collection job produces ~50–150
 *   hollow wallet×token pairs that queue up for the Helius enrichment scheduler.
 *   Discovery has no visibility into the enrichment backlog, so it can keep accepting
 *   new tokens when enrichment is already weeks behind — which is exactly how the
 *   90,000-pair backlog of July 2026 accumulated.
 *
 *   This check adds a second gate: if the enrichment scheduler is already sitting on
 *   more hollow pairs than it can clear in a reasonable time, incoming tokens are shed
 *   before spending any Helius CUs on them. Discovery resumes automatically once the
 *   enrichment backlog drains below the threshold.
 *
 * TUNING:
 *   At ~20 CU/wallet and HELIUS_HOURLY_BUDGET=10000 (minus ~3000 for WS notifications),
 *   the enrichment scheduler clears ~350 wallets/hour. A threshold of 5000 means at
 *   most ~14 hours of enrichment queued at any time — conservative enough to prevent
 *   runaway backlogs while permitting normal burst collection.
 *
 *   Override via HOLLOW_BACKPRESSURE_LIMIT in Railway Variables.
 *   Set to 0 to disable the check entirely (not recommended).
 */
const MAX_HOLLOW_PAIRS = parseInt(process.env.HOLLOW_BACKPRESSURE_LIMIT ?? "5000", 10) || 5000;

/**
 * How long to wait after detecting a new token before reading its bonding curve.
 * 10 seconds gives enough time for initial buys to confirm on-chain.
 */
const PRICE_CHECK_DELAY_MS = 20_000;

/** Base reconnect delay in ms. Doubles on each failed attempt, up to RECONNECT_MAX_MS. */
const RECONNECT_BASE_MS = 2_000;

/** Maximum reconnect wait — 30 seconds (reduced from 5 min so dead WS recovers fast). */
const RECONNECT_MAX_MS = 30_000;

/**
 * FIX (connect-hang bug): how long to wait for the WebSocket to leave
 * CONNECTING before giving up and forcing a reconnect. A normal Helius
 * handshake completes in well under a second; 15s is generous headroom
 * while still recovering quickly from a hung socket.
 */
const CONNECT_TIMEOUT_MS = 15_000;

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
// P2-D: use the canonical service-role singleton from client.server.ts.
// Returns null (instead of throwing) so callers can log and skip gracefully
// when env vars are missing at startup — the singleton itself throws on first
// property access, which we catch here.

function buildSupabase() {
  try {
    // Force a property access so the lazy Proxy triggers createSupabaseAdminClient()
    // now — that function throws if SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are
    // missing. Without this access the Proxy object itself is returned without
    // throwing, and the error surfaces later (scattered across call sites).
    void (supabaseAdmin as unknown as { from: unknown }).from;
    return supabaseAdmin;
  } catch {
    return null;
  }
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

// ── Deterministic bonding curve PDA derivation ────────────────────────────────
//
// Derives the Pump.fun bonding curve PDA from the mint address using the same
// seeds the on-chain program uses: ["bonding-curve", mintBytes].
//
// This is more reliable than extracting accounts[N] from a parsed transaction
// because it is immune to Pump.fun instruction layout changes. The algorithm:
//   1. SHA256(seed | mint | nonce | programId | "ProgramDerivedAddress")
//   2. Nonce decrements 255→0 until the hash is NOT a valid ed25519 point.
//
// "Not on curve" check uses Euler's criterion on the ed25519 curve equation
// −x² + y² = 1 + d·x²·y² (mod p). No external dependencies — pure Node.js crypto.

const _ED_P = (1n << 255n) - 19n;
const _ED_D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;

function _modpow(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n; b = ((b % m) + m) % m;
  for (; e > 0n; e >>= 1n) { if (e & 1n) r = r * b % m; b = b * b % m; }
  return r;
}

/** Returns true if the 32-byte buffer is a valid ed25519 curve point. */
function _isOnCurve(h: Buffer): boolean {
  const y = (() => {
    const arr = Buffer.from(h); arr[31] &= 0x7f;
    let v = 0n; for (let i = 0; i < 32; i++) v |= BigInt(arr[i]) << BigInt(8 * i);
    return v;
  })();
  if (y >= _ED_P) return false;
  const y2 = y * y % _ED_P;
  const u  = (y2 - 1n + _ED_P) % _ED_P;
  const v  = (_ED_D * y2 % _ED_P + 1n) % _ED_P;
  if (v === 0n) return u === 0n;
  const uv = u * _modpow(v, _ED_P - 2n, _ED_P) % _ED_P;
  if (uv === 0n) return true;
  return _modpow(uv, (_ED_P - 1n) / 2n, _ED_P) === 1n;
}

const _B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const _B58MAP: Record<string, number> = Object.fromEntries(_B58.split("").map((c, i) => [c, i]));

function _b58decode(s: string): Buffer {
  let n = 0n;
  for (const c of s) { const d = _B58MAP[c]; if (d === undefined) throw new Error(`bad b58: ${c}`); n = n * 58n + BigInt(d); }
  let z = 0; for (const c of s) { if (c !== "1") break; z++; }
  const out: number[] = []; while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n; }
  return Buffer.from([...new Array(z).fill(0), ...out]);
}

function _b58encode(buf: Buffer): string {
  let n = 0n; for (const b of buf) n = n * 256n + BigInt(b);
  let s = ""; while (n > 0n) { s = _B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b !== 0) break; s = "1" + s; }
  return s;
}

/**
 * Deterministically derive the Pump.fun bonding curve PDA for a given mint.
 * Seeds: ["bonding-curve", mintPublicKeyBytes], program: PUMPFUN_PROGRAM_ID.
 * Returns null only if base58 decoding fails (should never happen with a valid mint).
 */
function deriveBondingCurvePDA(mintAddress: string): string | null {
  try {
    const mint      = _b58decode(mintAddress);
    const programId = _b58decode(PUMPFUN_PROGRAM_ID);
    const seed      = Buffer.from("bonding-curve");
    for (let nonce = 255; nonce >= 0; nonce--) {
      const h = createHash("sha256").update(
        Buffer.concat([seed, mint, Buffer.from([nonce]), programId, Buffer.from("ProgramDerivedAddress")]),
      ).digest();
      if (!_isOnCurve(h)) return _b58encode(h);
    }
    return null; // astronomically unlikely
  } catch {
    return null;
  }
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
// ── Diagnostic counters for fetchBondingCurveData failures ──────────────────
// Exposed via getStats() so /api/discovery-status shows split failure reasons.
const bcDiag = {
  accountNotFound: 0, // getAccountInfo returned value:null (address wrong or not yet created)
  tooSmall:        0, // buf.length < 49
  sanityCap:       0, // realSolReserves > MAX_BC_LAMPORTS
  rpcError:        0, // heliusRpc threw (rate limit, network, invalid key)
};

async function fetchBondingCurveData(
  bondingCurveAddress: string,
  heliusApiKey: string,
): Promise<BondingCurveData | null> {
  // Retry up to 2 attempts with 8-second gaps (reduced from 3 to save credits).
  // The bonding curve account is almost always confirmed by the time we reach
  // this call (after PRICE_CHECK_DELAY_MS). A third retry rarely succeeds and
  // costs 1 additional credit per token on the free tier.
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (!_consumeHC(1, "TokenDiscovery/getAccountInfo")) return null;
    try {
      const result = await heliusRpc<{
        value?: { data?: [string, string] } | null;
      }>(heliusApiKey, "getAccountInfo", [
        bondingCurveAddress,
        { encoding: "base64" },
      ]);

      const b64 = result.value?.data?.[0];
      if (!b64) {
        if (attempt < 2) {
          await sleep(8_000);
          continue;
        }
        bcDiag.accountNotFound++;
        console.warn(
          `[TokenDiscovery] fetchBondingCurveData: account NOT FOUND at ${bondingCurveAddress.slice(0,8)}… after 2 attempts`,
        );
        return null;
      }

      const buf = Buffer.from(b64, "base64");
      // Need at least 8 (discriminator) + 5 × 8 (u64 fields) + 1 (bool) = 49 bytes
      if (buf.length < 49) {
        bcDiag.tooSmall++;
        console.warn(
          `[TokenDiscovery] fetchBondingCurveData: account TOO SMALL (${buf.length} bytes) at ${bondingCurveAddress.slice(0,8)}…`,
        );
        return null;
      }

      const virtualTokenReserves = buf.readBigUInt64LE(8);
      const virtualSolReserves   = buf.readBigUInt64LE(16);
      // realTokenReserves at offset 24 — not needed for our filter
      const realSolReserves      = buf.readBigUInt64LE(32);
      const tokenTotalSupply     = buf.readBigUInt64LE(40);
      const complete             = buf[48] === 1;

      // Sanity check: Pump.fun bonding curve caps at ~85 SOL before graduating.
      // If realSolReserves > 100 SOL we have the wrong account type.
      const MAX_BC_LAMPORTS = BigInt(100_000_000_000); // 100 SOL
      if (realSolReserves > MAX_BC_LAMPORTS) {
        bcDiag.sanityCap++;
        console.warn(
          `[TokenDiscovery] fetchBondingCurveData: SANITY CAP triggered — ` +
          `realSol=${Number(realSolReserves)/1e9}SOL at ${bondingCurveAddress.slice(0,8)}… ` +
          `(wrong account type)`,
        );
        return null;
      }

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
    } catch (err) {
      if (attempt < 2) {
        await sleep(8_000);
        continue;
      }
      bcDiag.rpcError++;
      console.error(
        `[TokenDiscovery] fetchBondingCurveData: RPC ERROR for ${bondingCurveAddress.slice(0,8)}…:`,
        err,
      );
      return null;
    }
  }
  return null; // exhausted all attempts
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
 * Pump.fun Create instruction account layout (Anchor IDL, confirmed):
 *   [0] mint                    ← the new token
 *   [1] mintAuthority           ← fixed program PDA (NOT the bonding curve)
 *   [2] bondingCurve            ← this is what we want
 *   [3] associatedBondingCurve
 *   [4] global
 *   ...
 *
 * NOTE: deriveBondingCurvePDA() is preferred over this function — it derives
 * the address deterministically from the mint and is immune to layout changes.
 * This function is kept as a fallback only.
 *
 * Returns null if the instruction cannot be found or has fewer than 3 accounts.
 */
function extractBondingCurve(tx: unknown): string | null {
  try {
    const t = tx as {
      transaction?: {
        message?: {
          accountKeys?: Array<string | { pubkey?: string }>;
          instructions?: Array<{
            programId?: string;
            accounts?:  unknown[];
          }>;
        };
      };
      meta?: {
        innerInstructions?: Array<{
          instructions?: Array<{ programId?: string; accounts?: unknown[] }>;
        }>;
      };
    };

    // Helper: resolve an accounts entry to a pubkey string.
    // In jsonParsed format, outer instructions contain pubkey strings;
    // inner instructions may contain account-key INDICES (numbers).
    // We accept only full-length base58 strings (>20 chars) to avoid
    // returning a stringified integer when accounts are index-format.
    const resolve = (
      candidate: unknown,
    ): string | null => {
      if (typeof candidate === "string" && candidate.length > 20) return candidate;
      // If it's a number (account index), look it up in accountKeys
      if (typeof candidate === "number") {
        const keys = t.transaction?.message?.accountKeys ?? [];
        const key  = keys[candidate];
        if (!key) return null;
        return typeof key === "string" ? key : (key.pubkey ?? null);
      }
      return null;
    };

    // Outer instructions first — bondingCurve is at accounts[2] per Pump.fun IDL
    for (const ix of t.transaction?.message?.instructions ?? []) {
      if (ix.programId === PUMPFUN_PROGRAM_ID && (ix.accounts?.length ?? 0) >= 3) {
        return resolve(ix.accounts![2]);
      }
    }

    // Inner instructions fallback
    for (const group of t.meta?.innerInstructions ?? []) {
      for (const ix of group.instructions ?? []) {
        if (ix.programId === PUMPFUN_PROGRAM_ID && (ix.accounts?.length ?? 0) >= 3) {
          return resolve(ix.accounts![2]);
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

  // FIX (connect-hang bug): guards against a WebSocket that never leaves
  // CONNECTING. If the TCP/TLS handshake to Helius hangs — e.g. Helius's load
  // balancer still holds a half-open socket from the previous (killed) process
  // after a Railway restart — neither 'open' nor 'close'/'error' ever fire, so
  // the heartbeat never starts and scheduleReconnect() is never called. The
  // connection is then frozen forever with wsReadyState=CONNECTING. This timer
  // force-recycles the socket if it hasn't opened within CONNECT_TIMEOUT_MS.
  private connectTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

  // Heartbeat state — detects silent WS drops from cloud load balancers
  private heartbeatHandle:  ReturnType<typeof setInterval> | null = null;
  private heartbeatPending: ReturnType<typeof setTimeout>  | null = null;
  private lastMessageAt:    number | null                         = null;

  // Diagnostic fields — exposed via getStats() → /api/discovery-status
  /** Whether `WebSocket` is available as a global at class-init time. */
  private readonly wsGlobalAvailable: boolean =
    typeof (globalThis as unknown as Record<string, unknown>)["WebSocket"] !== "undefined";
  /** Close code from the most recent WebSocket close event (null = no close yet). */
  private lastCloseCode:   number | null = null;
  /** Close reason string from the most recent close event. */
  private lastCloseReason: string        = "";
  /** Stringified error from the most recent WebSocket error event. */
  private lastWsError:     string        = "";
  /** How many reconnect attempts have been made this session. */
  private totalReconnects: number        = 0;

  /**
   * In-memory dedup: tracks tokens enqueued within the last DEDUP_TTL_MS.
   * Prevents a spike of identical Create events from creating multiple jobs.
   */
  private readonly recentlyEnqueued = new Map<string, number>(); // mint → timestamp

  /**
   * When > Date.now() the discovery feed is paused for budget reasons.
   * scheduleReconnect() returns early while this is set so the WebSocket is
   * NOT reopened (which would resume Helius billing).
   */
  private budgetPausedUntilMs = 0;

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
    const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
    if (!sbUrl || !sbKey) {
      console.error(
        `${LOG} Supabase credentials missing (SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set). ` +
        "Discovery can detect tokens but cannot write wallet_collection_jobs. " +
        "Set both variables in Railway → Variables.",
      );
    }

    this.running = true;

    // Diagnostic: confirm WebSocket global is available in this runtime
    const wsType = typeof (globalThis as unknown as Record<string, unknown>)["WebSocket"];
    console.log(
      `${LOG} Runtime WebSocket global: typeof WebSocket = "${wsType}" ` +
      `(expected "function"; "undefined" means polyfill needed)`,
    );

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
    this.clearConnectTimeout();
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

  /** Clears the connect-hang guard timer, if one is pending. */
  private clearConnectTimeout(): void {
    if (this.connectTimeoutHandle !== null) {
      clearTimeout(this.connectTimeoutHandle);
      this.connectTimeoutHandle = null;
    }
  }

  getStats(): {
    tokensEnqueued:    number;
    running:           boolean;
    subscriptionId:    number | null;
    wsAlive:           boolean;
    lastMessageAt:     string | null;
    wsGlobalAvailable: boolean;
    lastCloseCode:     number | null;
    lastCloseReason:   string;
    lastWsError:       string;
    totalReconnects:   number;
    wsReadyState:      number | null;
    pipeline: {
      messagesReceived:  number;
      createEventsFound: number;
      mintsExtracted:    number;
      dexScreenerHit:    number;
      liquidityPassed:   number;
      tokensEnqueued:    number;
      bcDiag: {
        accountNotFound: number;
        tooSmall:        number;
        sanityCap:       number;
        rpcError:        number;
      };
    };
  } {
    const ws = this.ws;
    const readyState = ws !== null ? ws.readyState : null;
    return {
      tokensEnqueued:    this.tokensEnqueued,
      running:           this.running,
      subscriptionId:    this.subscriptionId,
      wsAlive:           ws !== null && readyState === WebSocket.OPEN,
      lastMessageAt:     this.lastMessageAt ? new Date(this.lastMessageAt).toISOString() : null,
      wsGlobalAvailable: this.wsGlobalAvailable,
      lastCloseCode:     this.lastCloseCode,
      lastCloseReason:   this.lastCloseReason,
      lastWsError:       this.lastWsError,
      totalReconnects:   this.totalReconnects,
      wsReadyState:      readyState,
      pipeline: {
        messagesReceived:  this.messagesReceived,
        createEventsFound: this.createEventsFound,
        mintsExtracted:    this.mintsExtracted,
        dexScreenerHit:    this.dexScreenerHit,
        liquidityPassed:   this.liquidityPassed,
        tokensEnqueued:    this.tokensEnqueued,
        bcDiag: { ...bcDiag },
      },
    };
  }

  // ── WebSocket lifecycle ─────────────────────────────────────────────────────

  private connect(): void {
    if (!this.running) return;

    const apiKey = process.env.HELIUS_API_KEY ?? "";
    // Standard Helius WebSocket endpoint — supported on all plan tiers including free.
    // atlas-mainnet.helius-rpc.com is a Geyser/Atlas premium endpoint (paid plans only)
    // and returns HTTP 1002 on the free tier. mainnet.helius-rpc.com supports
    // logsSubscribe on the free tier with 1M credits/month.
    const wssUrl = `wss://mainnet.helius-rpc.com/?api-key=${apiKey}`;

    try {
      this.ws = new WebSocket(wssUrl);
    } catch (err) {
      console.error(`${LOG} WebSocket constructor threw:`, err);
      this.scheduleReconnect();
      return;
    }

    // FIX (connect-hang bug): if the handshake never completes (no 'open',
    // no 'close', no 'error'), this timer force-closes the zombie socket and
    // schedules a reconnect so discovery can never get permanently stuck in
    // CONNECTING after a restart.
    this.clearConnectTimeout();
    this.connectTimeoutHandle = setTimeout(() => {
      this.connectTimeoutHandle = null;
      if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
        console.warn(
          `${LOG} WebSocket connect timeout — still CONNECTING after ` +
          `${CONNECT_TIMEOUT_MS / 1000}s. Forcing reconnect…`,
        );
        try { this.ws.close(); } catch { /* ignore */ }
        this.ws = null;
        this.scheduleReconnect();
      }
    }, CONNECT_TIMEOUT_MS);

    this.ws.addEventListener("open", () => {
      this.clearConnectTimeout();
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
      this.clearConnectTimeout();
      this.lastCloseCode   = event.code ?? null;
      this.lastCloseReason = event.reason ?? "";
      console.warn(
        `${LOG} WebSocket closed — code=${event.code} reason="${event.reason}". Scheduling reconnect…`,
      );
      this.subscriptionId = null;
      this.stopHeartbeat();
      this.scheduleReconnect();
    });

    this.ws.addEventListener("error", (event: Event) => {
      const msg =
        (event as unknown as { message?: string }).message ??
        event.type ??
        "unknown error";
      this.lastWsError = msg;
      console.error(`${LOG} WebSocket error: type=${event.type} message=${msg}`);
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

  /**
   * Close the WebSocket and pause the Pump.fun subscription until the hourly
   * Helius credit window resets. Called when _consumeHC returns false on a
   * logsNotification — the WebSocket is still OPEN at that point and Helius
   * continues to DELIVER (and BILL) every subsequent notification unless we
   * close the connection explicitly.
   */
  private _pauseForBudget(): void {
    if (Date.now() < this.budgetPausedUntilMs) return; // already paused

    const g = globalThis as any;
    const h = g.__heliusHourly__;
    const resetsIn = h
      ? Math.max(0, (h.window + 3_600_000) - Date.now())
      : 3_600_000;
    const resumeAt = Date.now() + resetsIn + 10_000;
    this.budgetPausedUntilMs = resumeAt;

    console.warn(
      `${LOG} ⛔ Hourly budget exhausted — closing Pump.fun WebSocket to stop Helius billing. ` +
      `Will reconnect at ${new Date(resumeAt).toISOString()} (~${Math.ceil(resetsIn / 60_000)} min). ` +
      `Set HELIUS_HOURLY_BUDGET in Railway Variables to raise the cap.`,
    );

    this.stopHeartbeat();
    if (this.reconnectHandle !== null) {
      clearTimeout(this.reconnectHandle);
      this.reconnectHandle = null;
    }
    try { this.ws?.close(); } catch { /* ignore */ }
    // ws.close() fires 'close' → scheduleReconnect() → sees budgetPausedUntilMs → returns early.

    setTimeout(() => {
      this.budgetPausedUntilMs = 0;
      if (!this.running) return;
      this.reconnectAttempts = 0;
      console.log(`${LOG} Hourly budget window reset — reconnecting to Pump.fun WebSocket.`);
      this.connect();
    }, resetsIn + 10_000);
  }

  private scheduleReconnect(): void {
    if (!this.running) return;

    // Budget pause in effect — _pauseForBudget() has already scheduled a
    // delayed restart. Reconnecting now would reopen the WebSocket and resume
    // Helius billing before the hourly window resets.
    if (Date.now() < this.budgetPausedUntilMs) return;

    this.reconnectAttempts++;
    this.totalReconnects++;
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

    // CRITICAL budget guard: every Pump.fun logsNotification costs 1 CU on
    // Helius regardless of whether we call any HTTP RPC afterwards. The
    // subscription sees ALL Pump.fun program transactions — thousands per hour
    // — so notifications alone can exhaust the hourly budget.
    //
    // When the budget is exhausted we must CLOSE the WebSocket. Returning here
    // without closing it means Helius keeps delivering (and billing) every
    // subsequent notification. _pauseForBudget() sends no further messages and
    // closes the connection so billing stops until the window resets.
    if (!_consumeHC(1, "TokenDiscovery/notification")) {
      this._pauseForBudget();
      return;
    }

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

    // ── Step 0: Queue depth + enrichment backpressure pre-check ──────────────
    // Both checks run in parallel — no point spending 10 CUs on getTransaction
    // if we're going to shed the token anyway.
    //
    // getQueueDepth()    — guards the COLLECTION stage (pending jobs ≤ 50)
    // getHollowPairsCount() — guards the ENRICHMENT stage (hollow pairs ≤ MAX_HOLLOW_PAIRS)
    //   Without the second check, discovery can keep enqueuing tokens while the
    //   enrichment backlog grows unboundedly — the root cause of the July 2026
    //   90k-pair backlog (see MAX_HOLLOW_PAIRS comment for full explanation).
    const [depth, hollowCount] = await Promise.all([
      this.getQueueDepth(),
      this.getHollowPairsCount(),
    ]);

    if (depth >= MAX_PENDING_JOBS) {
      console.warn(
        `${LOG} Collection queue at capacity (${depth}/${MAX_PENDING_JOBS} pending) — ` +
        `skipping getTransaction for sig ${signature.slice(0, 8)}…`,
      );
      return;
    }

    if (MAX_HOLLOW_PAIRS > 0 && hollowCount >= MAX_HOLLOW_PAIRS) {
      console.warn(
        `${LOG} Enrichment backlog at capacity (${hollowCount}/${MAX_HOLLOW_PAIRS} hollow pairs) — ` +
        `shedding token sig ${signature.slice(0, 8)}… until enrichment catches up. ` +
        `Raise HOLLOW_BACKPRESSURE_LIMIT or HELIUS_HOURLY_BUDGET to increase throughput.`,
      );
      return;
    }

    // ── Step 1: Fetch transaction to extract mint + deployer ─────────────────
    if (!_consumeHC(10, "TokenDiscovery/getTransaction")) return;
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

    // ── Step 3: Queue depth already checked above (step 0) ───────────────────
    // Re-use the depth value from step 0 — the queue may have grown slightly in
    // the time it took to fetch the tx, but a second check is not worth the
    // extra Supabase round-trip. The DB unique-index guard prevents true dupes.

    // ── Step 4: Resolve bonding curve address ─────────────────────────────────
    // Primary: derive PDA deterministically from the mint (immune to Pump.fun
    //          instruction layout changes — works regardless of accounts[] order).
    // Fallback: extract from transaction accounts[2] (kept for observability).
    const bcFromPDA = deriveBondingCurvePDA(mintAddress);
    const bcFromTx  = extractBondingCurve(tx);
    const bondingCurve = bcFromPDA ?? bcFromTx;

    if (bcFromPDA && bcFromTx && bcFromPDA !== bcFromTx) {
      console.warn(
        `${LOG} PDA vs tx address MISMATCH for ${mintAddress}: ` +
        `pda=${bcFromPDA.slice(0, 8)}… tx=${bcFromTx.slice(0, 8)}… — using PDA`,
      );
    }

    console.log(
      `${LOG} Waiting ${PRICE_CHECK_DELAY_MS / 1000}s then reading bonding curve ` +
      `for ${mintAddress}` +
      (bondingCurve ? ` (bc: ${bondingCurve.slice(0, 8)}… via ${bcFromPDA ? "PDA-derive" : "tx-extract"})` : " (bonding curve address unavailable)") + "…",
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
        (bondingCurve ? ` (bc: ${bondingCurve.slice(0, 8)}…)` : " (address unavailable)"),
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
    // FIX: pass bondingCurve as poolAddress so wallet-collection-worker can
    // run Steps 1-2 (pool transaction scan for buyers AND sellers).
    // Previously bondingCurve was derived and used for the liquidity check but
    // never forwarded → pool_address = null on 99% of jobs → sellers_collected = 0.
    const enqueued = await this.enqueueJob(
      mintAddress,
      deployer,
      bcData.marketCapUsd,
      bcData.liquidityUsd,
      bondingCurve ?? null,
    );

    if (enqueued) {
      this.tokensEnqueued++;
      this.recentlyEnqueued.set(mintAddress, Date.now());
      this.pruneDedup();

      // Auto-seed scan_history so the token's developer_wallet is indexed for
      // graduation-rate tracking (plan Tasks A10 + A12). Fire-and-forget — a
      // failure here must never block or slow the discovery pipeline.
      //
      // WHY: scan_history is normally written only when a USER manually scans
      // a token via the scanner UI. The discovery pipeline processes thousands
      // of tokens automatically but never wrote to scan_history, leaving the
      // developer_wallet column empty for all pipeline-discovered tokens and
      // making developer graduation rate calculations impossible.
      //
      // Only record when deployer is known — a null developer_wallet row
      // adds no value for A10/A12 (those queries filter on developer_wallet).
      // The backfill migration (20260716000002) handles historical tokens;
      // this call covers new discoveries going forward.
      if (deployer && bcData) {
        void this.recordDiscoveredToken(mintAddress, deployer, bcData).catch((err) => {
          console.warn(
            `${LOG} recordDiscoveredToken failed for ${mintAddress.slice(0, 8)}…:`,
            err instanceof Error ? err.message : String(err),
          );
        });
      }

      // Immediately register this mint with PostLaunchWatcher so security
      // monitoring begins before the cron picks up the job and runs the full
      // scan. This satisfies the "auto-subscribe when P2-A discovers a token"
      // requirement without waiting for scan_history to be populated.
      try {
        PostLaunchWatcher.getInstance().trackMint(mintAddress);
      } catch {
        // PostLaunchWatcher may not be running (e.g. missing HELIUS_API_KEY).
        // Swallow silently — the periodic loadTrackedMints refresh is the
        // fallback and will pick this mint up within 5 minutes.
      }
    }
  }

  // ── scan_history auto-seeding ───────────────────────────────────────────────

  /**
   * Call the RugCheck API to compute a real risk score for a discovered token.
   *
   * FIX (audit Fix #1 — discovery risk scoring):
   *   Before this fix, recordDiscoveredToken() hardcoded risk_score=0 /
   *   risk_level="LOW" for every pipeline-discovered token, meaning 100% of
   *   the 7,574 auto-discovered scan_history rows carried a blind "safe" rating.
   *   Risk scoring only fired for manual scans (user-submitted payloads from
   *   the browser scanner). The discovery pipeline is higher-volume and more
   *   important — it processes every Pump.fun launch — and it was completely
   *   blind to rug/honeypot signals.
   *
   * RugCheck API: https://api.rugcheck.xyz/v1/tokens/{mint}/report/summary
   *   Returns: { score: 0-100 (higher = riskier), risks: [...] }
   *   No API key required for summary endpoint.
   *   Times out at 8 s. On any error → falls back to score=0 / level="UNKNOWN"
   *   so a network hiccup never blocks the discovery insert.
   *
   * Risk level mapping (matches browser scanner convention):
   *   0-29   → LOW      (appears safe)
   *   30-59  → MEDIUM   (some risk signals)
   *   60-79  → HIGH     (significant risk)
   *   80-100 → CRITICAL (likely rug / honeypot)
   */
  private async scoreDiscoveredToken(mintAddress: string): Promise<{
    risk_score:       number;
    risk_level:       "LOW" | "MEDIUM" | "HIGH" | "EXTREME" | "UNKNOWN";
    honey_pot_status: string;
  }> {
    const FALLBACK = { risk_score: 0, risk_level: "UNKNOWN" as const, honey_pot_status: "UNKNOWN" };
    try {
      const res = await fetch(
        `https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report/summary`,
        { signal: AbortSignal.timeout(8_000) },
      );
      if (!res.ok) {
        console.warn(`${LOG} RugCheck API ${res.status} for ${mintAddress.slice(0, 8)}… — using fallback`);
        return FALLBACK;
      }
      const json = await res.json() as {
        score?: number;
        risks?: Array<{ name?: string; level?: string }>;
      };

      const score = typeof json.score === "number" ? Math.round(json.score) : 0;

      // FIX (P0 #4): "CRITICAL" violates scan_history CHECK constraint — use "EXTREME".
      let risk_level: "LOW" | "MEDIUM" | "HIGH" | "EXTREME" = "LOW";
      if (score >= 80) risk_level = "EXTREME";
      else if (score >= 60) risk_level = "HIGH";
      else if (score >= 30) risk_level = "MEDIUM";

      // Detect honeypot signals in risks array
      // FIX (P0 #4): "HONEYPOT" violates honey_pot_status enum — use "CONFIRMED HONEYPOT".
      const risks = json.risks ?? [];
      const isHoneypot = risks.some(
        (r) =>
          r.name?.toLowerCase().includes("honeypot") ||
          r.level?.toLowerCase() === "danger" && r.name?.toLowerCase().includes("sell"),
      );
      const honey_pot_status = isHoneypot ? "CONFIRMED HONEYPOT" : "SAFE";

      console.log(
        `${LOG} RugCheck ${mintAddress.slice(0, 8)}… → score=${score} level=${risk_level} honeypot=${isHoneypot}`,
      );
      return { risk_score: score, risk_level, honey_pot_status };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`${LOG} RugCheck fetch failed for ${mintAddress.slice(0, 8)}… (${msg}) — using fallback`);
      return FALLBACK;
    }
  }


  /**
   * Fetches token name and symbol from the Pump.fun frontend API.
   *
   * Called in parallel with scoreDiscoveredToken() inside recordDiscoveredToken()
   * so metadata is available when the scan_history row is inserted.
   *
   * Falls back to { name: null, symbol: null } on any network or parse error —
   * the scan_history row is still inserted; the UI shows "pending" until a
   * later enrichment pass backfills the name/symbol.
   */
  private async fetchTokenMetadata(mintAddress: string): Promise<{
    name:             string | null;
    symbol:           string | null;
    createdTimestamp: number | null;  // Unix seconds — token's on-chain creation time
  }> {
    const FALLBACK = { name: null, symbol: null, createdTimestamp: null };
    try {
      const res = await fetch(
        `https://frontend-api.pump.fun/coins/${mintAddress}`,
        { signal: AbortSignal.timeout(6_000) },
      );
      if (!res.ok) return FALLBACK;
      const json = await res.json() as {
        name?:              string;
        symbol?:            string;
        created_timestamp?: number;  // Unix seconds from Pump.fun API
      };
      return {
        name:   typeof json.name   === "string" && json.name   ? json.name   : null,
        symbol: typeof json.symbol === "string" && json.symbol ? json.symbol : null,
        // Pump.fun returns created_timestamp as Unix seconds (e.g. 1718123456).
        // Validate it's a reasonable timestamp (after 2024-01-01 = 1704067200)
        // to avoid persisting 0 or garbage values.
        createdTimestamp:
          typeof json.created_timestamp === "number" &&
          json.created_timestamp > 1_704_067_200
            ? json.created_timestamp
            : null,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`${LOG} fetchTokenMetadata failed for ${mintAddress.slice(0, 8)}… (${msg}) — using fallback`);
      return FALLBACK;
    }
  }

  /**
   * Insert a minimal scan_history row for a pipeline-discovered token so its
   * developer_wallet and risk_score are indexed for graduation-rate tracking
   * and leaderboard quality gates.
   *
   * Uses supabaseAdmin directly (bypasses the HTTP handler) because we have
   * validated on-chain data. The usual scan-history-handler.ts validation is
   * for untrusted browser-submitted risk payloads, not internal pipeline writes.
   *
   * Idempotent: the partial unique index scan_history_discovery_token_unique
   * (WHERE source = 'discovery') prevents duplicate entries per token.
   * Silently ignores duplicate-key violations.
   *
   * PREREQUISITE: migration 20260716000001 must be applied first (adds the
   * `source` column). If the column is missing, the insert will fail with a
   * "column source does not exist" error, which is caught and logged here —
   * it does not affect the discovery pipeline.
   */
  private async recordDiscoveredToken(
    mintAddress: string,
    deployer:    string,
    bcData:      BondingCurveData,
  ): Promise<void> {
    const sb = buildSupabase();
    if (!sb) return;

    // Run RugCheck risk scoring and DexScreener metadata fetch in parallel.
    // Both are non-blocking — errors fall back to null/defaults.
    const [riskResult, metaResult] = await Promise.all([
      this.scoreDiscoveredToken(mintAddress),
      this.fetchTokenMetadata(mintAddress),
    ]);

    const { risk_score, risk_level, honey_pot_status } = riskResult;

    const { error } = await sb.from("scan_history").insert({
      token_address:     mintAddress,
      risk_score,
      risk_level,
      honey_pot_status,
      developer_wallet:  deployer,
      token_name:        metaResult.name,
      token_symbol:      metaResult.symbol,
      market_cap:        bcData.marketCapUsd > 0 ? Math.round(bcData.marketCapUsd) : null,
      liquidity:         bcData.liquidityUsd  > 0 ? Math.round(bcData.liquidityUsd)  : null,
      source:            "discovery",
      token_created_at:  metaResult.createdTimestamp ?? null,
      // needs_rescore defaults to TRUE via migration 20260716000012
    });

    if (error) {
      if (error.code === "23505" || error.message.includes("duplicate key")) return;
      console.warn(
        `${LOG} scan_history insert failed for ${mintAddress.slice(0, 8)}…: ${error.message}`,
      );
    } else {
      console.log(
        `${LOG} ✓ scan_history seeded — ` +
        `token=${mintAddress.slice(0, 8)}… ` +
        `name=${metaResult.name ?? "pending"} ` +
        `deployer=${deployer.slice(0, 8)}… ` +
        `risk=${risk_score}(${risk_level})`,
      );
    }

    // Back-fill token_created_at on the wallet_collection_jobs row that was
    // just inserted by enqueueJob(). enqueueJob() runs first (before this
    // fire-and-forget call) so the job row exists by the time we reach here.
    // Fire-and-forget — a failure here never blocks the discovery pipeline.
    if (metaResult.createdTimestamp != null) {
      void sb
        .from("wallet_collection_jobs")
        .update({ token_created_at: metaResult.createdTimestamp })
        .eq("token_address", mintAddress)
        .in("status", ["pending", "processing"])
        .then(({ error: updErr }) => {
          if (updErr) {
            console.warn(
              `${LOG} token_created_at back-fill failed for ${mintAddress.slice(0, 8)}…: ${updErr.message}`,
            );
          }
        });
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

  /**
   * Returns the current count of hollow wallet×token pairs (WPH rows missing a
   * helius_full_history WRM entry) via the count_hollow_pairs Postgres RPC.
   *
   * Result is cached for 60 seconds so a burst of Create events in the same
   * minute doesn't fire a Supabase RPC for every one.  The cache is intentionally
   * conservative — the hollow count only decreases (enrichment runs) or increases
   * by ≤WALLETS_PER_TOKEN-sized steps (a collection job completing), so a 60-second
   * stale read can never cause a meaningfully wrong backpressure decision.
   */
  private hollowPairsCache: { value: number; expiresAt: number } | null = null;

  private async getHollowPairsCount(): Promise<number> {
    const now = Date.now();
    if (this.hollowPairsCache && now < this.hollowPairsCache.expiresAt) {
      return this.hollowPairsCache.value;
    }
    const sb = buildSupabase();
    if (!sb) return 0;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (sb as any).rpc("count_hollow_pairs").single();
      if (error || data === null) return 0;
      const value = Number(data);
      this.hollowPairsCache = { value, expiresAt: now + 60_000 };
      return value;
    } catch {
      return 0;
    }
  }

  private async enqueueJob(
    tokenAddress: string,
    deployer:     string | null,
    marketCapUsd: number,
    liquidityUsd: number,
    poolAddress:  string | null = null,
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
          pool_address:   poolAddress ?? null,
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
