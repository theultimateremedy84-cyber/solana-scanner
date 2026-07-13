// =============================================================================
// wallet-discovery-score.ts  (P2-B — Discovery Score Engine v1)
//
// Standalone, DB-only computation of Discovery Score for all wallets.
// No Helius API calls — reads only from tables already populated by the
// collection worker, enricher, and price-refresh scheduler.
//
// FORMULA (5-factor weighted model)
// ─────────────────────────────────
//   Factor 1  Milestone Rate   (30%)  — fraction of positions reaching $1 M+ MC
//   Factor 2  ROI Quality      (25%)  — normalised avg ROI across positions
//   Factor 3  Win Rate         (20%)  — profitable closed ÷ total closed
//   Factor 4  Entry Timing     (15%)  — bracket score from avg entry market cap
//   Factor 5  Repeatability    (10%)  — log-scaled distinct token count
//
//   raw_score = Σ(factor × weight)           ∈ [0, 1]
//   confidence = 1 − exp(−n / 5)             ∈ [0, 1]
//     where n = total wallet_performance_history positions
//
//   discovery_score = raw_score              (stored as-is; confidence stored
//   discovery_confidence = confidence         separately for UI display)
//
// TIER LABELS  (written to wallets.discovery_tier)
// PATCH (monetization-audit issue #4 — 2026-07-14): recalibrated against live data.
//   Previous thresholds (elite 0.65/0.50, strong 0.45/0.25) were too strict:
//   the top wallet had 18 discoveries, discovery_confidence ≈ 1.0, yet
//   discovery_score ≈ 0.40 — permanently stuck at "developing" despite being
//   a genuine top discoverer.  The formula scores correctly; the tier labels
//   were not calibrated to the live distribution.
//   New thresholds (lowered to match actual score distribution):
//   elite       — score ≥ 0.55 AND confidence ≥ 0.60  (requires n≥3 positions at CONF_K=2)
//   strong      — score ≥ 0.35 AND confidence ≥ 0.25  (n=1 qualifies: confidence=0.39)
//   developing  — score ≥ 0.20
//   unproven    — score <  0.20
//   low_sample  — confidence < 0.20 (was: < 0.30; overrides tier label)
//
// ENTRY TIMING BRACKETS (calibrated for Pump.fun bonding-curve launches)
//   < $10 K     → 1.00
//   < $50 K     → 0.80
//   < $100 K    → 0.60
//   < $500 K    → 0.40
//   < $1 M      → 0.20
//   ≥ $1 M      → 0.10
//   no data     → 0.50  (neutral — does not reward or penalise)
//
// HOW TO CALL
//   import { computeDiscoveryScores } from "./wallet-discovery-score";
//   const updated = await computeDiscoveryScores(sb, walletAddresses, errors);
//
// PERFORMANCE
//   Fetches wallet_performance_history in batches of BATCH_SIZE (200).
//   Writes wallets in batches of WRITE_CHUNK (200) via upsert.
//   Suitable for 100 K+ wallets with incremental scheduling.
// =============================================================================

import { createClient } from "@supabase/supabase-js";

const LOG = "[DiscoveryScore]";

// ── Batch sizes ────────────────────────────────────────────────────────────────
const BATCH_SIZE  = 200;  // wallets fetched per DB read round-trip
const WRITE_CHUNK = 200;  // wallets upserted per DB write round-trip

// ── Factor weights (must sum to 1.0) ─────────────────────────────────────────
const W_MILESTONE    = 0.30;
const W_ROI_QUALITY  = 0.25;
const W_WIN_RATE     = 0.20;
const W_ENTRY_TIMING = 0.15;
const W_REPEATABILITY = 0.10;

// ── ROI quality cap — prevents one moonshot from dominating ──────────────────
const ROI_CAP = 20;   // 20× cap; anything higher treated as 20×

// ── Confidence sample size parameter ─────────────────────────────────────────
// PATCH NOTES (confidence-patch v2 — data-density calibration):
//   DB reality: 820/835 wallets have 1 position. With CONF_K=5, confidence at
//   n=1 is only 18% → permanently "low_sample". Lowered CONF_K to 2:
//     n=1 → 39%,  n=2 → 63%,  n=3 → 78%,  n=5 → 92%
//   low_sample threshold lowered 0.30→0.20 (n=1 at CONF_K=2 → 39% > 0.20).
//   Elite/strong confidence thresholds adjusted proportionally.
//
// confidence = 1 − exp(−n / CONF_K)
// At n=5  → 0.63,  n=10 → 0.86,  n=20 → 0.98
const CONF_K = 2;   // was 5 — see confidence-patch v2 note above

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface DiscoveryScoreResult {
  walletsScored: number;
  walletsSkipped: number;
  errors: string[];
  durationMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal types
// ─────────────────────────────────────────────────────────────────────────────

interface PerfRow {
  wallet_address:      string;
  token_address:       string;
  position_status:     string | null;
  initial_investment:  number | null;  // added for Issue #6: airdrop exit filtering
  realized_profit:     number | null;
  roi_multiple:        number | null;
  reached_1m_mc:      boolean | null;
  reached_5m_mc:      boolean | null;
  reached_10m_mc:     boolean | null;
}

interface EntryRow {
  wallet_address:   string;
  entry_market_cap: number | null;
}

interface WalletDiscoveryData {
  n:                  number;    // total distinct token positions
  milestoneCount:     number;    // positions that reached $1 M+ MC
  avgRoiQuality:      number;    // factor 2 value (already 0-1)
  winRate:            number;    // factor 3 value (already 0-1)
  avgEntryMc:         number | null;  // raw USD — used for factor 4 bracket
  distinctTokens:     number;    // for factor 5 log scale
  totalDiscoveries:   number;    // raw count for metadata column
  successfulDiscoveries: number; // positions that hit ≥ 1 M for metadata column
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute and write discovery scores for a list of wallet addresses.
 *
 * @param sb              Supabase client (service-role)
 * @param walletAddresses Wallets to score (pass [] to score ALL wallets)
 * @param errors          Error accumulator — errors are appended, not thrown
 * @returns               Summary of the scoring run
 */
export async function computeDiscoveryScores(
  sb:             ReturnType<typeof createClient>,
  walletAddresses: string[],
  errors:         string[],
): Promise<DiscoveryScoreResult> {
  const startTime = Date.now();
  const result: DiscoveryScoreResult = {
    walletsScored: 0, walletsSkipped: 0, errors, durationMs: 0,
  };

  if (walletAddresses.length === 0) {
    console.log(`${LOG} No wallets to score — skipping`);
    result.durationMs = Date.now() - startTime;
    return result;
  }

  console.log(`${LOG} ═══ Computing discovery scores for ${walletAddresses.length} wallets`);

  // ── Fetch all performance rows for these wallets ──────────────────────────
  const perfRows = await fetchPerfRows(sb, walletAddresses, errors);
  const entryRows = await fetchEntryRows(sb, walletAddresses, errors);

  if (perfRows.length === 0) {
    console.log(`${LOG} No wallet_performance_history rows found — nothing to score`);
    result.durationMs = Date.now() - startTime;
    return result;
  }

  // ── Group data by wallet ──────────────────────────────────────────────────
  const perfByWallet  = groupBy(perfRows,  (r) => r.wallet_address);
  const entryByWallet = groupAvgEntryMc(entryRows);

  // ── Score each wallet ─────────────────────────────────────────────────────
  const upsertRows: Record<string, unknown>[] = [];

  for (const walletAddress of walletAddresses) {
    const positions = perfByWallet.get(walletAddress) ?? [];
    if (positions.length === 0) {
      result.walletsSkipped++;
      continue;
    }

    const data  = aggregateWalletData(positions, entryByWallet.get(walletAddress) ?? null);
    const score = scoreWallet(data);

    upsertRows.push({
      wallet_address:          walletAddress,
      discovery_score:         round6(score.discoveryScore),
      discovery_confidence:    round3(score.confidence),
      discovery_tier:          score.tier,
      total_discoveries:       data.totalDiscoveries,
      successful_discoveries:  data.successfulDiscoveries,
      avg_entry_market_cap:    data.avgEntryMc != null ? Math.round(data.avgEntryMc) : null,
      updated_at:              new Date().toISOString(),
    });
  }

  // ── Upsert in chunks ──────────────────────────────────────────────────────
  for (let i = 0; i < upsertRows.length; i += WRITE_CHUNK) {
    const chunk = upsertRows.slice(i, i + WRITE_CHUNK);
    const { error } = await sb
      .from("wallets")
      .upsert(chunk, { onConflict: "wallet_address", ignoreDuplicates: false });
    if (error) {
      const msg = `upsert chunk ${Math.floor(i / WRITE_CHUNK)}: ${error.message}`;
      console.error(`${LOG} ✗ ${msg}`);
      errors.push(msg);
    } else {
      result.walletsScored += chunk.length;
    }
  }

  result.durationMs = Date.now() - startTime;
  console.log(
    `${LOG} ═══ DONE — scored=${result.walletsScored} ` +
    `skipped=${result.walletsSkipped} errors=${errors.length} ` +
    `duration=${result.durationMs}ms`,
  );
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Data fetching
// ─────────────────────────────────────────────────────────────────────────────

async function fetchPerfRows(
  sb:             ReturnType<typeof createClient>,
  walletAddresses: string[],
  errors:         string[],
): Promise<PerfRow[]> {
  const allRows: PerfRow[] = [];

  for (let i = 0; i < walletAddresses.length; i += BATCH_SIZE) {
    const batch = walletAddresses.slice(i, i + BATCH_SIZE);
    const { data, error } = await sb
      .from("wallet_performance_history")
      .select(
        "wallet_address, token_address, position_status, " +
        "initial_investment, " +   // Issue #6: needed to identify airdrop exits
        "realized_profit, roi_multiple, " +
        "reached_1m_mc, reached_5m_mc, reached_10m_mc",
      )
      .in("wallet_address", batch);

    if (error) {
      errors.push(`fetchPerfRows batch ${Math.floor(i / BATCH_SIZE)}: ${error.message}`);
    } else {
      allRows.push(...(data as PerfRow[]));
    }
  }

  return allRows;
}

async function fetchEntryRows(
  sb:             ReturnType<typeof createClient>,
  walletAddresses: string[],
  errors:         string[],
): Promise<EntryRow[]> {
  const allRows: EntryRow[] = [];

  for (let i = 0; i < walletAddresses.length; i += BATCH_SIZE) {
    const batch = walletAddresses.slice(i, i + BATCH_SIZE);
    const { data, error } = await sb
      .from("wallet_token_activity")
      .select("wallet_address, entry_market_cap")
      .in("wallet_address", batch)
      .eq("action_type", "buy")
      .not("entry_market_cap", "is", null);

    if (error) {
      errors.push(`fetchEntryRows batch ${Math.floor(i / BATCH_SIZE)}: ${error.message}`);
    } else {
      allRows.push(...(data as EntryRow[]));
    }
  }

  return allRows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregation
// ─────────────────────────────────────────────────────────────────────────────

function aggregateWalletData(
  positions: PerfRow[],
  avgEntryMc: number | null,
): WalletDiscoveryData {
  // PATCH (monetization-audit issue #6 — 2026-07-14):
  //   Exclude zero-investment CLOSED positions (airdrop exits) from ALL scoring
  //   factors.  These 21,530 positions (initial_investment = 0, roi_multiple = NULL)
  //   were inflating n (confidence/repeatability denominator) and win_rate
  //   for wallets that received airdropped tokens alongside their real trades.
  //   A wallet with 50 airdrop exits appeared to have 50 "discoveries" but zero
  //   real capital was ever deployed.
  const scorablePositions = positions.filter(
    (p) => !(p.position_status === "CLOSED" && (p.initial_investment ?? 0) <= 0),
  );

  // Distinct tokens this wallet participated in (only scorable positions)
  const distinctTokens = new Set(scorablePositions.map((p) => p.token_address)).size;
  const n = scorablePositions.length;

  // Milestone hits — reached $1 M+ MC (from scorable positions only)
  const milestoneCount = scorablePositions.filter(
    (p) => p.reached_1m_mc === true || p.reached_5m_mc === true || p.reached_10m_mc === true,
  ).length;

  // ROI quality — only positions with a positive roi_multiple
  const roiPositions = scorablePositions.filter(
    (p) => p.roi_multiple != null && p.roi_multiple > 0,
  );
  let avgRoiQuality = 0;
  if (roiPositions.length > 0) {
    const roiSum = roiPositions.reduce(
      (s, p) => s + Math.min(p.roi_multiple!, ROI_CAP),
      0,
    );
    // Normalise: avg capped ROI ÷ cap → 0–1 range
    avgRoiQuality = roiSum / roiPositions.length / ROI_CAP;
  }

  // Win rate — profitable closed positions (zero-investment closed already excluded above)
  const closedPositions    = scorablePositions.filter((p) => p.position_status === "CLOSED");
  const profitableClosed   = closedPositions.filter((p) => (p.realized_profit ?? 0) > 0);
  const winRate            = closedPositions.length > 0
    ? profitableClosed.length / closedPositions.length
    : 0;

  // totalDiscoveries / successfulDiscoveries also exclude airdrop exits so the
  // UI counts reflect only genuine token positions with real capital at risk.
  return {
    n,
    milestoneCount,
    avgRoiQuality,
    winRate,
    avgEntryMc,
    distinctTokens,
    totalDiscoveries:      n,
    successfulDiscoveries: milestoneCount,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring
// ─────────────────────────────────────────────────────────────────────────────

interface ScoredWallet {
  discoveryScore: number;
  confidence:     number;
  tier:           string;
}

function scoreWallet(data: WalletDiscoveryData): ScoredWallet {
  const { n, milestoneCount, avgRoiQuality, winRate, avgEntryMc, distinctTokens } = data;

  // Factor 1 — Milestone Rate (30%)
  const f1_milestone = n > 0 ? Math.min(milestoneCount / n, 1) : 0;

  // Factor 2 — ROI Quality (25%) — already 0-1 from aggregateWalletData
  const f2_roi = avgRoiQuality;

  // Factor 3 — Win Rate (20%)
  const f3_winRate = winRate;

  // Factor 4 — Entry Timing (15%)
  const f4_entryTiming = entryTimingBracket(avgEntryMc);

  // Factor 5 — Repeatability (10%) — log10(n+1) / log10(11) → 1.0 at n=10
  const f5_repeat = Math.min(Math.log10(distinctTokens + 1) / Math.log10(11), 1);

  // Weighted raw score
  const rawScore =
    f1_milestone    * W_MILESTONE    +
    f2_roi          * W_ROI_QUALITY  +
    f3_winRate      * W_WIN_RATE     +
    f4_entryTiming  * W_ENTRY_TIMING +
    f5_repeat       * W_REPEATABILITY;

  // Confidence based on sample size
  const confidence = 1 - Math.exp(-n / CONF_K);

  const tier = deriveTier(rawScore, confidence);

  return {
    discoveryScore: clamp(rawScore, 0, 1),
    confidence:     clamp(confidence, 0, 1),
    tier,
  };
}

/**
 * Entry timing bracket score (calibrated for Pump.fun early-stage tokens).
 * Returns 0.50 (neutral) when no entry_market_cap data is available —
 * does not penalise wallets whose entry MC we cannot determine yet.
 */
function entryTimingBracket(avgEntryMc: number | null): number {
  if (avgEntryMc == null) return 0.50;          // neutral — data not available
  if (avgEntryMc <   10_000) return 1.00;       // < $10 K  — very early
  if (avgEntryMc <   50_000) return 0.80;       // < $50 K  — early
  if (avgEntryMc <  100_000) return 0.60;       // < $100 K — pre-breakout
  if (avgEntryMc <  500_000) return 0.40;       // < $500 K — mid
  if (avgEntryMc < 1_000_000) return 0.20;      // < $1 M   — late
  return 0.10;                                   // ≥ $1 M   — very late
}

function deriveTier(score: number, confidence: number): string {
  // Low sample size overrides tier regardless of score.
  // Threshold: confidence < 0.20; at CONF_K=2 this means n=0 (confidence=0).
  if (confidence < 0.20) return "low_sample";

  // PATCH (monetization-audit issue #4 — 2026-07-14): tier thresholds recalibrated
  // against live distribution.  The previous thresholds (elite: 0.65/0.50,
  // strong: 0.45/0.25) were derived from theoretical score ranges and did not
  // match the actual data.  Live audit confirmed: top wallet has 18 discoveries,
  // discovery_confidence ≈ 1.0, yet score ≈ 0.40 — stuck at "developing" even
  // though the milestone rate formula correctly reflects limited milestone hits.
  // The recalibrated thresholds surface actual top discoverers without inflating
  // the tier for low-signal wallets.
  //
  // elite:      score ≥ 0.55 AND confidence ≥ 0.60  (was: 0.65 / 0.50)
  //             At CONF_K=2, confidence=0.60 requires n≥2 positions (conf=0.63).
  // strong:     score ≥ 0.35 AND confidence ≥ 0.25  (was: 0.45 / 0.25)
  //             n=1 still qualifies (confidence=0.39 >= 0.25).
  // developing: score ≥ 0.20                         (was: ≥ 0.25)
  // unproven:   score <  0.20                         (was: < 0.25)
  if (score >= 0.55 && confidence >= 0.60) return "elite";
  if (score >= 0.35 && confidence >= 0.25) return "strong";
  if (score >= 0.20) return "developing";
  return "unproven";
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const arr = map.get(key) ?? [];
    arr.push(item);
    map.set(key, arr);
  }
  return map;
}

function groupAvgEntryMc(rows: EntryRow[]): Map<string, number | null> {
  const sums = new Map<string, { total: number; count: number }>();
  for (const row of rows) {
    if (row.entry_market_cap == null) continue;
    const existing = sums.get(row.wallet_address) ?? { total: 0, count: 0 };
    existing.total += row.entry_market_cap;
    existing.count++;
    sums.set(row.wallet_address, existing);
  }
  const result = new Map<string, number | null>();
  for (const [wallet, { total, count }] of sums.entries()) {
    result.set(wallet, count > 0 ? total / count : null);
  }
  return result;
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function round6(val: number): number {
  return Math.round(val * 1_000_000) / 1_000_000;
}

function round3(val: number): number {
  return Math.round(val * 1_000) / 1_000;
}
