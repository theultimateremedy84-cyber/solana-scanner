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
import { getSupabase, getHeliusKey, getRpcUrl, getSolPriceUsd } from "./wallet-collection-worker";
import { reconstructWalletPosition, guardRoiMultiple } from "./tx-reconstructor";
import { classifyWallet, computeConfidenceTier } from "./wallet-classifier";
import { indexWalletSolTransfers } from "./sol-transfer-indexer";
import type { TokenPriceData } from "./wallet-collection.types";

// ---------------------------------------------------------------------------
// SOL transfer indexing — gated to high-value wallets.
//
// WHY GATED: indexWalletSolTransfers() costs Helius credits per wallet.
// We only index wallets where fund-distribution tracing is valuable.
//
// Gate opens when a wallet meets ANY of these criteria:
//   (a) classification is whale | smart_money | sniper  — explicitly high-value
//   (b) intelligence_score >= SOL_TRANSFER_INDEX_MIN_SCORE — high-scoring wallets
//       not yet promoted to a named classification (common when a wallet has only
//       1-2 tokens traded: enough to score well but below multi-token thresholds)
//
// FIX: previously only (a) with whale|smart_money, which matched ≤ 8 wallets
// in the entire DB (0.3% gate open rate) → 0 rows in wallet_sol_transfers.
// ---------------------------------------------------------------------------
const SOL_TRANSFER_INDEX_CLASSIFICATIONS = new Set(["whale", "smart_money", "sniper"]);
const SOL_TRANSFER_INDEX_MIN_SCORE       = 0.45;  // also gate on intelligence_score

const LOG = "[WalletEnricher]";

// ---------------------------------------------------------------------------
// Concurrency — how many wallets to process in parallel within a token batch.
// Controlled via ENRICHER_CONCURRENCY env var (default 5).
// At concurrency=5 and ~2-3s per Helius call, throughput is ~6,000-9,000/hr.
// Safe up to ~10 on a 950k CU/day Helius plan (well under RPS limits).
// ---------------------------------------------------------------------------
// Clamped to [1, 10]: guards against a bad/missing env var producing NaN
// (which would make the chunking loop not advance) or an accidentally huge
// value that fans out too many simultaneous Helius + Supabase calls.
const ENRICHER_CONCURRENCY = Math.min(
  10,
  Math.max(1, parseInt(process.env.ENRICHER_CONCURRENCY ?? "5", 10) || 5),
);

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
  // BUG-FIX (audit-5 OPEN/zero-balance mismatch): needed so current_token_balance
  // can be preserved in lockstep with position_status instead of being
  // unconditionally overwritten by a possibly-partial rescan.
  current_token_balance:       number | null;
  // PATCH FIX (roi-never-degrade): fields needed to preserve existing computed values
  roi_multiple:                number | null;
  realized_profit:             number | null;
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
  const [existingPerfMap, existingRawMap, classificationMap] = await Promise.all([
    fetchExistingPerfRows(sb, tokenAddress, toProcess),
    fetchExistingRawRows(sb,  tokenAddress, toProcess),
    fetchWalletClassifications(sb, toProcess),
  ]);

  // ── Process wallets in parallel chunks ───────────────────────────────────
  // Each chunk of ENRICHER_CONCURRENCY wallets runs concurrently via Promise.all.
  // delayMs (if > 0) is applied between chunks, not between individual wallets,
  // giving Helius a brief breath between bursts without killing throughput.
  //
  // JS is single-threaded: concurrent promises interleave at await points only,
  // so shared result counters (walletsEnriched, tradesInserted, etc.) are safe
  // to mutate without locks — no actual data race is possible.
  const processWallet = async (walletAddress: string): Promise<void> => {
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
        //
        // BUG-FIX (hollow-wallet infinite loop): previously we just `continue`d
        // here without writing anything to wallet_raw_tx_metrics. Because
        // find_hollow_pairs returns pairs NOT IN wallet_raw_tx_metrics WHERE
        // data_source='helius_full_history', these wallets would be returned
        // again on every subsequent tick and re-queried against Helius forever.
        //
        // Fix: write a zero-evidence helius_full_history row so find_hollow_pairs
        // permanently removes this pair from its result set. The row carries no
        // P&L data, but it marks the pair as "Helius-verified empty" and costs
        // one Supabase upsert per wallet. Existing wallet_performance_history
        // data is never touched.
        if (willUpgrade || willRefresh) {
          const { error: markErr } = await sb
            .from("wallet_raw_tx_metrics")
            .upsert({
              wallet_address:           walletAddress,
              token_address:            tokenAddress,
              data_source:              "helius_full_history",
              has_evidence:             false,   // tombstone — no pump.fun swaps found
              total_buy_txs:            0,
              total_sell_txs:           0,
              total_sol_invested:       0,
              total_sol_received:       0,
              total_tokens_bought:      0,
              total_tokens_sold:        0,
              current_token_balance:    0,
              total_signatures_scanned: 0,
              last_scanned_at:          new Date().toISOString(),
            }, { onConflict: "wallet_address,token_address" });
          if (markErr) {
            console.warn(
              `${LOG} ${walletAddress.slice(0, 8)}… failed to mark no-evidence row: ${markErr.message}`,
            );
          }
        }
        result.walletsSkipped++;
        console.log(
          `${LOG} ${walletAddress.slice(0, 8)}… no tx evidence — ` +
          `marked helius_full_history (won't re-scan); ` +
          `preserving existing ${existingRaw?.data_source ?? "holder_scan"} data`,
        );
        return;
      }

      // ── Guarantee 2a: store every trade in wallet_token_activity ─────────
      // FIX (2026-07-12 data-quality audit): this path had no SOL/USD price at
      // all (comment previously said "unavailable without a price oracle"),
      // even though wallet-collection-worker.ts already has a cached
      // getSolPriceUsd() a few lines of plumbing away. Reuses the same 10-min
      // cache, so this adds no extra network calls in the common case.
      const solPriceUsd = await getSolPriceUsd();
      const inserted = await upsertActivityRows(
        sb, position, tokenAddress, tokenCreatedAt, result.errors, solPriceUsd,
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

      // ── Chapter 8 / fund-distribution prerequisite: index raw SOL transfers ──
      // Gate: classification in {whale,smart_money,sniper} OR score >= 0.45.
      // See SOL_TRANSFER_INDEX_CLASSIFICATIONS and SOL_TRANSFER_INDEX_MIN_SCORE.
      // Best-effort: never allowed to fail or slow down the core enrichment
      // guarantees above. Swallows its own errors.
      const gatingData = classificationMap.get(walletAddress);
      const shouldIndexSolTransfers =
        (gatingData?.classification != null &&
          SOL_TRANSFER_INDEX_CLASSIFICATIONS.has(gatingData.classification)) ||
        (gatingData?.intelligenceScore != null &&
          gatingData.intelligenceScore >= SOL_TRANSFER_INDEX_MIN_SCORE);
      if (shouldIndexSolTransfers) {
        try {
          const solResult = await indexWalletSolTransfers(walletAddress);
          if (solResult.errors.length > 0) {
            console.warn(
              `${LOG} sol-transfer-index ${walletAddress.slice(0, 8)}… ` +
              `errors: ${solResult.errors.join("; ")}`,
            );
          } else if (solResult.transfersStored > 0) {
            console.log(
              `${LOG} sol-transfer-index ${walletAddress.slice(0, 8)}… ` +
              `(${gatingData?.classification ?? "score-gated"}): stored ${solResult.transfersStored} transfers`,
            );
          }
        } catch (solErr) {
          console.warn(
            `${LOG} sol-transfer-index ${walletAddress.slice(0, 8)}… threw: ` +
            `${solErr instanceof Error ? solErr.message : String(solErr)}`,
          );
        }
      }

      result.walletsEnriched++;
    } catch (err) {
      const msg = `wallet ${walletAddress.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`${LOG} ✗ ${msg}`);
      result.errors.push(msg);
    }
  };

  for (let i = 0; i < toProcess.length; i += ENRICHER_CONCURRENCY) {
    const chunk = toProcess.slice(i, i + ENRICHER_CONCURRENCY);
    await Promise.all(chunk.map(processWallet));
    if (i + ENRICHER_CONCURRENCY < toProcess.length && delayMs > 0) {
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
        "wallet_address, position_status, initial_investment, current_token_balance, " +
        // PATCH FIX (roi-never-degrade): fetch existing computed values so we
        // can preserve them when the reconstructor produces a null (e.g. airdropped
        // tokens where no direct SOL buy is found in Helius history).
        "roi_multiple, realized_profit, " +
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

interface WalletGatingData {
  classification:    string | null;
  intelligenceScore: number | null;
}

/**
 * Fetch each wallet's existing classification AND intelligence_score so the
 * SOL-transfer indexer gate can open on either high classification or high score.
 *
 * FIX: was only returning wallet_classification. Adding intelligence_score lets
 * high-scoring wallets (>= SOL_TRANSFER_INDEX_MIN_SCORE) get their SOL transfers
 * indexed even when they're classified "retail" due to limited cross-token data.
 *
 * Non-fatal on failure — gating defaults to "don't index".
 */
async function fetchWalletClassifications(
  sb:              ReturnType<typeof createClient>,
  walletAddresses: string[],
): Promise<Map<string, WalletGatingData>> {
  const map = new Map<string, WalletGatingData>();
  try {
    const { data } = await sb
      .from("wallets")
      .select("wallet_address, wallet_classification, intelligence_score")
      .in("wallet_address", walletAddresses.slice(0, 500));
    for (const row of data ?? []) {
      map.set(row.wallet_address as string, {
        classification:    row.wallet_classification as string | null,
        intelligenceScore: row.intelligence_score    as number | null,
      });
    }
  } catch { /* non-fatal — sol-transfer indexing simply skipped this run */ }
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
  solPriceUsd:     number | null = null,
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
      amount_usd:            (solPriceUsd != null && t.amountSol > 0)
        ? Math.round(t.amountSol * solPriceUsd * 100) / 100
        : null,
      sol_price_usd_at_trade: solPriceUsd ?? null,
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
    has_evidence:             true,  // real on-chain data (not a tombstone)
    total_signatures_scanned: position.signaturesScanned,
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
  const statusPreserved    = newStatusRank < existingStatusRank;
  const finalStatus =
    !statusPreserved
      ? position.positionStatus
      : (existing?.position_status ?? position.positionStatus);

  // BUG-FIX (audit-5 OPEN/zero-balance mismatch):
  //   current_token_balance used to be unconditionally overwritten with this
  //   run's reconstructed value even when the position_status above was
  //   PRESERVED (i.e. this run's data ranked lower and was discarded). That
  //   let a later, partial/incomplete rescan (e.g. Helius signature-page cap)
  //   silently zero out the balance for a wallet whose status was still
  //   correctly protected at OPEN — producing exactly the OPEN + balance=0
  //   rows found in the audit. Now the balance follows the same rule as the
  //   status: if the status was preserved (not upgraded), the balance is
  //   preserved too, so the two columns can never drift apart.
  const finalBalance =
    !statusPreserved
      ? position.currentTokenBalance
      : (existing?.current_token_balance ?? position.currentTokenBalance);

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
    // BUG-FIX (total_sol_received always 0): this upsert runs far more often
    // than wallet-collection-worker's persistPerformanceHistory (20-min rescore
    // scheduler + 30-min enrich-unenriched scheduler touch nearly all wallets),
    // so it dominates the row's final state. It wrote current_value but never
    // total_sol_received, leaving the column at its table default (0) for
    // every wallet this path ever touched — 864/864 rows were affected.
    total_sol_received:          position.totalSolReceived,
    total_tokens_bought:         position.totalTokensBought,
    total_tokens_sold:           position.totalTokensSold,

    // ── Computed P&L ──
    position_status:             finalStatus,
    current_token_balance:       finalBalance,
    current_position_value_sol:  position.currentPositionValueSol,
    current_token_price_sol:     priceData.priceSol    ?? null,
    current_token_price_usd:     priceData.priceUsd    ?? null,
    current_market_cap_usd:      mcap                  ?? null,
    // PATCH FIX (roi-never-degrade): prefer reconstructor value when present;
    // fall back to the stored value so a failed reconstruction never CLEARS a
    // previously computed roi_multiple or realized_profit (this was the root
    // cause of the regression that dropped roi_multiple coverage from 37%→17%).
    realized_profit:
      position.realizedProfit !== 0
        ? position.realizedProfit
        : (Number(existing?.realized_profit ?? 0) || position.realizedProfit),
    unrealized_profit:           position.unrealizedProfit,
    roi_multiple:
      position.roiMultiple != null
        ? position.roiMultiple
        : (Number(existing?.roi_multiple) || null),

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
  // BUG-FIX (total_buys/total_sells overwrite):
  //   Previously this function wrote total_buys and total_sells using the trade
  //   counts from the CURRENT enrichment's position.trades, which only covers
  //   a single token. Every enrichment run for a new token would overwrite the
  //   accumulated cross-token counts with that token's single-token count.
  //   Example: wallet has 5 buys across 3 tokens; after enriching token C
  //   (1 buy, 0 sells), the wallets table showed total_buys=1, total_sells=0
  //   — wiping out the other 4 buys.
  //
  //   Fix: remove total_buys/total_sells from this per-token-enrichment update.
  //   Cross-token counts are authoritative from classifyWallets() which reads
  //   ALL tokens in wallet_raw_tx_metrics and upserts the correct cross-token
  //   totals. The per-token enrichment only updates per-token P&L fields and
  //   timestamps; classification / counts come from the dedicated scoring pass.
  //
  //   The realized_pnl / unrealized_pnl written here are also per-token values
  //   and will be overwritten by the next token enrichment. These are retained
  //   for now as they reflect the most recently enriched token's position, but
  //   a future improvement would aggregate them across tokens.
  const patch: Record<string, unknown> = {
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
  // Optional, additive-only observability hook for offline validation/reporting
  // tooling (see scripts/validation-report.ts). Never called with anything the
  // production caller doesn't already pass 4 positional args for, so existing
  // call sites are unaffected. Exposes the exact position-level data used for
  // scoring so audits don't need to duplicate any classification logic.
  debugHook?: (
    walletAddr: string,
    info: {
      positions:            Array<Record<string, unknown>>;
      totalBuyTxs:          number;
      totalSellTxs:         number;
      totalVolumeBoughtSol: number;
      totalVolumeSoldSol:   number;
      usingRaw:             boolean;
    },
  ) => void,
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
    .in("wallet_address", walletAddresses)
    .eq("has_evidence", true);  // exclude tombstone rows — they carry no analytical signal

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

  // ── Dead-token detection for implicit rug scoring ──────────────────────────
  // Problem: wallets holding rugged tokens have OPEN positions that never
  // get marked CLOSED (no on-chain sell tx). Without CLOSED positions, win_rate
  // stays null and the wallet scores at the participation floor (~0.35) forever.
  //
  // Fix: collect all token addresses across these wallets, query token_price_history
  // for their latest market cap, query wallet_collection_jobs for their entry market
  // cap, and build a deadTokens set. During position building, any OPEN position
  // on a dead token is treated as a CLOSED full loss for scoring purposes only —
  // the raw metrics table is never modified.
  //
  // Thresholds: latest_market_cap < 3% of entry_market_cap AND snapshot > 3 days old.
  const allTokenAddrs = new Set<string>();
  for (const rows of byWallet.values()) {
    for (const r of rows) {
      if (r.token_address) allTokenAddrs.add(r.token_address as string);
    }
  }

  const deadTokens = new Set<string>();
  if (allTokenAddrs.size > 0) {
    const tokenList = [...allTokenAddrs];
    const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
    const RUG_THRESHOLD = 0.03;

    // Helper: paginated .in() query — Supabase REST caps at 500 values per .in() call.
    // We chunk to avoid silent truncation when wallets span > 500 unique tokens.
    async function pagedIn<T extends Record<string, unknown>>(
      table: string,
      column: string,
      values: string[],
      selectFields: string,
      extra: (q: ReturnType<typeof sb.from>) => ReturnType<typeof sb.from>,
    ): Promise<T[]> {
      const CHUNK = 500;
      const results: T[] = [];
      for (let i = 0; i < values.length; i += CHUNK) {
        const slice = values.slice(i, i + CHUNK);
        const { data } = await (extra(
          sb.from(table).select(selectFields).in(column, slice)
        ) as Promise<{ data: T[] | null }>);
        results.push(...(data ?? []));
      }
      return results;
    }

    try {
      // Latest MC snapshot per token — staleness is intentional.
      // If token_price_history.snapshotted_at is > 3 days old, it means the
      // price-refresh scheduler found no active market for this token for 3+ days:
      // no DEX pair on DexScreener, no trading activity. That is itself a strong
      // rug/death signal, separate from the MC ratio check below.
      const priceRows = await pagedIn<{
        token_address: string;
        market_cap_usd: number;
        snapshotted_at: string;
      }>(
        "token_price_history",
        "token_address",
        tokenList,
        "token_address, market_cap_usd, snapshotted_at",
        (q) => q.not("market_cap_usd", "is", null).gt("market_cap_usd", 0).order("snapshotted_at", { ascending: false }),
      );

      const latestMc = new Map<string, { mc: number; age: number }>();
      for (const row of priceRows) {
        if (!latestMc.has(row.token_address)) {
          latestMc.set(row.token_address, {
            mc:  Number(row.market_cap_usd),
            age: Date.now() - new Date(row.snapshotted_at).getTime(),
          });
        }
      }

      // Entry MC per token from earliest wallet_collection_jobs row
      const jobRows = await pagedIn<{
        token_address: string;
        market_cap_usd: number;
      }>(
        "wallet_collection_jobs",
        "token_address",
        tokenList,
        "token_address, market_cap_usd",
        (q) => q.not("market_cap_usd", "is", null).gt("market_cap_usd", 0).order("created_at", { ascending: true }),
      );

      const entryMc = new Map<string, number>();
      for (const row of jobRows) {
        if (!entryMc.has(row.token_address)) {
          entryMc.set(row.token_address, Number(row.market_cap_usd));
        }
      }

      // Mark dead tokens
      for (const [tokenAddr, latest] of latestMc.entries()) {
        if (latest.age < THREE_DAYS_MS) continue;  // snapshot too fresh — token may still recover
        const entry = entryMc.get(tokenAddr) ?? 0;
        if (entry <= 0) continue;                   // no entry MC baseline — skip
        if (latest.mc / entry < RUG_THRESHOLD) {
          deadTokens.add(tokenAddr);
        }
      }
    } catch {
      // Non-fatal — dead token detection is a scoring enhancement only.
      // If queries fail, scoring falls back to the original behavior (OPEN stays OPEN).
    }
  }
  // ── End dead-token detection ────────────────────────────────────────────────

  const updates: Record<string, unknown>[] = [];

  // FIX (confidence-tier-undercount): scores.closedPositionCount is derived
  // only from wallet_raw_tx_metrics rows (one row per token per collection job).
  // wallet_performance_history accumulates CLOSED positions from ALL past jobs
  // plus markImplicitRugPositions() rug detection, giving a higher — and more
  // accurate — count. Pre-fetch actual CLOSED counts from wph for the entire
  // batch so computeConfidenceTier() can use MAX(in-memory, wph) and never
  // undercount a wallet's closed position history.
  const wphClosedCounts = new Map<string, number>();
  if (rawRows?.length) {
    const batchAddresses = Array.from(byWallet.keys());
    const CLOSED_CHUNK = 500;
    for (let ci = 0; ci < batchAddresses.length; ci += CLOSED_CHUNK) {
      const slice = batchAddresses.slice(ci, ci + CLOSED_CHUNK);
      const { data: closedRows } = await sb
        .from("wallet_performance_history")
        .select("wallet_address")
        .in("wallet_address", slice)
        .eq("position_status", "CLOSED");
      for (const row of closedRows ?? []) {
        const wa = row.wallet_address as string;
        wphClosedCounts.set(wa, (wphClosedCounts.get(wa) ?? 0) + 1);
      }
    }
  }

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
      // BUG-FIX (audit-5 OPEN/zero-balance mismatch):
      //   Previously this only looked at `tokensSold === 0` to decide OPEN,
      //   completely ignoring `balance` (tokensBought − tokensSold). A wallet
      //   whose sells were recorded as separate rows/txs that didn't quite
      //   reach the 95% "closed" threshold, or whose balance had already
      //   drained to ~0 via a transfer/burn not captured as a "sell", was
      //   left permanently stuck at OPEN even though it held nothing. Now the
      //   balance is checked directly: a ~0 balance can never be reported as
      //   OPEN, regardless of how the buy/sell counts line up.
      let posStatus: "OPEN" | "PARTIALLY_CLOSED" | "CLOSED" | "UNKNOWN";
      if (usingRaw) {
        const dataSource = r.data_source as string;
        if (dataSource === "holder_scan" && invested === 0) {
          // holder_scan with no SOL cost basis — position details unknown
          posStatus = "UNKNOWN";
        } else if (tokensBought === 0 && tokensSold > 0) {
          // BUY-EVIDENCE-INCOMPLETE: a sell was recorded with zero matching buys.
          // The sell is real — the wallet received confirmed SOL proceeds. The
          // missing buy is either:
          //   (a) Pre-history: the buy predates the Helius lookback window.
          //   (b) Raydium buy: wallet bought after token graduated from pump.fun;
          //       fetchWalletTokenTxs uses source=PUMP_FUN which skips Raydium txs.
          //
          // Changed UNKNOWN → CLOSED (2026-07-13):
          //   UNKNOWN permanently suppressed these wallets from all scoring even
          //   though they made real, profitable trades (some received 40–70 SOL
          //   from sells). CLOSED with invested=0 is the correct representation:
          //   — roiMultiple stays null (invested=0 guard in computePnL/classifyWallets)
          //   — realizedProfit stays 0 (zero-cost-basis CLOSED guard below ~line 1102)
          //   — win_rate and average_roi are never inflated
          //   — wallet gets a real classification ("retail" at minimum) reflecting
          //     that it genuinely traded, not permanently stuck at "unknown".
          posStatus = "CLOSED";
        } else if (tokensBought > 0 && balance <= tokensBought * 0.001) {
          // Balance is fully (or near-fully, dust-adjusted) drained — CLOSED,
          // even if tokensSold alone didn't cross the 95% threshold.
          posStatus = "CLOSED";
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

      // Dead-token override: if this token has been detected as a rug (lost > 97%
      // of its launch MC and snapshot is > 3 days stale), treat any OPEN position
      // as a CLOSED full loss for scoring purposes. The raw metrics table is NOT
      // modified — this is a scoring-time adjustment only so win_rate reflects reality.
      const tokenAddr = r.token_address as string;
      if (posStatus === "OPEN" && deadTokens.has(tokenAddr) && invested > 0) {
        posStatus = "CLOSED";
        // received stays 0 — total loss, so roiMultiple will be 0 and realized profit negative
      }

      // BUG-FIX: holder_scan wallets with any buy/sell activity should have
      // hasTransactionEvidence = true so they can be classified (at minimum "retail").
      // Previously: hasTransactionEvidence = posStatus !== "UNKNOWN"
      // Now: also true when we have direct evidence of buy or sell transactions.
      const hasBuySellEvidence = totalBuyTxs > 0 || tokensBought > 0;
      const hasTransactionEvidence = posStatus !== "UNKNOWN" || hasBuySellEvidence;

      // Compute ROI from raw data (avoids relying on stored computed column)
      // GUARDED (2026-07-12): apply the same dust/distortion guard used in
      // tx-reconstructor.ts's computePnL — without it, tiny-investment
      // positions (e.g. 0.006 SOL) produced 16,000–20,000x multiples that
      // fed straight into determineClassification()'s smart_money gate,
      // which reads averageRoi uncapped (unlike the 10x-capped score).
      let roiMultiple: number | null = null;
      if (posStatus === "CLOSED" && invested > 0) {
        roiMultiple = guardRoiMultiple(received / invested, invested);
      } else if (posStatus === "OPEN" && invested > 0) {
        // Unrealized ROI not computable here without current price — skip
        roiMultiple = null;
      }

      // Realized profit from raw data
      //
      // BUG-FIX (win_rate always 1.0):
      //   Previously: realizedProfit = received - invested  (even when invested === 0)
      //   When invested === 0 (zero-cost-basis positions — e.g. tokens received via
      //   airdrop, holder_scan with no buy attributed, or phantom buys from incomplete
      //   pool_extraction), this formula reduces to realizedProfit = received > 0,
      //   meaning EVERY such closed position appeared profitable regardless of
      //   whether any real capital was at risk. Since most closed positions in the
      //   DB originated from the pool_extraction path where buy SOL attribution
      //   often returned 0 (Helius nativeTransfers limitations on buy detection),
      //   virtually all 500 sampled wallets with a non-null win_rate had invested=0
      //   closed positions — hence win_rate = 1.0 across the board.
      //
      //   Fix: only count a position as having meaningful realized profit when
      //   invested > 0 (a real cost basis exists). Zero-investment positions are
      //   excluded from the profitability signal — their realizedProfit stays 0
      //   so they neither inflate win_rate (profitable) nor deflate it (loss).
      //   They still count in the CLOSED denominator if posStatus=CLOSED, but
      //   because they contribute 0 to the profitable numerator they are treated
      //   as break-even (neutral) rather than as wins. If you want to exclude them
      //   entirely from win_rate, also guard `const closed = evidenced.filter(...)`.
      //
      //   Note: roiMultiple already correctly returns null when invested === 0
      //   (guarded by `invested > 0` above), so no change needed there.
      let realizedProfit = 0;
      if (posStatus === "CLOSED" && invested > 0) {
        // Normal case: cost basis known — compute actual realized P&L
        realizedProfit = received - invested;
      } else if (posStatus === "CLOSED" && invested === 0) {
        // Zero-cost-basis closed position — no meaningful P&L signal.
        // Leave realizedProfit = 0 (break-even / neutral for win_rate purposes).
        // Do NOT set to received (that was the bug: treating free tokens as wins).
      } else if (posStatus === "PARTIALLY_CLOSED" && tokensBought > 0 && invested > 0) {
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

    // BUG-FIX (scoring-patch v8, found during v7 re-validation dry-run):
    //   For fallback-sourced wallets (usingRaw === false, no wallet_raw_tx_metrics
    //   evidence), wallet_performance_history has no real per-transaction buy/sell
    //   COUNT columns — only token QUANTITY columns (total_tokens_bought/sold,
    //   often in the tens of millions for memecoins). The previous code summed
    //   those quantities directly into totalBuys/totalSells, which feed BOTH the
    //   score-confidence damping (MIN_BUYS_FOR_SCORE_CONFIDENCE in wallet-
    //   classifier.ts) and the bot sell/buy-ratio heuristic in
    //   determineClassification(). Millions-of-"buys" always saturated the
    //   confidence multiplier to 1.0 and made a closed position's sold≈bought
    //   token ratio look identical to the bot heuristic's tx-ratio signal —
    //   so fallback wallets with a single lucky closed trade got misclassified
    //   "bot" and scored 0.83-0.96, dominating the top of the leaderboard.
    //   (This bug predates v7; removing the Breadth/Classification Bonus points
    //   in v7 simply stopped masking it by no longer keeping genuine raw-evidence
    //   whales artificially ahead of these inflated fallback scores.)
    //
    //   Fix: when !usingRaw, we have no trustworthy transaction-count signal at
    //   all, so use the number of distinct token positions (rows.length) as a
    //   conservative proxy instead of a quantity value — it keeps confidence
    //   damping and the bot ratio heuristic operating on genuinely small numbers,
    //   consistent with the "only trust counts from real per-tx columns" guard
    //   already applied to the wallets.total_buys/total_sells DB write below.
    const totalBuyTxs  = usingRaw
      ? rows.reduce((s, r) => s + Number(r.total_buy_txs ?? 0), 0)
      : rows.length;
    const totalSellTxs = usingRaw
      ? rows.reduce((s, r) => s + Number(r.total_sell_txs ?? 0), 0)
      : rows.length;
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

    debugHook?.(walletAddr, {
      positions,
      totalBuyTxs,
      totalSellTxs,
      totalVolumeBoughtSol,
      totalVolumeSoldSol,
      usingRaw,
    });

    // scoring-patch v7 / architecture review (2026-07-13): persist confidence
    // signals alongside the score itself, additive-only — no existing column
    // is changed by this block. evidenceQuality mirrors the usingRaw flag
    // already computed above (raw = real per-tx evidence, fallback =
    // wallet_performance_history). confidenceTier is derived from that plus
    // closedPositionCount via computeConfidenceTier() (wallet-classifier.ts),
    // kept in one place so scoring and confidence logic don't drift apart.
    const evidenceQuality: "raw" | "fallback" = usingRaw ? "raw" : "fallback";

    // FIX (confidence-tier-undercount): use MAX(in-memory count, actual wph
    // count) so rug-detected and historically-accumulated CLOSED positions
    // are reflected in the tier, not just the ones visible in this rescore pass.
    const closedPositionCountForTier = usingRaw
      ? Math.max(scores.closedPositionCount, wphClosedCounts.get(walletAddr) ?? 0)
      : scores.closedPositionCount;

    const confidenceTier = computeConfidenceTier({
      evidenceQuality,
      closedPositionCount: closedPositionCountForTier,
    });

    updates.push({
      wallet_address:        walletAddr,
      wallet_classification: scores.classification,
      intelligence_score:    scores.intelligenceScore / 100,   // normalised 0–1 (classifier returns 0–100)
      win_rate:              scores.winRate,
      average_roi:           scores.averageRoi,
      conviction_score:      scores.convictionScore,
      confidence_tier:         confidenceTier,
      closed_position_count:   closedPositionCountForTier,
      evidence_quality:        evidenceQuality,
      score_computed_at:       new Date().toISOString(),
      // BUG-FIX (2026-07-12): total_buys/total_sells/total_tokens_traded were
      // never written by classifyWallets() at all — updateWalletStats() had
      // them removed (see BUG-FIX above) to stop the per-token overwrite bug,
      // but nothing replaced that write with the correct cross-token sum.
      // Result: wallets.total_buys stayed frozen at whatever stale value the
      // old per-token overwrite last left it — confirmed live: one wallet had
      // 1,429 wallet_raw_tx_metrics rows but wallets.total_buys = 1. These are
      // the authoritative cross-token totals computed just above from ALL
      // rows for this wallet, so this upsert is now the single source of truth.
      // GUARD (2026-07-12, discovered during dry-run testing of the fix above):
      // when this batch has zero has_evidence=true rows, `usingRaw` is false
      // and the code falls back to wallet_performance_history, where
      // totalBuyTxs/totalSellTxs are computed from total_tokens_bought/sold —
      // raw TOKEN quantities (often in the millions for memecoins), not
      // transaction counts. Writing that into total_buys/total_sells would
      // corrupt the column with nonsense. Only trust these counts when they
      // came from the real per-transaction columns in wallet_raw_tx_metrics.
      ...(usingRaw
        ? { total_buys: totalBuyTxs, total_sells: totalSellTxs }
        : {}),
      total_tokens_traded:   rows.length,
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
