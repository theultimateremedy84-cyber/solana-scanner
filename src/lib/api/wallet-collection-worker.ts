// =============================================================================
// Wallet Collection Worker  (v11 — audit remediation)
//
// FIXES vs v10:
//
//   ROI-02 — Peak ROI zero-suppression bug:
//     The old expression `Math.max(a ?? 0, b ?? 0) || null` converts an exact
//     0× ROI to null (0 is falsy). Fixed to: if either input is non-null, store
//     the numeric max (including 0); only store null when both inputs are null.
//
//   ROI-03 — Milestone timestamps overwrite on every scan:
//     persistPerformanceHistory now fetches existing milestone timestamps
//     alongside existing peaks in a single batch query. milestoneTs() preserves
//     the first-recorded timestamp and only writes a new one when the column
//     was previously null. Identical to the immutable logic already used in
//     wallet-enricher.ts / upsertPerformanceRow().
//
//   DB-03 — total_tokens_traded always hardcoded to 1:
//     Removed from the bulk upsert payload. A follow-up call to the Postgres
//     function refresh_wallet_token_counts() (added in migration
//     20260627000001) sets the correct count from wallet_performance_history
//     after every wallet upsert batch.
//
//   ROI-01 — current_value semantics (explicit alias):
//     persistPerformanceHistory now also writes total_sol_received (the
//     correctly-named column added in the migration). current_value is kept
//     for backward compatibility with any existing queries.
//
//   SEC-04 — Supabase key fallback warning:
//     getSupabase() logs a prominent warning when SUPABASE_SERVICE_ROLE_KEY is
//     absent. After the RLS hardening migration, anon-key writes will be
//     rejected by Postgres, surfacing the misconfiguration immediately.
//
// All v10 data-quality guarantees are preserved:
//   - SOL-pair-only DexScreener price selection (no USDC pair pollution)
//   - FIFO average-cost P&L calculation
//   - UNKNOWN → OPEN → PARTIALLY_CLOSED → CLOSED lifecycle
//   - Idempotent upserts on wallet_token_activity (by transaction_signature)
//   - ignoreDuplicates: true baseline in wallet_raw_tx_metrics
//   - Background enrichment via wallet-enricher (Step 7)
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
// FIX (P0 #2, P1 #8, P3 #17): import from canonical singletons.
import { consumeHeliusBudget } from "@/lib/api/helius-budget";
import { getSolPriceUsd }       from "@/lib/api/sol-price";
import { IGNORED_PROGRAMS }     from "@/lib/constants/ignored-programs";
import type {
  WalletCollectionJob,
  CollectionResult,
  HeliusEnhancedTx,
  ParsedTrader,
  TokenPriceData,
  PositionStatus,
} from "./wallet-collection.types";
import { enrichWalletsForToken } from "./wallet-enricher";
import { runPriorityEnrichmentQueue } from "./wallet-enrichment-queue";
import {
  guardRoiMultiple,
  DUST_INVESTMENT_THRESHOLD_SOL,
  SMALL_INVESTMENT_THRESHOLD_SOL,
  EXTREME_ROI_MULTIPLE,
} from "./tx-reconstructor";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_SOL_THRESHOLD = 0.001;
const MIN_TOKEN_AMOUNT  = 1;
const HELIUS_BATCH_SIZE = 25;        // Reduced from 100 → 25 for finer budget granularity
const MAX_BUYERS        = 30;        // Reduced from 50 → 30 to limit Helius calls
const MAX_TRADERS       = 100;       // Reduced from 200 → 100 to limit Helius calls
const LAMPORTS_PER_SOL  = 1_000_000_000;
const LOG = "[WalletWorker]";

// ---------------------------------------------------------------------------
// Helius credit budget guard (shared with TokenDiscovery + TxReconstructor)
// Uses globalThis so all modules share the same running counters.
// getSignaturesForAddress = 1 CU per call, Enhanced Transactions = 1 CU per tx.
// ---------------------------------------------------------------------------
function _consumeHC(cuAmount: number, label: string): boolean {
  // FIX (P0 #2): delegates to canonical singleton in helius-budget.ts
  return consumeHeliusBudget(cuAmount, label);
}

// FIX (P3 #17): IGNORED_PROGRAMS imported from canonical singleton.

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

export function getHeliusKey(): string {
  return process.env.HELIUS_API_KEY ?? "";
}

export function getRpcUrl(): string {
  const key = getHeliusKey();
  return key
    ? `https://mainnet.helius-rpc.com/?api-key=${key}`
    : "https://api.mainnet-beta.solana.com";
}

// Consolidated Supabase accessor — always uses service-role singleton.
// Exported for backward compat with wallet-enricher, wallet-enrichment-queue,
// and wallet-price-refresh which import getSupabase from this module.
// Returns null only when SUPABASE_URL or SERVICE_ROLE_KEY is absent so
// existing null-guard patterns in callers continue to work.
export function getSupabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error(`${LOG} ✗ SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set.`);
    return null;
  }
  return supabaseAdmin;
}

// ---------------------------------------------------------------------------
// Generic HTTP helper with timeout
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 8_000): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    console.warn(`${LOG} fetch ${url.slice(0, 60)} error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// RPC helper
// ---------------------------------------------------------------------------

async function rpc<T = unknown>(method: string, params: unknown[], timeoutMs = 10_000): Promise<T | null> {
  const res = await fetchWithTimeout(
    getRpcUrl(),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    },
    timeoutMs,
  );
  if (!res) return null;
  if (!res.ok) { console.warn(`${LOG} RPC ${method} HTTP ${res.status}`); return null; }
  try {
    const j = await res.json();
    return (j?.result ?? null) as T;
  } catch {
    return null;
  }
}

// FIX (P1 #8): getSolPriceUsd imported from canonical singleton.
// Re-exported so existing external callers continue to work.
export { getSolPriceUsd } from "@/lib/api/sol-price";

// ---------------------------------------------------------------------------
// Token creation time — Pump.fun API (works for all *.pump tokens)
// Returns Unix seconds, or null on failure / non-Pump.fun tokens.
// ---------------------------------------------------------------------------

async function fetchTokenCreatedAt(tokenAddress: string): Promise<number | null> {
  try {
    const res = await fetch(
      `https://frontend-api.pump.fun/coins/${tokenAddress}`,
      { signal: AbortSignal.timeout(6_000) },
    );
    if (!res.ok) return null;
    const json = await res.json() as { created_timestamp?: number };
    // Pump.fun returns created_timestamp in milliseconds
    if (typeof json.created_timestamp === "number" && json.created_timestamp > 0) {
      return Math.floor(json.created_timestamp / 1000);
    }
  } catch { /* non-fatal */ }
  return null;
}


// ---------------------------------------------------------------------------
// DexScreener — live token price
// ---------------------------------------------------------------------------

const WSOL_MINT = "So11111111111111111111111111111111111111112";

export async function fetchTokenPrice(tokenAddress: string): Promise<TokenPriceData> {
  const empty: TokenPriceData = {
    priceSol: null, priceUsd: null, marketCapUsd: null,
    fetchedAt: new Date().toISOString(),
    liquidityUsd: null, fdvUsd: null, volume24hUsd: null,
    pairAddress: null, dexId: null,
  };

  try {
    const res = await fetchWithTimeout(
      `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
      { headers: { accept: "application/json" } },
      8_000,
    );
    if (!res || !res.ok) return empty;

    const data = await res.json() as {
      pairs?: Array<{
        chainId?:     string;
        pairAddress?: string;
        dexId?:       string;
        priceNative?: string;
        priceUsd?:    string;
        marketCap?:   number;
        fdv?:         number;
        liquidity?:   { usd?: number };
        volume?:      { h24?: number };
        quoteToken?:  { address?: string; symbol?: string };
      }>;
    };

    if (!data?.pairs?.length) {
      console.log(`${LOG} DexScreener: no pairs for ${tokenAddress.slice(0, 8)}…`);
      return empty;
    }

    const solanaPairs = data.pairs.filter((p) => !p.chainId || p.chainId === "solana");

    // Primary: SOL-quoted pairs — priceNative IS the SOL price (no conversion)
    const solPairs = solanaPairs.filter(
      (p) => p.quoteToken?.address === WSOL_MINT,
    );

    if (solPairs.length > 0) {
      const best = solPairs.sort(
        (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
      )[0];

      const priceSol     = best.priceNative ? parseFloat(best.priceNative) : null;
      const priceUsd     = best.priceUsd    ? parseFloat(best.priceUsd)    : null;
      const marketCapUsd = best.marketCap   ?? best.fdv                    ?? null;

      console.log(
        `${LOG} DexScreener ${tokenAddress.slice(0, 8)}… ` +
        `[SOL pair, liq=$${(best.liquidity?.usd ?? 0).toFixed(0)}] ` +
        `priceSol=${priceSol} priceUsd=${priceUsd} mcap=${marketCapUsd}`,
      );

      return {
        priceSol, priceUsd, marketCapUsd,
        fetchedAt:    new Date().toISOString(),
        liquidityUsd: best.liquidity?.usd  ?? null,
        fdvUsd:       best.fdv             ?? null,
        volume24hUsd: best.volume?.h24     ?? null,
        pairAddress:  best.pairAddress     ?? null,
        dexId:        best.dexId           ?? null,
      };
    }

    // Fallback: no SOL-quoted pair — use USD price only, priceSol = null
    const anyBest = solanaPairs.sort(
      (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
    )[0];

    const priceUsd     = anyBest?.priceUsd ? parseFloat(anyBest.priceUsd) : null;
    const marketCapUsd = anyBest?.marketCap ?? anyBest?.fdv               ?? null;

    console.warn(
      `${LOG} DexScreener ${tokenAddress.slice(0, 8)}… ` +
      `NO SOL-quoted pair found — ${solanaPairs.length} non-SOL pairs exist. ` +
      `priceSol=null priceUsd=${priceUsd} mcap=${marketCapUsd}`,
    );

    return {
      priceSol: null, priceUsd, marketCapUsd,
      fetchedAt:    new Date().toISOString(),
      liquidityUsd: anyBest?.liquidity?.usd  ?? null,
      fdvUsd:       anyBest?.fdv             ?? null,
      volume24hUsd: anyBest?.volume?.h24     ?? null,
      pairAddress:  anyBest?.pairAddress     ?? null,
      dexId:        anyBest?.dexId           ?? null,
    };

  } catch (err) {
    console.warn(`${LOG} DexScreener error: ${err instanceof Error ? err.message : String(err)}`);
    return empty;
  }
}

// ---------------------------------------------------------------------------
// Helius enhanced transaction parser
// ---------------------------------------------------------------------------

async function heliusParseTxs(signatures: string[]): Promise<HeliusEnhancedTx[]> {
  const key = getHeliusKey();
  if (!key || signatures.length === 0) return [];
  if (!_consumeHC(signatures.length, `WalletWorker/heliusParseTxs(${signatures.length})`)) return [];
  console.log(`${LOG}   Helius parse ${signatures.length} txs`);
  try {
    const res = await fetchWithTimeout(
      `https://api.helius.xyz/v0/transactions?api-key=${key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transactions: signatures }),
      },
      20_000,
    );
    if (!res || !res.ok) { console.warn(`${LOG}   Helius HTTP ${res?.status ?? "timeout"}`); return []; }
    const data = await res.json();
    const txs = Array.isArray(data) ? (data as HeliusEnhancedTx[]) : [];
    console.log(`${LOG}   Helius returned ${txs.length} parsed txs`);
    return txs;
  } catch (err) {
    console.warn(`${LOG}   Helius error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Trade extraction from Helius transactions
// ---------------------------------------------------------------------------

function extractBuyers(tx: HeliusEnhancedTx, mint: string, poolAddress: string): ParsedTrader[] {
  const traders: ParsedTrader[] = [];
  const transfers = tx.tokenTransfers ?? [];
  const native    = tx.nativeTransfers ?? [];

  const solPaid = new Map<string, number>();
  for (const n of native) {
    if (n.toUserAccount === poolAddress && n.fromUserAccount && n.fromUserAccount !== poolAddress && !IGNORED_PROGRAMS.has(n.fromUserAccount)) {
      solPaid.set(n.fromUserAccount, (solPaid.get(n.fromUserAccount) ?? 0) + n.amount / LAMPORTS_PER_SOL);
    }
  }

  for (const t of transfers) {
    if (t.mint !== mint || t.fromUserAccount !== poolAddress || !t.toUserAccount || t.toUserAccount === poolAddress || IGNORED_PROGRAMS.has(t.toUserAccount)) continue;
    const tokenAmount = Number(t.tokenAmount ?? 0);
    if (!isFinite(tokenAmount) || tokenAmount < MIN_TOKEN_AMOUNT) continue;
    let amountSol = solPaid.get(t.toUserAccount) ?? solPaid.get(tx.feePayer) ?? 0;
    if (amountSol === 0 && tx.feePayer === t.toUserAccount) {
      amountSol = native.filter((n) => n.fromUserAccount === tx.feePayer).reduce((s, n) => s + n.amount / LAMPORTS_PER_SOL, 0);
    }
    if (amountSol < MIN_SOL_THRESHOLD) continue;
    traders.push({ walletAddress: t.toUserAccount, transactionSignature: tx.signature, actionType: "buy", amountSol, tokenAmount, timestamp: tx.timestamp });
  }
  return traders;
}

// ---------------------------------------------------------------------------
// extractSellers — v5 (phantom-sell fix: require tokens sent TO pool)
//
// ROOT CAUSE of "0 sellers", confirmed 2026-07-08 by tracing real Pump.fun
// swap transactions against the Helius API directly:
//
//   Pump.fun does NOT pay the seller via a `system_instruction::transfer`
//   (or a wSOL-close hop) at all. The program moves lamports with a direct,
//   program-signed account mutation. Helius's `nativeTransfers` array only
//   contains parsed System Program transfer instructions, so the seller's
//   actual payout is INVISIBLE there — every real sell we inspected had
//   nativeTransferToSeller === 0 while the seller's wallet unambiguously
//   received SOL in the transaction.
//
//   The payout only shows up in `tx.accountData[].nativeBalanceChange`,
//   which reflects the net lamport delta for every account touched by the
//   transaction regardless of how the lamports moved. Example (real tx):
//     accountData: [
//       { account: sellerWallet, nativeBalanceChange: +873261400 },  ← the sale proceeds
//       { account: poolAddress,  nativeBalanceChange: -895298709 },  ← pool paid out
//       ...fee/referral accounts...
//     ]
//     nativeTransfers: [ small fee-only transfers FROM the seller — no payout TO them ]
//
//   v3 (wSOL-close fix) still only read `nativeTransfers`, so it inherited
//   the same blind spot and continued to return 0 sellers 100% of the time
//   (verified against 418 re-scanned jobs, all with sellers_collected = 0).
//
// FIX (v4):
//   Step A — confirm the pool's net lamport balance in this tx is negative
//             (it paid out SOL). This is the "is it a sell?" gate, read from
//             accountData instead of nativeTransfers.
//
//   Step B — for every wallet touched by the tx, take its net
//             nativeBalanceChange from accountData. A positive value is SOL
//             actually received, however it was moved.
//
// FIX (v5) — PHANTOM SELL BUG:
//   v4 identified sellers by checking (a) wallet sent the tracked token AND
//   (b) wallet received SOL in the same tx. Missing: it did NOT verify that
//   the tokens were sent TO the pool (bonding curve). This let any wallet
//   that transferred the token to ANY destination (e.g. another wallet, a
//   different protocol, their own ATA) in a transaction where the pool
//   happened to pay out SOL be mis-classified as a seller. Transactions where
//   the pool pays out for wallet A's sell could also capture wallet B that
//   coincidentally transferred the same token to a third party in the same
//   multi-instruction tx — creating a phantom sell for wallet B.
//
//   Root cause of the 17,351 phantom sells (38.5% of all recorded sells).
//
//   Step C now requires t.toUserAccount === poolAddress — i.e. the tokens
//   must have been sent DIRECTLY to the bonding-curve pool to count as a
//   sell. This mirrors extractBuyers which already requires
//   t.fromUserAccount === poolAddress for the buy side.
// ---------------------------------------------------------------------------
function extractSellers(tx: HeliusEnhancedTx, mint: string, poolAddress: string): ParsedTrader[] {
  const traders: ParsedTrader[] = [];
  const transfers    = tx.tokenTransfers ?? [];
  const accountDelta = tx.accountData ?? [];

  // ── Step A — Gate: did the pool's balance go DOWN in this tx? ─────────────
  // A negative nativeBalanceChange on the pool account means it paid out SOL
  // — sell activity (however that payout was actually moved on-chain).
  const poolDelta   = accountDelta.find((a) => a.account === poolAddress)?.nativeBalanceChange ?? 0;
  const poolPaidSol = poolDelta < 0;

  if (!poolPaidSol) {
    console.log(
      `[SELLER_SCAN_V5] REJECT_NO_SOL_FROM_POOL sig=${tx.signature?.slice(0, 20)}… ` +
      `pool=${poolAddress} balance did not decrease in this tx — not a sell`,
    );
    return traders;
  }

  // ── Step B — Build a map of every wallet → net SOL received in this tx ────
  // Uses accountData (whole-tx lamport deltas), NOT nativeTransfers, because
  // Pump.fun-style payouts don't appear as parsed transfer instructions.
  const solReceivedByWallet = new Map<string, number>();
  for (const a of accountDelta) {
    if (a.account && a.account !== poolAddress && a.nativeBalanceChange > 0 && !IGNORED_PROGRAMS.has(a.account)) {
      solReceivedByWallet.set(a.account, a.nativeBalanceChange / LAMPORTS_PER_SOL);
    }
  }

  // ── Step C — Identify sellers: sent the right token TO THE POOL + received SOL ──
  //
  // BUG-FIX (v5 — phantom sell): v4 checked that a wallet sent the mint token
  // somewhere and received SOL, but did NOT verify the destination was the pool.
  // Wallets that transferred the token to any address in the same tx as a real
  // sell (e.g. during a multi-instruction transaction or token consolidation)
  // were incorrectly recorded as sellers — 38.5% of all sell records were phantom.
  //
  // A seller is a non-pool, non-program wallet that:
  //   (a) sent tokens of the correct mint DIRECTLY TO the pool in this tx
  //   (b) had a positive net SOL balance change in the same tx (their payout)
  //
  // The t.toUserAccount === poolAddress requirement mirrors extractBuyers
  // which already requires t.fromUserAccount === poolAddress on the buy side.
  const seenSellers = new Set<string>();

  for (const t of transfers) {
    if (t.mint !== mint) continue;

    const from        = t.fromUserAccount ?? "";
    const to          = t.toUserAccount   ?? "";
    const tokenAmount = Number(t.tokenAmount ?? 0);

    // Skip: no sender, pool itself is the sender (that's a buy side), or program account
    if (!from || from === poolAddress || IGNORED_PROGRAMS.has(from)) continue;
    // FIX (v5): tokens must go TO the pool — reject transfers to any other destination
    if (to !== poolAddress) {
      console.log(
        `[SELLER_SCAN_V5] REJECT_WRONG_DESTINATION sig=${tx.signature?.slice(0, 20)}… ` +
        `from=${from.slice(0, 8)}… to=${to.slice(0, 8)}… (expected pool=${poolAddress.slice(0, 8)}…) — phantom sell suppressed`,
      );
      continue;
    }
    if (!isFinite(tokenAmount) || tokenAmount < MIN_TOKEN_AMOUNT) continue;
    if (seenSellers.has(from)) continue; // dedupe if multiple transfers from same wallet

    const amountSol = solReceivedByWallet.get(from) ?? 0;
    if (amountSol < MIN_SOL_THRESHOLD) continue;

    seenSellers.add(from);
    traders.push({
      walletAddress:        from,
      transactionSignature: tx.signature,
      actionType:           "sell",
      amountSol,
      tokenAmount,
      timestamp:            tx.timestamp,
    });
  }

  console.log(
    `[SELLER_SCAN_V5] extractSellers() sig=${tx.signature?.slice(0, 20)}… ` +
    `→ ${traders.length} seller(s)  ` +
    `[tokenTransfers=${transfers.length} accountData=${accountDelta.length}]`,
  );

  return traders;
}

// ---------------------------------------------------------------------------
// wallet_token_activity  (Step 4)
// ---------------------------------------------------------------------------

async function persistActivity(
  traders: ParsedTrader[],
  job: WalletCollectionJob,
  errors: string[],
  solPriceUsd: number | null,
  tokenCreatedAt: number | null,
): Promise<void> {
  if (traders.length === 0) { console.log(`${LOG}   Step 4 SKIP — 0 traders`); return; }
  const sb = getSupabase();
  if (!sb) { errors.push("Supabase unavailable — wallet_token_activity skipped."); return; }

  const rows = traders.map((t) => ({
    wallet_address:        t.walletAddress,
    token_address:         job.tokenAddress,
    transaction_signature: t.transactionSignature,
    action_type:           t.actionType,
    amount_sol:            t.amountSol,
    amount_usd:            (solPriceUsd != null && t.amountSol > 0)
      ? Math.round(t.amountSol * solPriceUsd * 100) / 100
      : null,
    // FIX (2026-07-12 data-quality audit): solPriceUsd was already fetched and
    // used to derive amount_usd above, but was never itself persisted — the
    // column existed (added via a one-off backfill script) yet the live write
    // path never populated it, so 91% of rows had a null sol_price_usd_at_trade.
    sol_price_usd_at_trade: solPriceUsd ?? null,
    token_amount:          t.tokenAmount,
    timestamp:             new Date(t.timestamp * 1000).toISOString(),
    entry_market_cap:      job.marketCapUsd ?? null,
    liquidity_at_entry:    job.liquidityUsd ?? null,
    holder_count_at_entry: job.holderCount  ?? null,
    token_age_at_entry:    tokenCreatedAt != null
      ? Math.max(0, Math.round(t.timestamp - tokenCreatedAt))
      : job.tokenCreatedAt != null
        ? Math.max(0, Math.round(t.timestamp - job.tokenCreatedAt!))
        : null,
  }));

  const sellerRows = rows.filter((r) => r.action_type === "sell");
  const buyerRows  = rows.filter((r) => r.action_type === "buy");
  console.log(
    `${LOG}   Step 4 — upserting ${rows.length} rows → wallet_token_activity ` +
    `(buys=${buyerRows.length} sells=${sellerRows.length})`,
  );
  if (sellerRows.length === 0) {
    console.warn(
      `[SELLER_SCAN_V5] ⚠ Step 4: 0 seller rows about to be written to wallet_token_activity — ` +
      `check extractSellers() logs above for filter reasons`,
    );
  } else {
    console.log(
      `[SELLER_SCAN_V5] Step 4: ${sellerRows.length} seller row(s) queued for DB write ` +
      `— unique seller wallets=${new Set(sellerRows.map((r) => r.wallet_address)).size}`,
    );
  }
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const chunkSellers = chunk.filter((r) => r.action_type === "sell").length;
    // ignoreDuplicates: true — transaction_signature is the dedup key
    const { error } = await sb.from("wallet_token_activity").upsert(chunk, { onConflict: "transaction_signature", ignoreDuplicates: true });
    if (error) {
      const m = `wallet_token_activity: ${error.message}`;
      console.error(`${LOG}   ✗ ${m}`);
      errors.push(m);
    } else {
      console.log(
        `${LOG}   ✓ wallet_token_activity chunk ${Math.floor(i / CHUNK)} (${chunk.length} rows — sellers=${chunkSellers})`,
      );
      if (chunkSellers > 0) {
        console.log(
          `[SELLER_SCAN_V5] ✓ DB write confirmed: ${chunkSellers} seller row(s) written in chunk ${Math.floor(i / CHUNK)}`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// wallets  (Step 5)
//
// DB-03 fix: total_tokens_traded is no longer hardcoded to 1.
//   The bulk upsert omits total_tokens_traded entirely.
//   After all chunks are written, refresh_wallet_token_counts() is called
//   (a Postgres SECURITY DEFINER function added in migration 20260627000001)
//   to set the correct count from wallet_performance_history for each wallet.
// ---------------------------------------------------------------------------

async function persistWallets(traders: ParsedTrader[], errors: string[]): Promise<void> {
  if (traders.length === 0) return;
  const sb = getSupabase();
  if (!sb) { errors.push("Supabase unavailable — wallets skipped."); return; }

  const walletMap = new Map<string, { firstTs: number; lastTs: number; buys: number; sells: number }>();
  for (const t of traders) {
    const w = walletMap.get(t.walletAddress) ?? { firstTs: t.timestamp, lastTs: t.timestamp, buys: 0, sells: 0 };
    w.firstTs = Math.min(w.firstTs, t.timestamp);
    w.lastTs  = Math.max(w.lastTs,  t.timestamp);
    if (t.actionType === "buy") w.buys++; else w.sells++;
    walletMap.set(t.walletAddress, w);
  }

  const walletAddresses: string[] = [];
  const rows = Array.from(walletMap.entries()).map(([addr, w]) => {
    walletAddresses.push(addr);
    return {
      wallet_address:        addr,
      first_seen_timestamp:  new Date(w.firstTs * 1000).toISOString(),
      last_seen_timestamp:   new Date(w.lastTs  * 1000).toISOString(),
      // FIX (P0 #1): wallet_classification NEVER set by collection worker — preserves DB value.
      // FIX (P0 #3): total_buys/total_sells moved to increment_wallet_buy_sell_counts() RPC below.
    };
  });

  console.log(`${LOG}   Step 5 — upserting ${rows.length} rows → wallets`);
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await sb.from("wallets").upsert(chunk, { onConflict: "wallet_address", ignoreDuplicates: false });
    if (error) { const m = `wallets: ${error.message}`; console.error(`${LOG}   ✗ ${m}`); errors.push(m); }
    else         { console.log(`${LOG}   ✓ wallets chunk ${Math.floor(i / CHUNK)} (${chunk.length} rows)`); }
  }

  // DB-03 fix: refresh total_tokens_traded from wallet_performance_history
  if (walletAddresses.length > 0) {
    try {
      const { error: rpcErr } = await sb.rpc("refresh_wallet_token_counts", {
        p_wallet_addresses: walletAddresses,
      });
      if (rpcErr) {
        if (rpcErr.message.includes("does not exist") || rpcErr.message.includes("function")) {
          console.warn(`${LOG}   refresh_wallet_token_counts() not found — apply migration 20260627000001 first`);
        } else {
          console.warn(`${LOG}   refresh_wallet_token_counts() error: ${rpcErr.message}`);
        }
      } else {
        console.log(`${LOG}   ✓ total_tokens_traded refreshed for ${walletAddresses.length} wallets`);
      }
    } catch (err) {
      console.warn(`${LOG}   refresh_wallet_token_counts() threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // FIX (P0 #3): increment total_buys/total_sells atomically — accumulates across scans.
  // Requires migration 20260720000008_increment_wallet_buy_sell.sql.
  if (walletMap.size > 0) {
    try {
      const incrementRows = Array.from(walletMap.entries()).map(([addr, w]) => ({
        wallet_address: addr,
        buys:           w.buys,
        sells:          w.sells,
        first_seen:     new Date(w.firstTs * 1000).toISOString(),
        last_seen:      new Date(w.lastTs  * 1000).toISOString(),
      }));
      const { error: incErr } = await sb.rpc("increment_wallet_buy_sell_counts", {
        wallet_rows: incrementRows,
      });
      if (incErr) {
        if (incErr.message.includes("does not exist") || incErr.message.includes("function")) {
          console.warn(`${LOG}   increment_wallet_buy_sell_counts() not found — apply migration 20260720000008 first`);
        } else {
          console.warn(`${LOG}   increment_wallet_buy_sell_counts() error: ${incErr.message}`);
        }
      } else {
        console.log(`${LOG}   ✓ total_buys/total_sells incremented for ${incrementRows.length} wallets`);
      }
    } catch (err) {
      console.warn(`${LOG}   increment_wallet_buy_sell_counts() threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// wallet_performance_history  (Step 6) — CORRECTED P&L
// ---------------------------------------------------------------------------

interface PerfEntry {
  investedSol:    number;
  receivedSol:    number;
  tokensBought:   number;
  tokensSold:     number;
  firstTs:        number;
  lastTs:         number;
  isHolderOnly:   boolean;
}

function determinePositionStatus(p: PerfEntry): PositionStatus {
  // BUG-FIX (unknown-position-mismatch): previously this returned UNKNOWN
  // whenever EITHER investedSol was 0 OR tokensBought was 0 — checked as
  // separate early returns. That permanently stuck any wallet whose buy went
  // through a swap route Helius couldn't cleanly attribute a SOL leg to
  // (investedSol stays 0) at UNKNOWN forever, even when tokensBought > 0 and
  // tokensSold === 0 clearly show an open position. tx-reconstructor.ts's
  // classifyPositionStatus already had the correct rule (UNKNOWN only when
  // there is truly no evidence at all — both figures are 0); this brings
  // the collection-worker's initial-insert path in line with it so newly
  // written rows don't reproduce the bug that 20260704000001_fix_unknown_positions.sql
  // had to backfill after the fact.
  if (p.isHolderOnly) return "UNKNOWN";
  if (p.tokensBought === 0 && p.investedSol === 0) return "UNKNOWN";
  if (p.tokensSold === 0) return "OPEN";
  if (p.tokensSold >= p.tokensBought * 0.95) return "CLOSED";
  return "PARTIALLY_CLOSED";
}

interface PnL {
  realizedProfit:       number;
  unrealizedProfit:     number;
  roiMultiple:          number | null;
  currentPositionValue: number;
  currentTokenBalance:  number;
}

function calculatePnL(p: PerfEntry, priceSol: number | null, status: PositionStatus): PnL {
  const estimatedBalance = Math.max(0, p.tokensBought - p.tokensSold);
  const currentTokenBalance = p.isHolderOnly ? p.tokensBought : estimatedBalance;
  const currentPositionValue = (priceSol != null && priceSol > 0)
    ? currentTokenBalance * priceSol
    : 0;

  if (status === "UNKNOWN") {
    return {
      realizedProfit:       0,
      unrealizedProfit:     currentPositionValue,
      roiMultiple:          null,
      currentPositionValue,
      currentTokenBalance,
    };
  }

  if (status === "OPEN") {
    const unrealizedProfit = currentPositionValue - p.investedSol;
    const roiMultiple = p.investedSol > 0
      ? currentPositionValue / p.investedSol
      : null;
    return {
      realizedProfit:   0,
      unrealizedProfit,
      roiMultiple,
      currentPositionValue,
      currentTokenBalance,
    };
  }

  if (status === "CLOSED") {
    const realizedProfit = p.receivedSol - p.investedSol;
    // ROI-GUARD (2026-07-18): wrap in guardRoiMultiple so tiny-investment
    // positions (< SMALL_INVESTMENT_THRESHOLD_SOL) are capped at
    // EXTREME_ROI_MULTIPLE, matching the protection already applied in
    // wallet-enricher.ts. Without this guard, every new enrichment run on
    // small-investment CLOSED positions could recreate distorted rows even
    // after a DB cleanup migration — the exact regression observed after the
    // Jul 13–15 migrations (audit finding C1).
    const rawRoi      = p.investedSol > 0 ? p.receivedSol / p.investedSol : null;
    const roiMultiple = guardRoiMultiple(rawRoi, p.investedSol);
    return {
      realizedProfit,
      unrealizedProfit:     0,
      roiMultiple,
      currentPositionValue: 0,
      currentTokenBalance:  0,
    };
  }

  // PARTIALLY_CLOSED: split cost basis between sold and remaining portions
  const fractionSold      = p.tokensBought > 0 ? p.tokensSold  / p.tokensBought : 0;
  const fractionRemaining  = 1 - fractionSold;
  const costOfSold        = p.investedSol * fractionSold;
  const costOfRemaining   = p.investedSol * fractionRemaining;

  const realizedProfit   = p.receivedSol - costOfSold;
  const unrealizedProfit = currentPositionValue - costOfRemaining;
  const totalReturn      = p.receivedSol + currentPositionValue;
  // ROI-GUARD (2026-07-18): same guard as CLOSED branch above.
  const rawTotalRoi  = p.investedSol > 0 ? totalReturn / p.investedSol : null;
  const roiMultiple  = guardRoiMultiple(rawTotalRoi, p.investedSol);

  return {
    realizedProfit,
    unrealizedProfit,
    roiMultiple,
    currentPositionValue,
    currentTokenBalance,
  };
}

// ---------------------------------------------------------------------------
// Peak ROI helper — ROI-02 fix
//
// Old (buggy): Math.max(a ?? 0, b ?? 0) || null
//   → converts exact 0× ROI to null (0 is falsy in JS)
//
// New: null only when BOTH inputs are null; numeric max (including 0) otherwise.
// ---------------------------------------------------------------------------

function safePeakMax(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return Math.max(a ?? 0, b ?? 0);
}

// ---------------------------------------------------------------------------
// Milestone timestamp helper — ROI-03 fix
//
// Returns the existing timestamp when the milestone was already reached,
// scanTime when the milestone is newly reached this run, or null when
// the milestone has not been reached at all. Immutable once set.
// ---------------------------------------------------------------------------

function milestoneTs(
  flagIsReached: boolean,
  existingTs:    string | null | undefined,
  scanTime:      string,
): string | null {
  if (!flagIsReached) return existingTs ?? null; // preserve existing if flag was previously true
  return existingTs ?? scanTime;                  // keep first stamp; only write scanTime when new
}

// ---------------------------------------------------------------------------
// Existing row pre-fetcher for persistPerformanceHistory
//
// Fetches peak ROI, peak position value, AND all milestone timestamps in one
// batch query so the row builder can preserve them without N+1 queries.
// ---------------------------------------------------------------------------

interface ExistingPerfSnapshot {
  peakRoi:              number | null;
  peakPosSol:           number | null;
  reached100kAt:        string | null;
  reached500kAt:        string | null;
  reached1mAt:          string | null;
  reached5mAt:          string | null;
  reached10mAt:         string | null;
  reached50mAt:         string | null;
}

async function fetchExistingPerfSnapshots(
  sb:              ReturnType<typeof createClient>,
  tokenAddress:    string,
  walletAddresses: string[],
): Promise<Map<string, ExistingPerfSnapshot>> {
  const map = new Map<string, ExistingPerfSnapshot>();
  if (walletAddresses.length === 0) return map;
  try {
    const { data: rows } = await sb
      .from("wallet_performance_history")
      .select(
        "wallet_address, peak_roi, peak_position_value_sol, " +
        "reached_100k_mc_at, reached_500k_mc_at, reached_1m_mc_at, " +
        "reached_5m_mc_at, reached_10m_mc_at, reached_50m_mc_at",
      )
      .eq("token_address", tokenAddress)
      .in("wallet_address", walletAddresses.slice(0, 500));  // Supabase IN limit

    for (const row of rows ?? []) {
      map.set(row.wallet_address as string, {
        peakRoi:       row.peak_roi                 as number | null,
        peakPosSol:    (row as Record<string, unknown>).peak_position_value_sol as number | null,
        reached100kAt: (row as Record<string, unknown>).reached_100k_mc_at     as string | null,
        reached500kAt: (row as Record<string, unknown>).reached_500k_mc_at     as string | null,
        reached1mAt:   (row as Record<string, unknown>).reached_1m_mc_at       as string | null,
        reached5mAt:   (row as Record<string, unknown>).reached_5m_mc_at       as string | null,
        reached10mAt:  (row as Record<string, unknown>).reached_10m_mc_at      as string | null,
        reached50mAt:  (row as Record<string, unknown>).reached_50m_mc_at      as string | null,
      });
    }
  } catch {
    // Non-fatal — peaks and milestone timestamps start fresh for this run
  }
  return map;
}

async function persistPerformanceHistory(
  traders:      ParsedTrader[],
  job:          WalletCollectionJob,
  priceData:    TokenPriceData,
  errors:       string[],
): Promise<void> {
  if (traders.length === 0) return;
  const sb = getSupabase();
  if (!sb) { errors.push("Supabase unavailable — wallet_performance_history skipped."); return; }

  // ── Build per-wallet aggregates ───────────────────────────────────────────
  const perfMap = new Map<string, PerfEntry>();
  for (const t of traders) {
    const existing = perfMap.get(t.walletAddress) ?? {
      investedSol: 0, receivedSol: 0,
      tokensBought: 0, tokensSold: 0,
      firstTs: t.timestamp, lastTs: t.timestamp,
      isHolderOnly: t.isHolderOnly ?? false,
    };
    if (t.actionType === "buy") {
      existing.investedSol  += t.amountSol;
      existing.tokensBought += t.tokenAmount;
    } else {
      existing.receivedSol  += t.amountSol;
      existing.tokensSold   += t.tokenAmount;
    }
    existing.firstTs = Math.min(existing.firstTs, t.timestamp);
    existing.lastTs  = Math.max(existing.lastTs,  t.timestamp);
    if (!t.isHolderOnly) existing.isHolderOnly = false;
    perfMap.set(t.walletAddress, existing);
  }

  // ── Fetch existing peaks AND milestone timestamps in one batch ────────────
  const walletAddresses = Array.from(perfMap.keys());
  const existingSnapshots = await fetchExistingPerfSnapshots(sb, job.tokenAddress, walletAddresses);

  // ── Market-cap milestone flags ─────────────────────────────────────────────
  const scanMcap = job.marketCapUsd ?? priceData.marketCapUsd;
  const scanTime = new Date().toISOString();

  // ── Build rows ─────────────────────────────────────────────────────────────
  const rows = Array.from(perfMap.entries()).map(([addr, p]) => {
    const status   = determinePositionStatus(p);
    const pnl      = calculatePnL(p, priceData.priceSol, status);
    const existing = existingSnapshots.get(addr);

    // ROI-02 fix: safePeakMax returns null only when BOTH are null (not when either is 0)
    const peakRoi = safePeakMax(pnl.roiMultiple, existing?.peakRoi ?? null);
    const peakPos = safePeakMax(pnl.currentPositionValue, existing?.peakPosSol ?? null);

    // Milestone flag helpers
    const mcap = scanMcap ?? null;
    const reached100k = mcap != null && mcap >= 100_000;
    const reached500k = mcap != null && mcap >= 500_000;
    const reached1m   = mcap != null && mcap >= 1_000_000;
    const reached5m   = mcap != null && mcap >= 5_000_000;
    const reached10m  = mcap != null && mcap >= 10_000_000;
    const reached50m  = mcap != null && mcap >= 50_000_000;

    return {
      wallet_address:              addr,
      token_address:               job.tokenAddress,

      // Investment tracking
      initial_investment:          p.investedSol,
      // ROI-01 fix: write both current_value (compat) and total_sol_received (correct name)
      current_value:               p.receivedSol,
      total_sol_received:          p.receivedSol,
      total_tokens_bought:         p.tokensBought,
      total_tokens_sold:           p.tokensSold,

      // Position
      position_status:             status,
      current_token_balance:       pnl.currentTokenBalance,
      current_position_value_sol:  pnl.currentPositionValue,

      // Live pricing snapshot
      current_token_price_sol:     priceData.priceSol    ?? null,
      current_token_price_usd:     priceData.priceUsd    ?? null,
      current_market_cap_usd:      priceData.marketCapUsd ?? null,

      // P&L
      realized_profit:             pnl.realizedProfit,
      unrealized_profit:           pnl.unrealizedProfit,
      roi_multiple:                pnl.roiMultiple,

      // Peaks — preserved across upserts (ROI-02 fix applied via safePeakMax)
      peak_roi:                    peakRoi,
      peak_position_value_sol:     peakPos,

      // Milestone boolean flags — never degrade (once true, stays true)
      reached_100k_mc: reached100k || (existing?.reached100kAt != null),
      reached_500k_mc: reached500k || (existing?.reached500kAt != null),
      reached_1m_mc:   reached1m   || (existing?.reached1mAt   != null),
      reached_5m_mc:   reached5m   || (existing?.reached5mAt   != null),
      reached_10m_mc:  reached10m  || (existing?.reached10mAt  != null),
      reached_50m_mc:  reached50m  || (existing?.reached50mAt  != null),

      // ROI-03 fix: milestone timestamps — stamp once, never overwrite
      reached_100k_mc_at: milestoneTs(reached100k, existing?.reached100kAt, scanTime),
      reached_500k_mc_at: milestoneTs(reached500k, existing?.reached500kAt, scanTime),
      reached_1m_mc_at:   milestoneTs(reached1m,   existing?.reached1mAt,   scanTime),
      reached_5m_mc_at:   milestoneTs(reached5m,   existing?.reached5mAt,   scanTime),
      reached_10m_mc_at:  milestoneTs(reached10m,  existing?.reached10mAt,  scanTime),
      reached_50m_mc_at:  milestoneTs(reached50m,  existing?.reached50mAt,  scanTime),

      last_updated: scanTime,
    };
  });

  console.log(`${LOG}   Step 6 — upserting ${rows.length} rows → wallet_performance_history`);
  console.log(
    `${LOG}   Price context: priceSol=${priceData.priceSol ?? "N/A"} ` +
    `priceUsd=${priceData.priceUsd ?? "N/A"} mcap=${priceData.marketCapUsd ?? "N/A"}`,
  );

  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);

    const { error } = await sb
      .from("wallet_performance_history")
      .upsert(chunk, { onConflict: "wallet_address,token_address", ignoreDuplicates: false });

    if (error) {
      const m = `wallet_performance_history: ${error.message}`;
      console.error(`${LOG}   ✗ ${m}`);
      errors.push(m);
    } else {
      const sample = chunk[0];
      console.log(
        `${LOG}   ✓ chunk ${Math.floor(i / CHUNK)} (${chunk.length} rows) ` +
        `sample: wallet=${(sample.wallet_address as string).slice(0, 8)}… ` +
        `status=${sample.position_status} ` +
        `invested=${(sample.initial_investment as number).toFixed(4)} SOL ` +
        `realized=${(sample.realized_profit as number).toFixed(4)} SOL ` +
        `unrealized=${(sample.unrealized_profit as number).toFixed(4)} SOL ` +
        `roi=${sample.roi_multiple != null ? (sample.roi_multiple as number).toFixed(2) + "x" : "N/A"}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// wallet_raw_tx_metrics baseline — Step 6b (Phase 1)
// ---------------------------------------------------------------------------

async function persistRawMetricsBaseline(
  traders: ParsedTrader[],
  job:     WalletCollectionJob,
  errors:  string[],
): Promise<void> {
  if (traders.length === 0) return;
  const sb = getSupabase();
  if (!sb) return;

  interface BaselineEntry {
    buys:         number;
    sells:        number;
    tokensBought: number;
    tokensSold:   number;
    investedSol:  number;
    receivedSol:  number;
    firstTs:      number;
    lastTs:       number;
    isHolderOnly: boolean;
  }

  const walletMap = new Map<string, BaselineEntry>();
  for (const t of traders) {
    const w: BaselineEntry = walletMap.get(t.walletAddress) ?? {
      buys: 0, sells: 0,
      tokensBought: 0, tokensSold: 0,
      investedSol: 0, receivedSol: 0,
      firstTs: t.timestamp, lastTs: t.timestamp,
      isHolderOnly: t.isHolderOnly ?? false,
    };
    if (t.actionType === "buy")  { w.buys++;  w.tokensBought += t.tokenAmount; w.investedSol  += t.amountSol; }
    else                         { w.sells++; w.tokensSold   += t.tokenAmount; w.receivedSol  += t.amountSol; }
    w.firstTs = Math.min(w.firstTs, t.timestamp);
    w.lastTs  = Math.max(w.lastTs,  t.timestamp);
    if (!t.isHolderOnly) w.isHolderOnly = false;
    walletMap.set(t.walletAddress, w);
  }

  const scanTime = new Date().toISOString();
  const rows = Array.from(walletMap.entries()).map(([addr, w]) => ({
    wallet_address:           addr,
    token_address:            job.tokenAddress,
    total_buy_txs:            w.buys,
    total_sell_txs:           w.sells,
    total_tokens_bought:      w.tokensBought,
    total_tokens_sold:        w.tokensSold,
    total_sol_invested:       w.investedSol,
    total_sol_received:       w.receivedSol,
    current_token_balance:    Math.max(0, w.tokensBought - w.tokensSold),
    data_source:              w.isHolderOnly ? "holder_scan" : "pool_extraction",
    // FIX (2026-07-12 data-quality audit): this column defaults to `true` in
    // the schema, but a holder detected with zero parsed buy/sell txs (pure
    // holder_scan hit, no trade evidence at all) was silently inheriting that
    // default and being counted as "has real evidence" downstream. Set it
    // explicitly from what we actually found.
    has_evidence:             w.buys > 0 || w.sells > 0,
    total_signatures_scanned: null,
    first_tx_at:              new Date(w.firstTs * 1000).toISOString(),
    last_tx_at:               new Date(w.lastTs  * 1000).toISOString(),
    last_scanned_at:          scanTime,
  }));

  console.log(`${LOG}   Step 6b — upserting ${rows.length} baseline rows → wallet_raw_tx_metrics`);
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await sb
      .from("wallet_raw_tx_metrics")
      // ignoreDuplicates: true — never overwrite a helius_full_history row
      .upsert(rows.slice(i, i + CHUNK), { onConflict: "wallet_address,token_address", ignoreDuplicates: true });
    if (error) {
      if (error.message.includes("does not exist") || error.message.includes("relation")) {
        console.warn(`${LOG}   wallet_raw_tx_metrics not found — apply migration 20260627000001 first`);
        break;
      }
      const m = `wallet_raw_tx_metrics baseline: ${error.message}`;
      console.error(`${LOG}   ✗ ${m}`); errors.push(m);
    } else {
      console.log(`${LOG}   ✓ raw_metrics baseline chunk ${Math.floor(i / CHUNK)} (${rows.slice(i, i + CHUNK).length} rows)`);
    }
  }
}

// ---------------------------------------------------------------------------
// Significant holders — Step 3
// ---------------------------------------------------------------------------

async function collectSignificantHolders(
  job: WalletCollectionJob,
  existingWallets: Set<string>,
  errors: string[],
): Promise<ParsedTrader[]> {
  const traders: ParsedTrader[] = [];
  console.log(`${LOG} Step 3 — getTokenLargestAccounts for ${job.tokenAddress}`);

  try {
    const result = await rpc<{ value: Array<{ address: string; uiAmount: number }> }>(
      "getTokenLargestAccounts", [job.tokenAddress, { commitment: "confirmed" }],
    );
    if (!result?.value) { console.log(`${LOG}   No value returned from RPC`); return traders; }
    console.log(`${LOG}   ${result.value.length} token accounts found`);

    for (const acct of result.value.slice(0, 15)) {
      if (IGNORED_PROGRAMS.has(acct.address)) continue;
      if (job.poolAddress && acct.address === job.poolAddress) continue;
      const uiAmount = acct.uiAmount ?? 0;
      if (uiAmount <= 0) continue;

      if (!_consumeHC(1, "WalletWorker/collectSignificantHolders/getAccountInfo")) break;
      const info = await rpc<{ value: { data: unknown } }>(
        "getAccountInfo", [acct.address, { encoding: "jsonParsed" }],
      );
      const parsed = (info?.value?.data as { parsed?: { info?: { owner?: string } } } | undefined)?.parsed;
      const owner  = parsed?.info?.owner;
      if (!owner || IGNORED_PROGRAMS.has(owner)) continue;
      if (job.poolAddress && owner === job.poolAddress) continue;
      if (existingWallets.has(owner)) continue;
      existingWallets.add(owner);

      if (!_consumeHC(1, "WalletWorker/collectSignificantHolders/getSignaturesForAddress")) break;
      const sigs = await rpc<Array<{ signature: string; err: unknown }>>(
        "getSignaturesForAddress", [acct.address, { limit: 3, commitment: "confirmed" }],
      );
      const firstSig = Array.isArray(sigs)
        ? sigs.filter((s) => !s.err).map((s) => s.signature).find(Boolean)
        : undefined;
      if (!firstSig) continue;

      traders.push({
        walletAddress:         owner,
        transactionSignature:  firstSig,
        actionType:            "buy",
        amountSol:             0,
        tokenAmount:           uiAmount,
        timestamp:             Math.floor(Date.now() / 1000),
        isHolderOnly:          true,
      });
      console.log(`${LOG}   holder: ${owner.slice(0, 8)}… balance=${uiAmount.toLocaleString()} tokens`);
    }
    console.log(`${LOG}   collectSignificantHolders done: ${traders.length} holders`);
  } catch (err) {
    const msg = `collectSignificantHolders: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`${LOG}   ${msg}`);
    errors.push(msg);
  }
  return traders;
}

// ---------------------------------------------------------------------------
// Public API — collect()
// ---------------------------------------------------------------------------

export async function collect(job: WalletCollectionJob): Promise<CollectionResult> {
  const result: CollectionResult = {
    tokenAddress: job.tokenAddress, poolAddress: job.poolAddress ?? null,
    tradersCollected: 0, buyersCollected: 0, sellersCollected: 0,
    skippedDust: 0, skippedAirdrop: 0, errors: [],
  };

  const heliusOk = !!getHeliusKey();
  const sbOk     = !!getSupabase();

  // ── Pre-flight hourly budget check ───────────────────────────────────────────
  // A single collect() job costs at minimum ~8 CUs (3 sig pages + recent batch +
  // holder lookups). If fewer than 10 CUs remain in the hourly window, skip the
  // job now to avoid partial runs that burn the last credits on a token that
  // won't complete. The job stays in the queue and will be retried next hour.
  if (heliusOk) {
    const g = globalThis as any;
    const now = Date.now();
    if (!g.__heliusHourly__ || now - g.__heliusHourly__.window >= 3_600_000) {
      g.__heliusHourly__ = {
        budget: parseInt(process.env.HELIUS_HOURLY_BUDGET ?? "0", 10) || 0,
        used:   0,
        window: now,
        warned: false,
      };
    }
    const h = g.__heliusHourly__;
    const MIN_CU_PER_JOB = 10;
    if (h.budget > 0 && h.used + MIN_CU_PER_JOB > h.budget) {
      const resetsIn = Math.ceil((h.window + 3_600_000 - now) / 60_000);
      console.warn(
        `${LOG} ⚠ Hourly budget almost exhausted (${h.used}/${h.budget} CUs used). ` +
        `Skipping collect() for ${job.tokenAddress.slice(0, 8)}… — job will retry next window (~${resetsIn} min). ` +
        `Raise HELIUS_HOURLY_BUDGET in Railway Variables to process more jobs per hour.`,
      );
      result.errors.push(`hourly_budget_exhausted — retry in ~${resetsIn}min`);
      return result;
    }
  }

  console.log(
    `${LOG} ═══ collect() START\n` +
    `${LOG}   token  : ${job.tokenAddress}\n` +
    `${LOG}   pool   : ${job.poolAddress ?? "NONE (holder-only mode)"}\n` +
    `${LOG}   helius : ${heliusOk ? "✓" : "✗ MISSING (Steps 1-2 skipped)"}\n` +
    `${LOG}   sb     : ${sbOk ? "✓" : "✗ MISSING CREDENTIALS"}`,
  );

  try {
    const allTraders: ParsedTrader[] = [];
    let skippedDust = 0;

    // ── Steps 1-2: trade history via Helius (requires poolAddress) ────────────
    if (job.poolAddress && heliusOk) {
      console.log(`${LOG} Step 1 — paginating pool sigs: ${job.poolAddress}`);
      let before: string | undefined;
      let pageSigs: string[] = [];

      // Reduced from 6 pages → 3 pages (3000 sigs max) to conserve Helius CUs
      for (let page = 0; page < 3; page++) {
        if (!_consumeHC(1, `WalletWorker/getSignaturesForAddress pool page ${page}`)) break;
        const batch = await rpc<Array<{ signature: string; err: unknown }>>(
          "getSignaturesForAddress", [job.poolAddress, { limit: 1000, before, commitment: "confirmed" }],
        );
        if (!Array.isArray(batch) || batch.length === 0) { console.log(`${LOG}   page ${page}: empty`); break; }
        console.log(`${LOG}   page ${page}: ${batch.length} sigs`);
        pageSigs.push(...batch.filter((s) => !s.err).map((s) => s.signature).filter(Boolean));
        if (batch.length < 1000) break;
        before = batch[batch.length - 1]?.signature;
        if (!before) break;
      }

      if (_consumeHC(1, "WalletWorker/getSignaturesForAddress pool recent")) {
        const recentResp = await rpc<Array<{ signature: string; err: unknown }>>(
          "getSignaturesForAddress", [job.poolAddress, { limit: 100, commitment: "confirmed" }],
        );
        const recentSigs = Array.isArray(recentResp)
          ? recentResp.filter((s) => !s.err).map((s) => s.signature).filter(Boolean)
          : [];
        pageSigs = Array.from(new Set([...pageSigs, ...recentSigs]));
      }

      const allSigs = Array.from(new Set(pageSigs.slice(0, 75)));
      console.log(`${LOG} Step 2 — parsing ${allSigs.length} sigs via Helius`);

      const seenSigs   = new Set<string>();
      const seenBuyers = new Set<string>();

      for (let i = 0; i < allSigs.length && allTraders.length < MAX_TRADERS; i += HELIUS_BATCH_SIZE) {
        const txs = await heliusParseTxs(allSigs.slice(i, i + HELIUS_BATCH_SIZE));
        for (const tx of txs) {
          if (!tx.signature || seenSigs.has(tx.signature)) continue;
          seenSigs.add(tx.signature);
          if (seenBuyers.size < MAX_BUYERS) {
            for (const b of extractBuyers(tx, job.tokenAddress, job.poolAddress!)) {
              if (seenBuyers.has(b.walletAddress)) continue;
              if (b.amountSol < MIN_SOL_THRESHOLD) { skippedDust++; continue; }
              seenBuyers.add(b.walletAddress);
              allTraders.push(b);
            }
          }
          for (const s of extractSellers(tx, job.tokenAddress, job.poolAddress!)) {
            allTraders.push(s);
          }
        }
      }
      result.skippedDust = skippedDust;
      console.log(
        `${LOG} Step 2 done — ` +
        `buys=${allTraders.filter((t) => t.actionType === "buy").length} ` +
        `sells=${allTraders.filter((t) => t.actionType === "sell").length}`,
      );
    } else {
      console.log(`${LOG} Steps 1-2 SKIPPED — ${job.poolAddress ? "no Helius key" : "no poolAddress"}`);
    }

    // ── Step 3: top holders (always runs, fills gaps when pool data absent) ───
    const holderTraders = await collectSignificantHolders(
      job,
      new Set(allTraders.map((t) => t.walletAddress)),
      result.errors,
    );
    allTraders.push(...holderTraders);

    console.log(`${LOG} Total traders collected: ${allTraders.length}`);
    if (allTraders.length === 0) {
      // AUDIT FIX (2026-07-08): log the specific reason so zero-trader "done"
      // jobs are diagnosable in Railway logs instead of silently disappearing.
      const zeroReason = !job.poolAddress
        ? 'no poolAddress — Steps 1-2 skipped; token may be too new for a pool to exist yet'
        : !heliusOk
        ? 'Helius key missing — Steps 1-2 skipped; holder scan returned 0'
        : 'pool scan found 0 eligible swap transactions AND holder scan returned 0 significant holders';
      console.warn(
        `${LOG} ⚠ 0 traders — ${zeroReason}. ` +
        `token=${job.tokenAddress} pool=${job.poolAddress ?? 'none'} ` +
        `marketCap=${(job.marketCapUsd ?? 0).toFixed(0)} liq=${(job.liquidityUsd ?? 0).toFixed(0)}`,
      );
    }

    // ── Step 3b: fetch live token price ONCE for all wallets ─────────────────
    console.log(`${LOG} Step 3b — fetching token price from DexScreener…`);
    const priceData = await fetchTokenPrice(job.tokenAddress);

    // ── Step 3c: fetch SOL/USD rate for amount_usd computation ────────────────
    const solPriceUsd = await getSolPriceUsd();
    console.log(`${LOG} Step 3c — SOL/USD price: ${solPriceUsd}`);

    // ── Step 3d: fetch token creation time for token_age_at_entry ─────────────
    const tokenCreatedAt = job.tokenCreatedAt ?? await fetchTokenCreatedAt(job.tokenAddress);
    console.log(
      `${LOG} Step 3d — tokenCreatedAt: ${tokenCreatedAt ? new Date(tokenCreatedAt * 1000).toISOString() : "unknown"}`,
    );

    // ── Steps 4-6: persist to Supabase ───────────────────────────────────────
    await persistActivity(allTraders, job, result.errors, solPriceUsd, tokenCreatedAt);
    await persistWallets(allTraders, result.errors);
    await persistPerformanceHistory(allTraders, job, priceData, result.errors);

    // ── Step 6b: baseline raw metrics ─────────────────────────────────────────
    await persistRawMetricsBaseline(allTraders, job, result.errors);

    // Use unique wallet count for accurate reporting
    const uniqueBuyers  = new Set(allTraders.filter((t) => t.actionType === "buy").map((t) => t.walletAddress));
    const uniqueSellers = new Set(allTraders.filter((t) => t.actionType === "sell").map((t) => t.walletAddress));
    result.buyersCollected  = uniqueBuyers.size;
    result.sellersCollected = uniqueSellers.size;
    result.tradersCollected = new Set(allTraders.map((t) => t.walletAddress)).size;

    // ── Step 7: Transaction-driven enrichment (Phase 1 — priority queue) ────
    // runPriorityEnrichmentQueue replaces the old flat walletAddresses.slice
    // approach. It queries wallet_raw_tx_metrics for ALL holder_scan wallets
    // for this token (not just those collected this run), sorts them by
    // classification tier → total_sol_invested DESC, and enriches the top N
    // within the remaining hourly CU budget. Controlled by HELIUS_ENRICH_WALLETS
    // (default 0 = disabled). Set to e.g. 3 in Railway Variables to enable.
    if (getHeliusKey()) {
      void runPriorityEnrichmentQueue({
        tokenAddress: job.tokenAddress,
        priceData,
      }).then((r) => {
        console.log(
          `${LOG} Step 7 priority enrichment complete — ` +
          `enriched=${r.walletsEnriched} skipped=${r.walletsSkipped} ` +
          `truncated=${r.walletsTruncated} errors=${r.errors.length} ` +
          `duration=${r.durationMs}ms`,
        );
      }).catch((err: unknown) => {
        console.error(
          `${LOG} Step 7 background error: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      console.log(`${LOG} Step 7 priority enrichment queue launched in background`);
    }

    console.log(`${LOG} ═══ collect() DONE — traders=${result.tradersCollected} errors=${result.errors.length}`);
  } catch (err) {
    const msg = `Unhandled error in collect(): ${err instanceof Error ? err.message : String(err)}`;
    console.error(`${LOG} ✗ ${msg}`, err);
    result.errors.push(msg);
  }

  return result;
}
