// =============================================================================
// Wallet Enricher  (Phase 1 v2 — Transaction-Driven Wallet Intelligence)
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
  const { tokenAddress, priceData, maxWallets = 30, delayMs = 400 } = opts;
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
    `${LOG}   priceSol: ${priceData.priceSol ?? "N/A"}`,
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
    // This function IS the helius_full_history producer. If the existing row
    // was already produced by us, check timestamps to decide whether to re-scan.
    // (Re-scanning is fine; idempotent writes are safe. We just log it.)
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
        maxSignaturePages:  5,
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
      const inserted = await upsertActivityRows(sb, position, tokenAddress, result.errors);
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

// ---------------------------------------------------------------------------
// Guarantee 2a — wallet_token_activity (every trade, idempotent by sig)
// ---------------------------------------------------------------------------

async function upsertActivityRows(
  sb:           ReturnType<typeof createClient>,
  position:     Awaited<ReturnType<typeof reconstructWalletPosition>>,
  tokenAddress: string,
  errors:       string[],
): Promise<number> {
  if (position.trades.length === 0) return 0;

  const rows = position.trades.map((t) => ({
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
    token_age_at_entry:    null,
  }));

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
    // Log the warning but continue — wallet_token_activity still has the raw trades.
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
  // If reconstruction found buys (investment > 0) → use it (more complete).
  // If reconstruction found 0 but existing has data → keep existing.
  const finalInvestment =
    position.initialInvestment > 0
      ? position.initialInvestment
      : (Number(existing?.initial_investment ?? 0) || position.initialInvestment);

  // ── Peaks: monotonically non-decreasing ───────────────────────────────
  // (Already computed in reconstructWalletPosition using existingPeakRoi)
  // No additional logic needed — position.peakRoi already contains the max.

  // ── Milestone timestamps: only SET once, never cleared ────────────────
  // Use existing timestamp if already set; use scanTime only when newly reached.
  const milestoneTs = (
    flagIsReached: boolean,
    existingTs: string | null | undefined,
  ): string | null => {
    if (!flagIsReached) return existingTs ?? null; // flag not reached — preserve existing
    return existingTs ?? scanTime;                  // already stamped → keep it; new → stamp now
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

    // ── Raw aggregates (sourced from blockchain, protected by raw_metrics table) ──
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
    // A flag stays TRUE forever once reached. We use the existing timestamp
    // as the canonical "was previously reached" signal — if a timestamp is
    // already set, the flag must remain true even if current mcap dropped.
    reached_100k_mc: reached100k || (existing?.reached_100k_mc_at != null),
    reached_500k_mc: reached500k || (existing?.reached_500k_mc_at != null),
    reached_1m_mc:   reached1m   || (existing?.reached_1m_mc_at   != null),
    reached_5m_mc:   reached5m   || (existing?.reached_5m_mc_at   != null),
    reached_10m_mc:  reached10m  || (existing?.reached_10m_mc_at  != null),
    reached_50m_mc:  reached50m  || (existing?.reached_50m_mc_at  != null),

    // ── Milestone timestamps: stamp once, never clear ──────────────────
    // milestoneTs returns: existing ts if already set; scanTime if newly
    // reached; null if not yet reached at all.
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

async function classifyWallets(
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
      const balance      = Math.max(0, tokensBought - tokensSold);

      // Determine position status from raw metrics
      let posStatus: "OPEN" | "PARTIALLY_CLOSED" | "CLOSED" | "UNKNOWN";
      if (usingRaw) {
        const source = r.data_source as string;
        if (source === "holder_scan" && invested === 0) {
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
        hasTransactionEvidence:  posStatus !== "UNKNOWN",
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
