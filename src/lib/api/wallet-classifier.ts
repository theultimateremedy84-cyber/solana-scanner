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
//
// PATCH NOTES (scoring-patch v6 — conditional participation floor):
//   Audit (2026-07-12) against live production data confirmed the v4/v5
//   patches were not enough: ALL top-20 wallets by intelligence_score still
//   had realized_pnl = 0 and total_buys of 0 or 1. Root cause: the 15-pt
//   participation floor (score += 8/4/3 below) was unconditional — it fired
//   for ANY evidenced position, including zero-cost-basis "evidence" (e.g. a
//   token received via airdrop/transfer with no real SOL ever invested).
//   With win_rate/averageRoi null (and therefore contributing 0) for most of
//   the wallet base, that undamped 15-pt floor was enough to dominate the top
//   of a leaderboard where almost nothing else scores higher.
//
//   Fix: the participation floor now requires hasRealInvestment (at least one
//   position with > 0.001 SOL actually put at risk). Wallets with zero real
//   capital at risk score 0 and classify as "unknown" — they simply haven't
//   demonstrated anything yet, verified evidence or not.
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
  /**
   * Count of CLOSED positions backing winRate/averageRoi at score computation
   * time (scoring-patch v7). Persisted by the caller so confidence gating
   * doesn't need to recompute this from raw tx data on every read.
   */
  closedPositionCount: number;
}

/**
 * Coarse trust label for intelligence_score, derived from evidence quality
 * and closed-position count (scoring-patch v7 / architecture review
 * 2026-07-13). Deliberately does NOT factor in wallet age or last-trade
 * recency — those are already enforced at leaderboard read-time via
 * first_seen_timestamp/last_seen_timestamp (see leaderboard.functions.ts),
 * so folding them in here too would duplicate a gate that already exists
 * elsewhere. confidence_tier answers one question only: "how much evidence
 * backs this score," not "is this wallet currently active."
 *
 * fallback-derived scores hard-cap at "low" regardless of position count —
 * validated this session that wallet_performance_history (the fallback
 * source) can disagree with real per-tx evidence, so it never earns more
 * than baseline trust.
 */
export type ConfidenceTier = "elite" | "high" | "medium" | "low" | "unrated";

export function computeConfidenceTier(opts: {
  evidenceQuality:      "raw" | "fallback" | "none";
  closedPositionCount:  number;
}): ConfidenceTier {
  const { evidenceQuality, closedPositionCount } = opts;

  if (evidenceQuality === "none" || closedPositionCount <= 0) return "unrated";
  if (evidenceQuality === "fallback") return "low";

  if (closedPositionCount >= 20) return "elite";
  if (closedPositionCount >= 10) return "high";
  if (closedPositionCount >= 3)  return "medium";
  return "low";
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
// PATCH NOTES (scoring-patch v5 — minimum trade gate):
//   Audit (2026-07-11) confirmed every top-20 wallet by intelligence_score had
//   exactly 1 trade. A single profitable trade produces win_rate=1.0 and can
//   score 0.95+ under the existing formula, earning a smart_money or sniper
//   label that immediately destroys leaderboard credibility.
//
//   Two-part fix:
//   (A) MIN_BUYS_FOR_PREMIUM_CLASS: classification gate — a wallet must have at
//       least this many total buy transactions (cross-token) before it can be
//       labelled smart_money or sniper. 5 buys means at least 2–3 different
//       tokens or one token with a meaningful entry pattern.
//   (B) MIN_BUYS_FOR_SCORE_CONFIDENCE: score dampening — win_rate and ROI
//       contributions are multiplied by min(1, totalBuys / threshold). A
//       1-buy wallet gets 20% of those points; a 5-buy wallet gets 100%.
//       This prevents single-trade wallets from dominating the leaderboard
//       even under the "retail" label.
//
//   Both default to 5. Override via MIN_BUYS_FOR_PREMIUM env var in Railway.
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

/**
 * Minimum total buy transactions (cross-token) before a wallet may be
 * classified as smart_money or sniper.
 *
 * WHY 5: at 5 buys a wallet has demonstrated repeatable intent — either 2–3
 * different tokens each entered more than once, or one token with a meaningful
 * position-building pattern. Below this threshold a "100% win rate" is
 * indistinguishable from a single lucky trade.
 *
 * Override via MIN_BUYS_FOR_PREMIUM Railway env var.
 */
const MIN_BUYS_FOR_PREMIUM_CLASS = parseInt(process.env.MIN_BUYS_FOR_PREMIUM ?? "5", 10) || 5;

/**
 * Below this buy count the win_rate and ROI contributions to intelligence_score
 * are scaled by (totalBuys / MIN_BUYS_FOR_SCORE_CONFIDENCE), capped at 1.0.
 *
 * Effect: a 1-buy wallet earns 20% of those points; a 5-buy wallet earns 100%.
 * This prevents single-trade wallets from reaching 0.90+ and dominating the
 * leaderboard even under the "retail" label.
 *
 * Set to the same value as MIN_BUYS_FOR_PREMIUM_CLASS (same env var).
 */
const MIN_BUYS_FOR_SCORE_CONFIDENCE = MIN_BUYS_FOR_PREMIUM_CLASS;

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

  // scoring-patch v6: real capital at risk gate. "Evidenced" alone (e.g. a
  // token received via airdrop/transfer, or a phantom zero-cost position) is
  // not proof the wallet has ever traded with real money. No score, no
  // classification beyond "unknown" until at least one position shows > 0.001
  // SOL actually invested.
  const hasRealInvestment = evidenced.some((p) => (p.initialInvestment ?? 0) > 0.001);
  if (!hasRealInvestment) {
    return {
      classification:      "unknown",
      intelligenceScore:    0,
      discoveryScore:       null,
      convictionScore:      null,
      winRate:              null,
      averageRoi:           null,
      closedPositionCount:  0,
    };
  }

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
    totalBuys,
  });

  return {
    classification,
    intelligenceScore,
    discoveryScore,
    convictionScore,
    winRate,
    averageRoi,
    closedPositionCount: closed.length,
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

  // NOTE (2026-07-12): an earlier version of this patch hard-classified any
  // wallet with a 100% win rate across 10+ closed positions as "bot". Per
  // product decision, classification must not be permanently overridden on a
  // single heuristic like this — a flawless record is suspicious but not
  // proof. Instead this signal (and others) feeds a separate, non-binding
  // "bot probability" score computed in scripts/bot-probability.ts for human
  // review on the validation report; it does not affect classification or
  // intelligence_score.

  // ── Whale: large SOL volume —————————————————————————————————————————
  if (totalVolumeBoughtSol >= WHALE_SOL_THRESHOLD) return "whale";

  // ── Bot: mechanical high-frequency trading ──────────────────────────
  const sellBuyRatio = totalBuys > 0 ? totalSells / totalBuys : 0;
  if (sellBuyRatio >= BOT_SELL_BUY_RATIO && totalBuys >= BOT_MIN_BUYS) return "bot";

  // ── Smart money: consistent profitability ──────────────────────────
  // Tiered ROI gate prevents lucky-retail over-promotion:
  //   - 1 position: need ≥ 5× ROI (a single 57× trade is genuine; a 1.5× is noise)
  //   - 2+ positions: need ≥ 1.5× ROI (lower bar for repeatable performance)
  // GATE (scoring-patch v5): also requires MIN_BUYS_FOR_PREMIUM_CLASS total buys
  // so a single-trade wallet can never reach this label regardless of ROI.
  const roiMin = evidenced.length >= 2 ? SMART_MONEY_MIN_ROI_MULTI : SMART_MONEY_MIN_ROI_SINGLE;
  if (
    totalBuys   >= MIN_BUYS_FOR_PREMIUM_CLASS                  &&
    winRate     != null && winRate    >= SMART_MONEY_WIN_RATE   &&
    averageRoi  != null && averageRoi >= roiMin                 &&
    evidenced.length                  >= SMART_MONEY_MIN_TOKENS
  ) {
    return "smart_money";
  }

  // ── Sniper: enters early, flips quickly for meaningful profit ──────
  // Requires a minimum realized profit (0.1 SOL) to exclude dust-level wins.
  // GATE (scoring-patch v5): also requires MIN_BUYS_FOR_PREMIUM_CLASS total buys.
  // A single fast flip is luck; a wallet with 5+ buys that consistently flips
  // quickly is a genuine sniper pattern.
  const fastProfitableFlips = closed.filter((p) => {
    if (!p.firstTradeTs || !p.lastTradeTs) return false;
    const holdHours = (p.lastTradeTs - p.firstTradeTs) / 3600;
    return (
      holdHours <= SNIPER_MAX_HOLD_HOURS &&
      (p.realizedProfit ?? 0) >= SNIPER_MIN_PROFIT_SOL
    );
  });
  if (totalBuys >= MIN_BUYS_FOR_PREMIUM_CLASS && fastProfitableFlips.length >= SNIPER_MIN_FLIPS) return "sniper";

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
 *
 * PATCH (scoring-patch v5 — sample-size confidence):
 *   winRate and averageRoi contributions are multiplied by a confidence
 *   factor = min(1, totalBuys / MIN_BUYS_FOR_SCORE_CONFIDENCE).
 *
 *   WHY: with 1 buy, win_rate is a binary coin-flip — not a signal. Applying
 *   full weight to a 1.0 win_rate from a single trade inflated single-trade
 *   wallet scores to 0.90+ and let them top the leaderboard even as "retail".
 *   At 5 buys (the confidence threshold) the multiplier reaches 1.0 and the
 *   formula behaves identically to before this patch.
 *
 *   Score shape after patch (typical 1-buy wallet, win_rate=1.0, roi=5×):
 *     Before: 8+4+3 + 30 + 15 + 10 + 5 + 5 = 80  (0.80, tops the leaderboard)
 *     After:  8+4+3 + 6  + 3  + 10 + 5 + 5 = 44  (0.44, retail mid-tier)
 *
 * PATCH NOTES (scoring-patch v7 — remove non-skill components, 2026-07-13):
 *   Architecture review found two components summed into a "skill" score that
 *   aren't skill signals at all:
 *     - Multi-token breadth (0–10, log-scaled): diversity ≠ trading ability.
 *     - Classification bonus (0–10): rewarded the classification LABEL itself
 *       (e.g. "whale" got points just for large volume), double-counting a
 *       category the wallet already carries as its own field.
 *   Both removed from the formula entirely (not zeroed — deleted).
 *
 *   Remaining components (participation floor 15, win rate 30, avg ROI 25,
 *   conviction 10) sum to a new max of 80, not 100. To keep intelligence_score
 *   on the same 0–1 scale existing thresholds (e.g. the leaderboard's
 *   minScore=0.30 gate) were calibrated against, the four remaining
 *   components are rescaled by 100/80 after summing, so a wallet that maxes
 *   out every remaining component still reaches 100 (1.0), same as before.
 *   This changes every wallet's score relative to the old formula — by
 *   design, and intentionally bundled with the production rescore rather
 *   than shipped as a separate pass (architecture review recommendation).
 */
function computeIntelligenceScore(opts: {
  winRate:         number | null;
  averageRoi:      number | null;
  convictionScore: number | null;
  classification:  WalletClassification;
  evidenced:       ReconstructedPosition[];
  totalBuys:       number;
}): number {
  const { winRate, averageRoi, convictionScore, evidenced, totalBuys } = opts;

  if (evidenced.length === 0) return 0;

  // ── Sample-size confidence multiplier (0.0 – 1.0) ────────────────────────
  // Scales win_rate and ROI contributions by how statistically reliable they
  // are. Reaches 1.0 at MIN_BUYS_FOR_SCORE_CONFIDENCE total buy transactions.
  const sampleConfidence = MIN_BUYS_FOR_SCORE_CONFIDENCE > 0
    ? Math.min(1.0, totalBuys / MIN_BUYS_FOR_SCORE_CONFIDENCE)
    : 1.0;

  let score = 0;

  // ── Participation floor  (0–15 pts) ──────────────────────────────────────
  // Awarded to any wallet with verified on-chain trade evidence.
  // NOT dampened by sampleConfidence — the floor is binary (traded or not).
  //   8 pts — at least one evidenced position
  //   4 pts — at least one position has real SOL investment (> 0.001 SOL)
  //   3 pts — at least one position has a non-UNKNOWN status (confirmed tx)
  score += 8;
  const hasRealInvestment = evidenced.some((p) => (p.initialInvestment ?? 0) > 0.001);
  if (hasRealInvestment) score += 4;
  const hasConfirmedStatus = evidenced.some((p) => p.positionStatus !== 'UNKNOWN');
  if (hasConfirmedStatus) score += 3;

  // ── Win rate  (0–30 pts, confidence-dampened) ─────────────────────────────
  // Full 30 pts at win_rate=1.0 AND totalBuys ≥ MIN_BUYS_FOR_SCORE_CONFIDENCE.
  // Reduced from 35 to accommodate the participation floor.
  if (winRate != null) {
    score += Math.min(30, Math.round(winRate * 30 * sampleConfidence));
  }

  // ── Average ROI  (0–25 pts, capped at 10×, confidence-dampened) ──────────
  // Reduced from 35. Cap prevents dust-investment outliers (e.g. 108 000x).
  if (averageRoi != null) {
    const capped = Math.min(averageRoi, 10);
    score += Math.min(25, Math.round((capped / 10) * 25 * sampleConfidence));
  }

  // ── Conviction  (0–10 pts) ───────────────────────────────────────────────
  // Not dampened — conviction is a current-state snapshot, not a historical rate.
  if (convictionScore != null) {
    score += Math.min(10, Math.round(convictionScore / 10));
  }

  // ── Breadth and Classification Bonus removed (scoring-patch v7) ──────────
  // See patch note above the function signature for why.

  // Rescale: remaining components max out at 80 (15+30+25+10), not 100.
  // Multiply by 100/80 so the 0–1 normalized score keeps the same ceiling
  // and existing thresholds (e.g. leaderboard minScore=0.30) stay meaningful.
  score = score * (100 / 80);

  return Math.min(100, Math.max(0, Math.round(score)));
}
