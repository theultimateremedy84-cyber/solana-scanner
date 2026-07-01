// =============================================================================
// Wallet Enricher  (Phase 1 v3 — Transaction-Driven Wallet Intelligence)
//
// Three architectural guarantees vs v1:
//
//   1. NEVER DEGRADE — existing wallet data is only upgraded, never
//      overwritten with lower-quality or contradictory data.
//      Enforced via a data_source quality ranking system:
//        holder_scan (0)  <  pool_extraction (1)  <  helius_full_history (2)
//      A wallet at tier 2 is never overwritten by tier 0 or 1 data.
//      Within the same tier, position_status only moves forward
//      (UNKNOWN → OPEN → PARTIALLY_CLOSED → CLOSED).
//
//   2. STORE EVERY TRADE PERMANENTLY — wallet_token_activity holds all
//      raw transactions (idempotent by signature). wallet_raw_tx_metrics
//      holds aggregated raw counts/volumes so future analytics can
//      re-compute P&L and scores without re-scanning the blockchain.
//
//   3. SEPARATE RAW METRICS FROM SCORING — wallet_raw_tx_metrics stores
//      ONLY what is directly computable from blockchain transactions
//      (buy/sell counts, SOL invested/received, token amounts).
//      wallet_performance_history stores computed P&L.
//      wallets stores intelligence scores.
//      Changing the scoring formula only touches wallets — no blockchain
//      re-scan required.
//
// PATCH NOTES (scoring-patch v1):
//   BUG-FIX token_age_at_entry: was hardcoded null; now computed from
//            tokenCreatedAt (fetched from wallet_collection_jobs) vs trade ts.
//   BUG-FIX classifyWallets holder_scan: holder_scan wallets with buy/sell
//            activity now get hasTransactionEvidence=true, enabling "retail"
//            and "bot" classification instead of always "unknown".
//   EXPORT   classifyWallets is now exported for use by wallet-rescoring.ts.
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import { getSupabase, getHeliusKey, getRpcUrl } from "./wallet-collection-worker";
import { reconstructWalletPosition } from "./tx-reconstructor";
import { classifyWallet } from "./wallet-classifier";
import type { TokenPriceData } from "./wallet-collection.types";

const LOG = "[WalletEnricher]";

// ---------------------------------------------------------------------------
// Data quality tiers — monotonically increasing, never reversed
// ---------------------------------------------------------------------------

const SOURCE_RANK: Record<string, number> = {
  holder_scan:         0,
  pool_extraction:     1,
  helius_full_history: 2,
};
const ENRICHER_SOURCE = "helius_full_history" as const;
const ENRICHER_RANK   = SOURCE_RANK[ENRICHER_SOURCE]!; // 2

/** Position status upgrade order — status only moves right, never left. */
const POSITION_RANK: Record<string, number> = {
  UNKNOWN:          0,
  OPEN:             1,
  PARTIALLY_CLOSED: 2,
  CLOSED:           3,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EnrichmentResult {
  tokenAddress:    string;
  walletsEnriched: number;
  walletsSkipped:  number;
  tradesInserted:  number;
  errors:          string[];
  durationMs:      number;
}

interface ExistingPerfRow {
  position_status:             string | null;
  initial_investment:          number | null;
  peak_roi:                    number | null;
  peak_position_value_sol:     number | null;
  reached_100k_mc_at:          string | null;
  reached_500k_mc_at:          string | null;
  reached_1m_mc_at:            string | null;
  reached_5m_mc_at:            string | null;
  reached_10m_mc_at:           string | null;
  reached_50m_mc_at:           string | null;
}

interface ExistingRawRow {
  data_source: string | null;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Enrich wallet intelligence data for a specific token by reconstructing
 * each wallet's complete on-chain transaction history.
 *
 * Honouring all three guarantees:
 *   1. Never degrade — data quality rank is monotonically increasing.
 *   2. Store every trade — wallet_token_activity (by sig) + wallet_raw_tx_metrics.
 *   3. Separate raw metrics from scoring — three distinct DB writes.
 */
export async function enrichWalletsForToken(opts: {
  tokenAddress:     string;
  walletAddresses?: string[];
  priceData:        TokenPriceData;
  maxWallets?:      number;
  delayMs?:         number;
}): Promise<EnrichmentResult> {
  const { tokenAddress, priceData, maxWallets = 10, delayMs = 1000 } = opts;
  const startTime = Date.now();
  const result: EnrichmentResult = {
    tokenAddress, walletsEnriched: 0, walletsSkipped: 0,
    tradesInserted: 0, errors: [], durationMs: 0,
  };

  const heliusKey = getHeliusKey();
  if (!heliusKey) {
    result.errors.push("HELIUS_API_KEY not set — enrichment requires Helius");
    result.durationMs = Date.now() - startTime;
    return result;
  }

  const sb = getSupabase();
  if (!sb) {
    result.errors.push("Supabase unavailable");
    result.durationMs = Date.now() - startTime;
    return result;
  }

  const rpcUrl = getRpcUrl();

  // ── Fetch token creation time for token_age_at_entry computation ─────────
  // BUG-FIX: token_age_at_entry was always null because no timestamp was threaded in.
  const tokenCreatedAt = await fetchTokenCreatedAt(sb, tokenAddress);

  // ── Resolve wallet list ──────────────────────────────────────────────────
  let walletAddresses = opts.walletAddresses ?? [];
  if (walletAddresses.length === 0) {
    walletAddresses = await fetchWalletsForToken(sb, tokenAddress, maxWallets * 2, result.errors);
  }
  const toProcess = walletAddresses.slice(0, maxWallets);

  if (toProcess.length === 0) {
    console.log(`${LOG} No wallets to enrich for ${tokenAddress.slice(0, 8)}…`);
    result.durationMs = Date.now() - startTime;
    return result;
  }

  console.log(
    `${LOG} ═══ Starting enrichment\n` +
    `${LOG}   token   : ${tokenAddress}\n` +
    `${LOG}   wallets : ${toProcess.length}\n` +
    `${LOG}   priceSol: ${priceData.priceSol ?? "N/A"}\n` +
    `${LOG}   tokenCreatedAt: ${tokenCreatedAt ? new Date(tokenCreatedAt * 1000).toISOString() : "unknown"}`,
  );

  // ── Pre-fetch existing data (one query each) — avoids N+1 in the loop ───
  const [existingPerfMap, existingRawMap] = await Promise.all([
    fetchExistingPerfRows(sb, tokenAddress, toProcess),
    fetchExistingRawRows(sb,  tokenAddress, toProcess),
  ]);

  // ── Process each wallet sequentially (respect Helius rate limits) ────────
  for (let i = 0; i < toProcess.length; i++) {
    const walletAddress = toProcess[i]!;
    const existingPerf  = existingPerfMap.get(walletAddress);
    const existingRaw   = existingRawMap.get(walletAddress);

    // ── Guarantee 1: never overwrite a helius_full_history row with Helius ──
    const existingSourceRank = SOURCE_RANK[existingRaw?.data_source ?? "holder_scan"] ?? 0;
    const willUpgrade        = existingSourceRank < ENRICHER_RANK;
    const willRefresh        = existingSourceRank === ENRICHER_RANK;

    try {
      const position = await reconstructWalletPosition({
        walletAddress,
        tokenAddress,
        heliusApiKey:       heliusKey,
        heliusRpcUrl:       rpcUrl,
        currentPriceSol:    priceData.priceSol,
        existingPeakRoi:    existingPerf?.peak_roi ?? null,
        existingPeakPosSol: existingPerf?.peak_position_value_sol ?? null,
        maxSignaturePages:  2,  // Reduced from 5 → 2 (max 2000 sigs per wallet)
      });

      if (!position.hasTransactionEvidence) {
        // Helius found no token-related txs for this wallet.
        // Keep existing data intact — do NOT clear it.
        result.walletsSkipped++;
        console.log(
          `${LOG} ${walletAddress.slice(0, 8)}… no tx evidence — ` +
          `preserving existing ${existingRaw?.data_source ?? "holder_scan"} data`,
        );
        continue;
      }

      // ── Guarantee 2a: store every trade in wallet_token_activity ─────────
      const inserted = await upsertActivityRows(
        sb, position, tokenAddress, tokenCreatedAt, result.errors,
      );
      result.tradesInserted += inserted;

      // ── Guarantee 2b + 3: store raw aggregates in wallet_raw_tx_metrics ──
      // Only write if our data is >= existing quality (never downgrade).
      if (willUpgrade || willRefresh) {
        await upsertRawMetrics(sb, position, tokenAddress, result.errors);
      }

      // ── Guarantee 1: never-degrade upsert for wallet_performance_history ─
      await upsertPerformanceRow(sb, position, priceData, existingPerf, result.errors);

      // ── Update wallets table with basic per-token stats ───────────────────
      await updateWalletStats(sb, position, result.errors);

      result.walletsEnriched++;
    } catch (err) {
      const msg = `wallet ${walletAddress.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`${LOG} ✗ ${msg}`);
      result.errors.push(msg);
    }

    if (i < toProcess.length - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  // ── Guarantee 3: classify from raw metrics (not from P&L estimates) ──────
  const classifiedCount = await classifyWallets(sb, toProcess, tokenAddress, result.errors);
  console.log(`${LOG} Classified ${classifiedCount} wallets`);

  result.durationMs = Date.now() - startTime;
  console.log(
    `${LOG} ═══ Done — enriched=${result.walletsEnriched} ` +
    `skipped=${result.walletsSkipped} trades_inserted=${result.tradesInserted} ` +
    `errors=${result.errors.length} duration=${result.durationMs}ms`,
  );
  return result;
}

// ---------------------------------------------------------------------------
// Pre-fetchers
// ---------------------------------------------------------------------------

async function fetchWalletsForToken(
  sb:           ReturnType<typeof createClient>,
  tokenAddress: string,
  limit:        number,
  errors:       string[],
): Promise<string[]> {
  const { data, error } = await sb
    .from("wallet_performance_history")
    .select("wallet_address")
    .eq("token_address", tokenAddress)
    .limit(limit);
  if (error) { errors.push(`fetchWallets: ${error.message}`); return []; }
  const seen = new Set<string>();
  const addrs: string[] = [];
  for (const row of data ?? []) {
    const a = row.wallet_address as string;
    if (!seen.has(a)) { seen.add(a); addrs.push(a); }
  }
  return addrs;
}

async function fetchExistingPerfRows(
  sb:              ReturnType<typeof createClient>,
  tokenAddress:    string,
  walletAddresses: string[],
): Promise<Map<string, ExistingPerfRow>> {
  const map = new Map<string, ExistingPerfRow>();
  try {
    const { data } = await sb
      .from("wallet_performance_history")
      .select(
        "wallet_address, position_status, initial_investment, " +
        "peak_roi, peak_position_value_sol, " +
        "reached_100k_mc_at, reached_500k_mc_at, reached_1m_mc_at, " +
        "reached_5m_mc_at, reached_10m_mc_at, reached_50m_mc_at",
      )
      .eq("token_address", tokenAddress)
      .in("wallet_address", walletAddresses.slice(0, 500));
    for (const row of data ?? []) {
      map.set(row.wallet_address as string, row as ExistingPerfRow);
    }
  } catch { /* non-fatal — peaks start fresh */ }
  return map;
}

async function fetchExistingRawRows(
  sb:              ReturnType<typeof createClient>,
  tokenAddress:    string,
  walletAddresses: string[],
): Promise<Map<string, ExistingRawRow>> {
  const map = new Map<string, ExistingRawRow>();
  try {
    const { data } = await sb
      .from("wallet_raw_tx_metrics")
      .select("wallet_address, data_source")
      .eq("token_address", tokenAddress)
      .in("wallet_address", walletAddresses.slice(0, 500));
    for (const row of data ?? []) {
      map.set(row.wallet_address as string, { data_source: row.data_source as string });
    }
  } catch { /* table may not exist yet — non-fatal */ }
  return map;
}

/**
 * Fetch when the token was first seen / created, for token_age_at_entry.
 * Tries wallet_collection_jobs first, falls back to scan_history.
 * Returns a Unix timestamp (seconds) or null if unavailable.
 *
 * BUG-FIX: previously token_age_at_entry was always hardcoded null.
 */
async function fetchTokenCreatedAt(
  sb:           ReturnType<typeof createClient>,
  tokenAddress: string,
): Promise<number | null> {
  // Attempt 1: wallet_collection_jobs.token_created_at
  try {
    const { data: jobRows } = await sb
      .from("wallet_collection_jobs")
      .select("token_created_at, created_at")
      .eq("token_address", tokenAddress)
      .order("created_at", { ascending: true })
      .limit(1);
    const row = jobRows?.[0];
    if (row) {
      const ts =
        (row.token_created_at as string | null) ??
        (row.created_at as string | null);
      if (ts) return Math.floor(new Date(ts).getTime() / 1000);
    }
  } catch { /* non-fatal */ }

  // Attempt 2: scan_history table
  try {
    const { data: scanRows } = await sb
      .from("scan_history")
      .select("token_created_at, created_at")
      .eq("token_address", tokenAddress)
      .order("created_at", { ascending: true })
      .limit(1);
    const row = scanRows?.[0];
    if (row) {
      const ts =
        (row.token_created_at as string | null) ??
        (row.created_at as string | null);
      if (ts) return Math.floor(new Date(ts).getTime() / 1000);
    }
  } catch { /* non-fatal */ }

  return null;
}

// ---------------------------------------------------------------------------
// Guarantee 2a — wallet_token_activity (every trade, idempotent by sig)
// ---------------------------------------------------------------------------

async function upsertActivityRows(
  sb:              ReturnType<typeof createClient>,
  position:        Awaited<ReturnType<typeof reconstructWalletPosition>>,
  tokenAddress:    string,
  tokenCreatedAt:  number | null,  // Unix seconds — for token_age_at_entry
  errors:          string[],
): Promise<number> {
  if (position.trades.length === 0) return 0;

  const rows = position.trades.map((t) => {
    // BUG-FIX: compute token_age_at_entry from trade timestamp vs token creation.
    // Stored as seconds (age of token when the trade happened).
    let tokenAgeAtEntry: number | null = null;
    if (tokenCreatedAt != null && t.timestamp > tokenCreatedAt) {
      tokenAgeAtEntry = t.timestamp - tokenCreatedAt;
    }

    return {
      wallet_address:        position.walletAddress,
      token_address:         tokenAddress,
      transaction_signature: t.signature,
      action_type:           t.actionType,
      amount_sol:            t.amountSol,
      amount_usd:            null,  // USD at tx time unavailable without a price oracle
      token_amount:          t.tokenAmount,
      timestamp:             new Date(t.timestamp * 1000).toISOString(),
      entry_market_cap:      null,  // not available from wallet-level history
      liquidity_at_entry:    null,
      holder_count_at_entry: null,
      token_age_at_entry:    tokenAgeAtEntry,
    };
  });

  let inserted = 0;
  const CHUNK = 100;
  for (let i = 0; i < rows.length; i += CHUNK) {
    // ignoreDuplicates: true — transaction_signature is unique; idempotent
    const { data, error } = await sb
      .from("wallet_token_activity")
      .upsert(rows.slice(i, i + CHUNK), { onConflict: "transaction_signature", ignoreDuplicates: true })
      .select("id");
    if (error) {
      errors.push(`activity upsert ${position.walletAddress.slice(0, 8)}: ${error.message}`);
    } else {
      inserted += data?.length ?? 0;
    }
  }
  return inserted;
}

// ---------------------------------------------------------------------------
// Guarantee 2b + 3 — wallet_raw_tx_metrics (raw blockchain aggregates)
// ---------------------------------------------------------------------------

async function upsertRawMetrics(
  sb:           ReturnType<typeof createClient>,
  position:     Awaited<ReturnType<typeof reconstructWalletPosition>>,
  tokenAddress: string,
  errors:       string[],
): Promise<void> {
  const row: Record<string, unknown> = {
    wallet_address:           position.walletAddress,
    token_address:            tokenAddress,
    total_buy_txs:            position.trades.filter((t) => t.actionType === "buy").length,
    total_sell_txs:           position.trades.filter((t) => t.actionType === "sell").length,
    total_tokens_bought:      position.totalTokensBought,
    total_tokens_sold:        position.totalTokensSold,
    total_sol_invested:       position.initialInvestment,
    total_sol_received:       position.totalSolReceived,
    current_token_balance:    position.currentTokenBalance,
    data_source:              ENRICHER_SOURCE,
    total_signatures_scanned: null, // not currently tracked in ReconstructedPosition
    first_tx_at:              position.firstTradeTs
      ? new Date(position.firstTradeTs * 1000).toISOString()
      : null,
    last_tx_at:               position.lastTradeTs
      ? new Date(position.lastTradeTs * 1000).toISOString()
      : null,
    last_scanned_at:          new Date().toISOString(),
  };

  const { error } = await sb
    .from("wallet_raw_tx_metrics")
    .upsert(row, { onConflict: "wallet_address,token_address", ignoreDuplicates: false });

  if (error) {
    // Non-fatal if the migration hasn't been applied yet (table doesn't exist).
    if (error.message.includes("does not exist") || error.message.includes("relation")) {
      console.warn(`${LOG} wallet_raw_tx_metrics table not found — apply migration first`);
    } else {
      errors.push(`raw_metrics upsert ${position.walletAddress.slice(0, 8)}: ${error.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Guarantee 1 — never-degrade upsert for wallet_performance_history
// ---------------------------------------------------------------------------

async function upsertPerformanceRow(
  sb:           ReturnType<typeof createClient>,
  position:     Awaited<ReturnType<typeof reconstructWalletPosition>>,
  priceData:    TokenPriceData,
  existing:     ExistingPerfRow | undefined,
  errors:       string[],
): Promise<void> {
  const scanTime = new Date().toISOString();
  const mcap = priceData.marketCapUsd;

  // ── Position status: only move forward in quality, never backward ──────
  const newStatusRank      = POSITION_RANK[position.positionStatus]      ?? 0;
  const existingStatusRank = POSITION_RANK[existing?.position_status ?? "UNKNOWN"] ?? 0;
  const finalStatus =
    newStatusRank >= existingStatusRank
      ? position.positionStatus
      : (existing?.position_status ?? position.positionStatus);

  // ── Initial investment: prefer non-zero data, prefer reconstruction ────
  const finalInvestment =
    position.initialInvestment > 0
      ? position.initialInvestment
      : (Number(existing?.initial_investment ?? 0) || position.initialInvestment);

  // ── Milestone timestamps: only SET once, never cleared ────────────────
  const milestoneTs = (
    flagIsReached: boolean,
    existingTs: string | null | undefined,
  ): string | null => {
    if (!flagIsReached) return existingTs ?? null;
    return existingTs ?? scanTime;
  };

  const reached100k  = mcap != null && mcap >= 100_000;
  const reached500k  = mcap != null && mcap >= 500_000;
  const reached1m    = mcap != null && mcap >= 1_000_000;
  const reached5m    = mcap != null && mcap >= 5_000_000;
  const reached10m   = mcap != null && mcap >= 10_000_000;
  const reached50m   = mcap != null && mcap >= 50_000_000;

  const row: Record<string, unknown> = {
    wallet_address:              position.walletAddress,
    token_address:               position.tokenAddress,

    // ── Raw aggregates (sourced from blockchain) ──
    initial_investment:          finalInvestment,
    current_value:               position.totalSolReceived,
    total_tokens_bought:         position.totalTokensBought,
    total_tokens_sold:           position.totalTokensSold,

    // ── Computed P&L ──
    position_status:             finalStatus,
    current_token_balance:       position.currentTokenBalance,
    current_position_value_sol:  position.currentPositionValueSol,
    current_token_price_sol:     priceData.priceSol    ?? null,
    current_token_price_usd:     priceData.priceUsd    ?? null,
    current_market_cap_usd:      mcap                  ?? null,
    realized_profit:             position.realizedProfit,
    unrealized_profit:           position.unrealizedProfit,
    roi_multiple:                position.roiMultiple,

    // ── Peaks: never decrease ──
    peak_roi:                    position.peakRoi,
    peak_position_value_sol:     position.peakPositionValueSol,

    // ── Milestone flags: never degrade ────────────────────────────────────
    reached_100k_mc: reached100k || (existing?.reached_100k_mc_at != null),
    reached_500k_mc: reached500k || (existing?.reached_500k_mc_at != null),
    reached_1m_mc:   reached1m   || (existing?.reached_1m_mc_at   != null),
    reached_5m_mc:   reached5m   || (existing?.reached_5m_mc_at   != null),
    reached_10m_mc:  reached10m  || (existing?.reached_10m_mc_at  != null),
    reached_50m_mc:  reached50m  || (existing?.reached_50m_mc_at  != null),

    // ── Milestone timestamps: stamp once, never clear ──────────────────
    reached_100k_mc_at: milestoneTs(reached100k, existing?.reached_100k_mc_at),
    reached_500k_mc_at: milestoneTs(reached500k, existing?.reached_500k_mc_at),
    reached_1m_mc_at:   milestoneTs(reached1m,   existing?.reached_1m_mc_at),
    reached_5m_mc_at:   milestoneTs(reached5m,   existing?.reached_5m_mc_at),
    reached_10m_mc_at:  milestoneTs(reached10m,  existing?.reached_10m_mc_at),
    reached_50m_mc_at:  milestoneTs(reached50m,  existing?.reached_50m_mc_at),

    last_updated: scanTime,
  };

  const { error } = await sb
    .from("wallet_performance_history")
    .upsert(row, { onConflict: "wallet_address,token_address", ignoreDuplicates: false });

  if (error) {
    errors.push(`perf upsert ${position.walletAddress.slice(0, 8)}: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// wallets table — basic per-token stats
// ---------------------------------------------------------------------------

async function updateWalletStats(
  sb:       ReturnType<typeof createClient>,
  position: Awaited<ReturnType<typeof reconstructWalletPosition>>,
  errors:   string[],
): Promise<void> {
  const patch: Record<string, unknown> = {
    total_buys:     position.trades.filter((t) => t.actionType === "buy").length,
    total_sells:    position.trades.filter((t) => t.actionType === "sell").length,
    realized_pnl:   position.realizedProfit,
    unrealized_pnl: position.unrealizedProfit,
    updated_at:     new Date().toISOString(),
  };

  if (position.firstTradeTs) {
    patch.first_seen_timestamp = new Date(position.firstTradeTs * 1000).toISOString();
  }
  if (position.lastTradeTs) {
    patch.last_seen_timestamp = new Date(position.lastTradeTs * 1000).toISOString();
  }

  const { error } = await sb
    .from("wallets")
    .update(patch)
    .eq("wallet_address", position.walletAddress);

  if (error) {
    console.warn(`${LOG} wallets update ${position.walletAddress.slice(0, 8)}: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Guarantee 3 — classify from wallet_raw_tx_metrics (not from P&L estimates)
// ---------------------------------------------------------------------------
//
// EXPORTED so wallet-rescoring.ts can call this directly for bulk re-scoring
// of all existing wallets without requiring a Helius re-scan.
//
// BUG-FIX (holder_scan classification):
//   Previously, holder_scan wallets where invested === 0 were given
//   hasTransactionEvidence = false, causing them to always classify as
//   "unknown" even when they had buy/sell transaction counts.
//
//   Fix: hasTransactionEvidence is now true when total_buy_txs > 0 OR
//   total_tokens_bought > 0, regardless of invested SOL amount.
//   This means holder_scan wallets that hold tokens will get "retail"
//   classification, and those with bot-like sell/buy ratios will get "bot".

export async function classifyWallets(
  sb:              ReturnType<typeof createClient>,
  walletAddresses: string[],
  tokenAddress:    string,
  errors:          string[],
): Promise<number> {
  // Read raw metrics across ALL tokens for these wallets (cross-token scoring)
  const { data: rawRows, error: rawErr } = await sb
    .from("wallet_raw_tx_metrics")
    .select(
      "wallet_address, token_address, data_source, " +
      "total_buy_txs, total_sell_txs, " +
      "total_tokens_bought, total_tokens_sold, " +
      "total_sol_invested, total_sol_received, current_token_balance",
    )
    .in("wallet_address", walletAddresses);

  // Fallback: if wallet_raw_tx_metrics doesn't exist yet, read from performance history
  const perfRows: Array<Record<string, unknown>> = [];
  if (rawErr || !rawRows?.length) {
    const { data: fallback } = await sb
      .from("wallet_performance_history")
      .select(
        "wallet_address, token_address, position_status, " +
        "initial_investment, current_value, realized_profit, unrealized_profit, " +
        "roi_multiple, total_tokens_bought, total_tokens_sold, current_position_value_sol",
      )
      .in("wallet_address", walletAddresses);
    perfRows.push(...(fallback ?? []));
  }

  // Group by wallet
  const byWallet = new Map<string, Array<Record<string, unknown>>>();
  const source = rawRows?.length ? rawRows : perfRows;
  for (const row of source) {
    const key = row.wallet_address as string;
    if (!byWallet.has(key)) byWallet.set(key, []);
    byWallet.get(key)!.push(row as Record<string, unknown>);
  }

  if (byWallet.size === 0) return 0;

  const updates: Record<string, unknown>[] = [];

  for (const [walletAddr, rows] of byWallet.entries()) {
    const usingRaw = rawRows?.length ? true : false;

    // Build positions array for the classifier
    const positions = rows.map((r) => {
      const tokensBought = Number(r.total_tokens_bought ?? 0);
      const tokensSold   = Number(r.total_tokens_sold   ?? 0);
      const invested     = Number(usingRaw ? r.total_sol_invested : r.initial_investment) ?? 0;
      const received     = Number(usingRaw ? r.total_sol_received : r.current_value)      ?? 0;
      const totalBuyTxs  = Number(usingRaw ? r.total_buy_txs      : tokensBought)         ?? 0;
      const balance      = Math.max(0, tokensBought - tokensSold);

      // Determine position status from raw metrics
      let posStatus: "OPEN" | "PARTIALLY_CLOSED" | "CLOSED" | "UNKNOWN";
      if (usingRaw) {
        const dataSource = r.data_source as string;
        if (dataSource === "holder_scan" && invested === 0) {
          // holder_scan with no SOL cost basis — position details unknown
          posStatus = "UNKNOWN";
        } else if (tokensSold === 0) {
          posStatus = "OPEN";
        } else if (tokensBought > 0 && tokensSold >= tokensBought * 0.95) {
          posStatus = "CLOSED";
        } else {
          posStatus = "PARTIALLY_CLOSED";
        }
      } else {
        posStatus = (r.position_status as typeof posStatus) ?? "UNKNOWN";
      }

      // BUG-FIX: holder_scan wallets with any buy/sell activity should have
      // hasTransactionEvidence = true so they can be classified (at minimum "retail").
      // Previously: hasTransactionEvidence = posStatus !== "UNKNOWN"
      // Now: also true when we have direct evidence of buy or sell transactions.
      const hasBuySellEvidence = totalBuyTxs > 0 || tokensBought > 0;
      const hasTransactionEvidence = posStatus !== "UNKNOWN" || hasBuySellEvidence;

      // Compute ROI from raw data (avoids relying on stored computed column)
      let roiMultiple: number | null = null;
      if (posStatus === "CLOSED" && invested > 0) {
        roiMultiple = received / invested;
      } else if (posStatus === "OPEN" && invested > 0) {
        // Unrealized ROI not computable here without current price — skip
        roiMultiple = null;
      }

      // Realized profit from raw data
      let realizedProfit = 0;
      if (posStatus === "CLOSED") {
        realizedProfit = received - invested;
      } else if (posStatus === "PARTIALLY_CLOSED" && tokensBought > 0) {
        const fracSold = tokensSold / tokensBought;
        realizedProfit = received - invested * fracSold;
      }

      return {
        walletAddress:           walletAddr,
        tokenAddress:            r.token_address as string,
        trades:                  [],
        totalTokensBought:       tokensBought,
        totalTokensSold:         tokensSold,
        initialInvestment:       invested,
        totalSolReceived:        received,
        currentTokenBalance:     balance,
        positionStatus:          posStatus,
        realizedProfit,
        unrealizedProfit:        0, // skip — no current price here
        roiMultiple,
        currentPositionValueSol: 0,
        peakRoi:                 null,
        peakPositionValueSol:    null,
        firstTradeTs:            null,
        lastTradeTs:             null,
        hasTransactionEvidence,
      };
    });

    const totalBuyTxs  = rows.reduce((s, r) =>
      s + Number(usingRaw ? r.total_buy_txs : (r.total_tokens_bought ?? 0)), 0);
    const totalSellTxs = rows.reduce((s, r) =>
      s + Number(usingRaw ? r.total_sell_txs : (r.total_tokens_sold ?? 0)), 0);
    const totalVolumeBoughtSol = rows.reduce((s, r) =>
      s + Number(usingRaw ? r.total_sol_invested : r.initial_investment), 0);
    const totalVolumeSoldSol   = rows.reduce((s, r) =>
      s + Number(usingRaw ? r.total_sol_received : r.current_value), 0);

    const scores = classifyWallet({
      positions,
      totalBuys:           totalBuyTxs,
      totalSells:          totalSellTxs,
      totalVolumeBoughtSol,
      totalVolumeSoldSol,
    });

    updates.push({
      wallet_address:        walletAddr,
      wallet_classification: scores.classification,
      intelligence_score:    scores.intelligenceScore,
      win_rate:              scores.winRate,
      average_roi:           scores.averageRoi,
      conviction_score:      scores.convictionScore,
      updated_at:            new Date().toISOString(),
    });
  }

  // Batch upsert — classification data only (no P&L overwrite)
  let classified = 0;
  const CHUNK = 100;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const { error } = await sb
      .from("wallets")
      .upsert(updates.slice(i, i + CHUNK), { onConflict: "wallet_address", ignoreDuplicates: false });
    if (error) {
      errors.push(`classifier upsert: ${error.message}`);
    } else {
      classified += updates.slice(i, i + CHUNK).length;
    }
  }
  return classified;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
