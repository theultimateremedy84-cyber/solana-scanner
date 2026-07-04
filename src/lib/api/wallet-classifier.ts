// =============================================================================
// Wallet Classifier  (Phase 1 — Transaction-Driven Wallet Intelligence)
//
// Classifies a wallet and computes its intelligence score from verified
// on-chain transaction evidence. Never uses synthetic or estimated values.
//
// Classification labels (consistent with existing DB enum):
//   smart_money  — consistently profitable across multiple tokens, high win rate
//   sniper       — enters early at low market cap, exits quickly with profit
//   whale        — large absolute SOL volume (> WHALE_SOL_THRESHOLD)
//   bot          — high sell/buy ratio with many trades, mechanical cadence
//   retail       — general participant (profitable or not)
//   unknown      — insufficient evidence to classify
//
// PATCH NOTES (scoring-patch v1):
//   BUG-FIX win_rate:      closed.length >= 2 → >= 1
//            convictionScore: evidenced.length >= 2 → >= 1
//   TUNING   SMART_MONEY_MIN_TOKENS: 3 → 2
//            SMART_MONEY_MIN_ROI:    2.0 → 1.5
//
// PATCH NOTES (scoring-patch v2 — normalization):
//   intelligenceScore is computed on a 0–100 integer scale internally for
//   readability, then divided by 100 at the DB write boundary (wallet-enricher.ts
//   classifyWallets()) so the stored value is always a 0–1 NUMERIC.
//   All callers that read from the DB must treat the column as 0–1.
//
// PATCH NOTES (scoring-patch v4 — participation floor):
//   94.4% of wallets scored < 0.40 because win_rate + avg_roi (70 pts) are
//   NULL for OPEN positions. A single OPEN position wallet got ≤ 8 pts (0.08).
//   Fix: 15-pt participation floor for any wallet with verified trade evidence.
//   Win-rate 35→30, ROI 35→25, retail bonus 3→5. Total still 100.
//   Expected: retail OPEN wallets ~0.25, good retail ~0.45, smart_money ~0.75+
// =============================================================================

import type { ReconstructedPosition } from "./tx-reconstructor";

export type WalletClassification =
  | "smart_money"
  | "sniper"
  | "bot"
  | "whale"
  | "retail"
  | "unknown";

export interface WalletScores {
  classification:    WalletClassification;
  /**
   * Raw 0–100 integer computed internally.
   * Divided by 100 at the DB write boundary → stored as 0–1 NUMERIC.
   * Do NOT write this value directly to the database; use intelligenceScore / 100.
   */
  intelligenceScore: number;
  discoveryScore:    number | null;  // null — populated downstream by price refresh
  convictionScore:   number | null;  // null if < 1 evidenced position
  winRate:           number | null;  // null if < 1 closed position
  averageRoi:        number | null;  // null if no closed positions with roi data
}

// ── Tuning constants ──────────────────────────────────────────────────────
//
// PATCH NOTES (scoring-patch v3 — data-density calibration):
//   DB reality: 820/835 wallets have exactly 1 position in wallet_performance_history.
//   Previous MIN_TOKENS=2 and MIN_FLIPS=2 made smart_money/sniper mathematically
//   unreachable. Lowered to 1 to reflect early-stage data density.
//   WHALE_SOL_THRESHOLD lowered 50→20: avg autonomously-discovered token MC is
//   ~$41K, so 50 SOL is disproportionate; 20 SOL is a meaningful whale signal.
//   Breadth score changed from linear (n×2) to log-scaled (log2(n+1)×5) so a
//   single high-quality position contributes 5pts instead of 2pts, while
//   multi-token wallets still reach the 10pt cap at n≥3.
//
const WHALE_SOL_THRESHOLD    = 20;   // SOL volume total to qualify as whale (was 50)
const BOT_SELL_BUY_RATIO     = 0.8;  // sells / buys ratio
const BOT_MIN_BUYS           = 10;   // minimum buy count for bot classification
const SMART_MONEY_WIN_RATE   = 0.60; // 60% win rate (was 0.65 — calibrated to data density)
// Smart-money ROI gates — tiered by position count to prevent lucky-retail over-promotion:
//   1 evidenced position  → requires ≥ SMART_MONEY_MIN_ROI_SINGLE (5×) — a single 57x trade is real; a single 1.5x is noise
//   2+ evidenced positions → requires ≥ SMART_MONEY_MIN_ROI_MULTI  (1.5×) — repeatable pattern at lower bar
const SMART_MONEY_MIN_ROI_SINGLE = 5.0;  // floor for single-position wallets
const SMART_MONEY_MIN_ROI_MULTI  = 1.5;  // floor for wallets with 2+ evidenced positions
const SMART_MONEY_MIN_TOKENS = 1;    // minimum evidenced positions (was 2 — unreachable with 1-position wallets)
const SNIPER_MAX_HOLD_HOURS  = 6;    // quick flip window (was 4 — extended to catch 4–6h flips)
const SNIPER_MIN_FLIPS       = 1;    // minimum quick profitable exits (was 2 — unreachable with 1-position wallets)
const SNIPER_MIN_PROFIT_SOL  = 0.1;  // minimum realized profit per flip (filters out dust-level wins)

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Classify a wallet and compute its composite intelligence score.
 *
 * Returns intelligenceScore as a raw 0–100 integer.
 * The DB write boundary (classifyWallets in wallet-enricher.ts) divides by 100
 * before upserting so the stored value is always a 0–1 NUMERIC.
 *
 * @param positions  All reconstructed positions for this wallet (all tokens).
 * @param totalBuys  Sum of buy transactions across all tokens.
 * @param totalSells Sum of sell transactions across all tokens.
 * @param totalVolumeBoughtSol Total SOL invested across all tokens.
 * @param totalVolumeSoldSol   Total SOL received from sells across all tokens.
 */
export function classifyWallet(opts: {
  positions:              ReconstructedPosition[];
  totalBuys:              number;
  totalSells:             number;
  totalVolumeBoughtSol:   number;
  totalVolumeSoldSol:     number;
}): WalletScores {
  const { positions, totalBuys, totalSells, totalVolumeBoughtSol } = opts;

  // Only trust positions with real transaction evidence
  const evidenced = positions.filter((p) => p.hasTransactionEvidence);
  const closed    = evidenced.filter((p) => p.positionStatus === "CLOSED");
  const profitable = closed.filter((p) => (p.realizedProfit ?? 0) > 0);

  // ── Win rate — requires ≥ 1 closed position (was: ≥ 2) ───────────────────
  // One closed position gives a binary 0.0 or 1.0 reading; two or more
  // produces a meaningful rate. Both are better than leaving win_rate null.
  const winRate: number | null =
    closed.length >= 1 ? profitable.length / closed.length : null;

  // ── Average ROI (closed positions only — realized P&L is concrete) ──
  const closedWithRoi = closed.filter((p) => p.roiMultiple != null);
  const averageRoi: number | null =
    closedWithRoi.length >= 1
      ? closedWithRoi.reduce((s, p) => s + (p.roiMultiple ?? 0), 0) / closedWithRoi.length
      : null;

  // ── Conviction score — fraction of evidenced positions still held (OPEN) ──
  // Requires ≥ 1 evidenced position (was: ≥ 2).
  const openCount = evidenced.filter((p) => p.positionStatus === "OPEN").length;
  const convictionScore: number | null =
    evidenced.length >= 1
      ? Math.round((openCount / evidenced.length) * 100)
      : null;

  // Discovery score is populated by the price-refresh worker which has
  // entry_market_cap data — we leave it null here.
  const discoveryScore: number | null = null;

  // ── Classification ────────────────────────────────────────────────────────
  const classification = determineClassification({
    evidenced,
    closed,
    winRate,
    averageRoi,
    totalBuys,
    totalSells,
    totalVolumeBoughtSol,
  });

  // ── Intelligence score (0–100 internal; divided by 100 at DB write) ──────
  const intelligenceScore = computeIntelligenceScore({
    winRate,
    averageRoi,
    convictionScore,
    classification,
    evidenced,
  });

  return {
    classification,
    intelligenceScore,
    discoveryScore,
    convictionScore,
    winRate,
    averageRoi,
  };
}

// ---------------------------------------------------------------------------
// Classification logic (private)
// ---------------------------------------------------------------------------

function determineClassification(opts: {
  evidenced:            ReconstructedPosition[];
  closed:               ReconstructedPosition[];
  winRate:              number | null;
  averageRoi:           number | null;
  totalBuys:            number;
  totalSells:           number;
  totalVolumeBoughtSol: number;
}): WalletClassification {
  const {
    evidenced, closed, winRate, averageRoi,
    totalBuys, totalSells, totalVolumeBoughtSol,
  } = opts;

  // Insufficient evidence
  if (evidenced.length === 0) return "unknown";

  // ── Whale: large SOL volume —————————————————————————————————————————
  if (totalVolumeBoughtSol >= WHALE_SOL_THRESHOLD) return "whale";

  // ── Bot: mechanical high-frequency trading ──────────────────────────
  const sellBuyRatio = totalBuys > 0 ? totalSells / totalBuys : 0;
  if (sellBuyRatio >= BOT_SELL_BUY_RATIO && totalBuys >= BOT_MIN_BUYS) return "bot";

  // ── Smart money: consistent profitability ──────────────────────────
  // Tiered ROI gate prevents lucky-retail over-promotion:
  //   - 1 position: need ≥ 5× ROI (a single 57× trade is genuine; a 1.5× is noise)
  //   - 2+ positions: need ≥ 1.5× ROI (lower bar for repeatable performance)
  const roiMin = evidenced.length >= 2 ? SMART_MONEY_MIN_ROI_MULTI : SMART_MONEY_MIN_ROI_SINGLE;
  if (
    winRate     != null && winRate    >= SMART_MONEY_WIN_RATE   &&
    averageRoi  != null && averageRoi >= roiMin                 &&
    evidenced.length                  >= SMART_MONEY_MIN_TOKENS
  ) {
    return "smart_money";
  }

  // ── Sniper: enters early, flips quickly for meaningful profit ──────
  // Requires a minimum realized profit (0.1 SOL) to exclude dust-level wins.
  const fastProfitableFlips = closed.filter((p) => {
    if (!p.firstTradeTs || !p.lastTradeTs) return false;
    const holdHours = (p.lastTradeTs - p.firstTradeTs) / 3600;
    return (
      holdHours <= SNIPER_MAX_HOLD_HOURS &&
      (p.realizedProfit ?? 0) >= SNIPER_MIN_PROFIT_SOL
    );
  });
  if (fastProfitableFlips.length >= SNIPER_MIN_FLIPS) return "sniper";

  // ── Retail: everyone else with evidence ─────────────────────────────
  if (evidenced.length >= 1) return "retail";

  return "unknown";
}

// ---------------------------------------------------------------------------
// Intelligence score (private)
// ---------------------------------------------------------------------------

/**
 * Returns an integer in 0–100.
 * The caller (classifyWallets in wallet-enricher.ts) divides by 100
 * before writing to the DB so the stored value is always 0–1.
 */
function computeIntelligenceScore(opts: {
  winRate:         number | null;
  averageRoi:      number | null;
  convictionScore: number | null;
  classification:  WalletClassification;
  evidenced:       ReconstructedPosition[];
}): number {
  const { winRate, averageRoi, convictionScore, classification, evidenced } = opts;

  if (evidenced.length === 0) return 0;

  let score = 0;

  // ── Participation floor  (0–15 pts) ──────────────────────────────────────
  // Awarded to any wallet with verified on-chain trade evidence.
  // Ensures classified wallets score above 0.15 even with no closed positions.
  //   8 pts — at least one evidenced position
  //   4 pts — at least one position has real SOL investment (> 0.001 SOL)
  //   3 pts — at least one position has a non-UNKNOWN status (confirmed tx)
  score += 8;
  const hasRealInvestment = evidenced.some((p) => (p.initialInvestment ?? 0) > 0.001);
  if (hasRealInvestment) score += 4;
  const hasConfirmedStatus = evidenced.some((p) => p.positionStatus !== 'UNKNOWN');
  if (hasConfirmedStatus) score += 3;

  // ── Win rate  (0–30 pts) ─────────────────────────────────────────────────
  // Reduced from 35 to accommodate the participation floor.
  if (winRate != null) {
    score += Math.min(30, Math.round(winRate * 30));
  }

  // ── Average ROI  (0–25 pts, capped at 10×) ───────────────────────────────
  // Reduced from 35. Cap prevents dust-investment outliers (e.g. 108 000x).
  if (averageRoi != null) {
    const capped = Math.min(averageRoi, 10);
    score += Math.min(25, Math.round((capped / 10) * 25));
  }

  // ── Conviction  (0–10 pts) ───────────────────────────────────────────────
  if (convictionScore != null) {
    score += Math.min(10, Math.round(convictionScore / 10));
  }

  // ── Multi-token breadth  (0–10 pts, log-scaled) ──────────────────────────
  score += Math.min(10, Math.round(Math.log2(evidenced.length + 1) * 5));

  // ── Classification bonus  (0–10 pts) ─────────────────────────────────────
  // retail raised 3 → 5: retail with real trades was underweighted.
  const classBonuses: Record<WalletClassification, number> = {
    smart_money: 10,
    sniper:       7,
    whale:        5,
    bot:          2,
    retail:       5,
    unknown:      0,
  };
  score += classBonuses[classification] ?? 0;

  return Math.min(100, Math.max(0, score));
}
