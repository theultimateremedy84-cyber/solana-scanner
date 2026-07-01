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
const WHALE_SOL_THRESHOLD    = 50;   // SOL volume total to qualify as whale
const BOT_SELL_BUY_RATIO     = 0.8;  // sells / buys ratio
const BOT_MIN_BUYS           = 10;   // minimum buy count for bot classification
const SMART_MONEY_WIN_RATE   = 0.65; // 65% win rate
const SMART_MONEY_MIN_ROI    = 1.5;  // 1.5× average ROI  (was 2.0 — lowered to match data density)
const SMART_MONEY_MIN_TOKENS = 2;    // minimum distinct tokens traded  (was 3)
const SNIPER_MAX_HOLD_HOURS  = 4;    // quick flip window
const SNIPER_MIN_FLIPS       = 2;    // minimum quick profitable exits

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

  // ── Smart money: consistent profitability across multiple tokens ────
  if (
    winRate     != null && winRate     >= SMART_MONEY_WIN_RATE &&
    averageRoi  != null && averageRoi  >= SMART_MONEY_MIN_ROI  &&
    evidenced.length                   >= SMART_MONEY_MIN_TOKENS
  ) {
    return "smart_money";
  }

  // ── Sniper: enters early, flips quickly for profit ─────────────────
  const fastProfitableFlips = closed.filter((p) => {
    if (!p.firstTradeTs || !p.lastTradeTs) return false;
    const holdHours = (p.lastTradeTs - p.firstTradeTs) / 3600;
    return holdHours <= SNIPER_MAX_HOLD_HOURS && (p.realizedProfit ?? 0) > 0;
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

  // Win rate component  (0–35 pts)
  if (winRate != null) {
    score += Math.min(35, Math.round(winRate * 35));
  }

  // Average ROI component  (0–35 pts, capped at 10× for scoring)
  if (averageRoi != null) {
    const capped = Math.min(averageRoi, 10);
    score += Math.min(35, Math.round((capped / 10) * 35));
  }

  // Conviction component  (0–10 pts)
  if (convictionScore != null) {
    score += Math.min(10, Math.round(convictionScore / 10));
  }

  // Multi-token breadth  (0–10 pts)
  score += Math.min(10, evidenced.length * 2);

  // Classification bonus  (0–10 pts)
  const classBonuses: Record<WalletClassification, number> = {
    smart_money: 10,
    sniper:       7,
    whale:        5,
    bot:          2,
    retail:       3,
    unknown:      0,
  };
  score += classBonuses[classification] ?? 0;

  return Math.min(100, Math.max(0, score));
}
