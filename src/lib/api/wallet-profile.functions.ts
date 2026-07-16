// =============================================================================
// Wallet Intelligence Profile — server aggregation function
//
// Single createServerFn that fetches all data for a wallet in parallel and
// returns a fully-aggregated WalletProfileData object.
//
// Data sources (read-only):
//   wallets                   — identity, scores, classification
//   wallet_performance_history — per-token P&L, milestones, position status
//   wallet_token_activity      — buy/sell events, entry MC, token age
//   wallet_raw_tx_metrics      — first/last tx timestamps (hold time proxy)
//
// Badge/Strength/Weakness thresholds are all constants in BADGE_THRESHOLDS.
// No AI. No alternative score calculations. No schema changes.
// =============================================================================

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type {
  WalletProfileData,
  WalletIdentity,
  WalletIntelligence,
  WalletDiscovery,
  WalletPerformanceSummary,
  WalletTradingStyle,
  TokenHistoryEntry,
  TimelineEvent,
  Badge,
  Recommendation,
  RiskAppetite,
  TimelineEventType,
} from "./wallet-profile.types";
import type { ServiceResult } from "./wallet-intelligence.types";

// ── Input validation ──────────────────────────────────────────────────────────

const solanaAddress = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "Invalid Solana address");

// ── Extended DB row shapes (include columns added by later migrations) ─────────

interface ExtendedWalletRow {
  wallet_address: string;
  first_seen_timestamp: string | null;
  last_seen_timestamp: string | null;
  wallet_classification: string | null;
  intelligence_score: number | null;
  discovery_score: number | null;
  discovery_confidence: number | null;
  discovery_tier: string | null;
  win_rate: number | null;
  average_roi: number | null;
  conviction_score: number | null;
  total_tokens_traded: number;
  // total_buys / total_sells intentionally omitted — unreliable for fallback-path
  // wallets (zero for ~40% of scored wallets). verified_positions is used instead.
  total_volume_bought_usd: number;
  total_volume_sold_usd: number;
  realized_pnl: number;
  unrealized_pnl: number;
  total_discoveries: number | null;
  successful_discoveries: number | null;
  avg_entry_market_cap: number | null;
  verified_positions: number | null;
  closed_position_count: number | null;
}

interface ExtendedPerfRow {
  token_address: string;
  initial_investment: number;
  current_value: number;
  realized_profit: number;
  unrealized_profit: number;
  roi_multiple: number | null;
  peak_roi: number | null;
  position_status: string | null;
  reached_100k_mc: boolean;
  reached_500k_mc: boolean;
  reached_1m_mc: boolean;
  reached_5m_mc: boolean;
  reached_10m_mc: boolean;
  reached_50m_mc: boolean;
  reached_100k_mc_at: string | null;
  reached_500k_mc_at: string | null;
  reached_1m_mc_at: string | null;
  reached_5m_mc_at: string | null;
}

interface ActivityRow {
  token_address: string;
  action_type: string;
  amount_sol: number | null;
  amount_usd: number | null;
  timestamp: string;
  entry_market_cap: number | null;
  liquidity_at_entry: number | null;
  token_age_at_entry: number | null;
}

interface RawMetricsRow {
  token_address: string;
  first_tx_at: string | null;
  last_tx_at: string | null;
}

// =============================================================================
// BADGE THRESHOLDS — single source of truth for all deterministic badge logic
// =============================================================================

export const BADGE_THRESHOLDS = {
  ULTRA_EARLY_MC:               10_000,   // avg entry MC < $10K
  EARLY_HUNTER_MC:              50_000,   // avg entry MC < $50K
  DIAMOND_HANDS_OPEN_PCT:       0.50,     // >50% positions still OPEN
  HIGH_CONVICTION_SCORE:        70,       // conviction_score > 70
  FAST_FLIPPER_HOLD_HOURS:      2,        // avg hold < 2 hours
  MILESTONE_HUNTER_1M_MIN:      3,        // 3+ positions reached $1M+
  WHALE_HUNTER_5M_MIN:          2,        // 2+ positions reached $5M+
  CONSISTENT_WINNER_WIN_RATE:   0.70,     // win_rate >= 70%
  CONSISTENT_WINNER_MIN_CLOSED: 3,        // at least 3 closed positions
  ROI_MONSTER_THRESHOLD:        5,        // avg ROI >= 5×
  DEGEN_AVG_AGE_SECS:           3_600,    // entered in first hour of token life
} as const;

// =============================================================================
// STRENGTH / WEAKNESS THRESHOLDS
// =============================================================================

const STRENGTH_THRESHOLDS = {
  EARLY_ENTRY_MC:        50_000,
  HIGH_WIN_RATE:         0.65,
  GREAT_ROI:             3,
  STRONG_MILESTONE_RATE: 0.30,
  HIGH_CONVICTION:       60,
  MULTI_5M_MIN:          2,
} as const;

const WEAKNESS_THRESHOLDS = {
  LATE_ENTRY_MC:         200_000,
  LOW_WIN_RATE:          0.40,
  MIN_CLOSED_THRESHOLD:  3,
  SHORT_HOLD_SECS:       1_800,  // 30 minutes
  SHORT_HOLD_LOW_ROI:    2,
  PEAK_GAP_PCT:          50,     // 50% gap between peak and exit ROI
  HIGH_UNKNOWN_PCT:      0.50,
} as const;

// ── Badge computation ─────────────────────────────────────────────────────────

function computeBadges(
  wallet: ExtendedWalletRow,
  perf: ExtendedPerfRow[],
  tradingStyle: WalletTradingStyle,
  performance: WalletPerformanceSummary,
): Badge[] {
  const badges: Badge[] = [];
  const mc      = wallet.avg_entry_market_cap;
  const winRate = wallet.win_rate;
  const avgRoi  = wallet.average_roi;

  if (mc != null && mc < BADGE_THRESHOLDS.ULTRA_EARLY_MC) {
    badges.push({
      id: "ultra_early",
      label: "Ultra Early",
      description: `Consistently enters tokens below $${(BADGE_THRESHOLDS.ULTRA_EARLY_MC / 1_000).toFixed(0)}K market cap`,
      color: "gold",
    });
  } else if (mc != null && mc < BADGE_THRESHOLDS.EARLY_HUNTER_MC) {
    badges.push({
      id: "early_hunter",
      label: "Early Hunter",
      description: `Consistently enters tokens below $${(BADGE_THRESHOLDS.EARLY_HUNTER_MC / 1_000).toFixed(0)}K market cap`,
      color: "green",
    });
  }

  const totalWithStatus = perf.filter((p) => p.position_status != null).length;
  const openCount       = perf.filter((p) => p.position_status === "OPEN").length;
  if (totalWithStatus > 0 && openCount / totalWithStatus >= BADGE_THRESHOLDS.DIAMOND_HANDS_OPEN_PCT) {
    badges.push({
      id: "diamond_hands",
      label: "Diamond Hands",
      description: `Over ${Math.round(BADGE_THRESHOLDS.DIAMOND_HANDS_OPEN_PCT * 100)}% of positions still open — holds through volatility`,
      color: "blue",
    });
  }

  if (wallet.conviction_score != null && wallet.conviction_score >= BADGE_THRESHOLDS.HIGH_CONVICTION_SCORE) {
    badges.push({
      id: "high_conviction",
      label: "High Conviction",
      description: "Maintains a high proportion of open positions, signaling strong conviction",
      color: "purple",
    });
  }

  if (
    tradingStyle.avgHoldTimeSecs != null &&
    tradingStyle.avgHoldTimeSecs < BADGE_THRESHOLDS.FAST_FLIPPER_HOLD_HOURS * 3_600
  ) {
    badges.push({
      id: "fast_flipper",
      label: "Fast Flipper",
      description: `Average hold time under ${BADGE_THRESHOLDS.FAST_FLIPPER_HOLD_HOURS}h — enters and exits quickly`,
      color: "orange",
    });
  }

  const hits1m = perf.filter(
    (p) => p.reached_1m_mc || p.reached_5m_mc || p.reached_10m_mc || p.reached_50m_mc,
  ).length;
  if (hits1m >= BADGE_THRESHOLDS.MILESTONE_HUNTER_1M_MIN) {
    badges.push({
      id: "milestone_hunter",
      label: "Milestone Hunter",
      description: `${hits1m} positions reached $1M+ market cap`,
      color: "gold",
    });
  }

  const hits5m = perf.filter(
    (p) => p.reached_5m_mc || p.reached_10m_mc || p.reached_50m_mc,
  ).length;
  if (hits5m >= BADGE_THRESHOLDS.WHALE_HUNTER_5M_MIN) {
    badges.push({
      id: "whale_hunter",
      label: "Whale Hunter",
      description: `${hits5m} positions reached $5M+ market cap`,
      color: "purple",
    });
  }

  if (
    winRate != null &&
    winRate >= BADGE_THRESHOLDS.CONSISTENT_WINNER_WIN_RATE &&
    performance.closedPositions >= BADGE_THRESHOLDS.CONSISTENT_WINNER_MIN_CLOSED
  ) {
    badges.push({
      id: "consistent_winner",
      label: "Consistent Winner",
      description: `${Math.round(winRate * 100)}% win rate across ${performance.closedPositions} closed positions`,
      color: "green",
    });
  }

  if (avgRoi != null && avgRoi >= BADGE_THRESHOLDS.ROI_MONSTER_THRESHOLD) {
    badges.push({
      id: "roi_monster",
      label: "ROI Monster",
      description: `Average return of ${avgRoi.toFixed(1)}× across all positions`,
      color: "gold",
    });
  }

  if (wallet.wallet_classification === "smart_money") {
    badges.push({
      id: "smart_money",
      label: "Smart Money",
      description: "Classified as smart money — consistently profitable with high win rates",
      color: "gold",
    });
  }

  if (wallet.wallet_classification === "sniper") {
    badges.push({
      id: "sniper",
      label: "Sniper",
      description: "Enters early and exits quickly for profit",
      color: "orange",
    });
  }

  return badges;
}

// ── Strength computation ──────────────────────────────────────────────────────

/**
 * Generate deterministic positive observations from existing wallet data.
 * All thresholds reference STRENGTH_THRESHOLDS — no AI, no heuristics.
 */
function computeStrengths(
  wallet: ExtendedWalletRow,
  perf: ExtendedPerfRow[],
  performance: WalletPerformanceSummary,
): string[] {
  const out: string[] = [];
  const mc      = wallet.avg_entry_market_cap;
  const winRate = wallet.win_rate;
  const avgRoi  = wallet.average_roi;

  if (mc != null && mc < STRENGTH_THRESHOLDS.EARLY_ENTRY_MC) {
    const label = mc < 10_000 ? `$${Math.round(mc / 1_000)}K` : `$${Math.round(mc / 1_000)}K`;
    out.push(`Consistently enters tokens before major moves (avg entry below ${label} MC)`);
  }

  if (winRate != null && winRate >= STRENGTH_THRESHOLDS.HIGH_WIN_RATE && performance.closedPositions > 0) {
    out.push(
      `High win rate of ${Math.round(winRate * 100)}% across ${performance.closedPositions} closed position${performance.closedPositions !== 1 ? "s" : ""}`,
    );
  }

  if (wallet.discovery_tier === "elite") {
    out.push("Elite discovery tier — among the top early entrants in the dataset");
  } else if (wallet.discovery_tier === "strong") {
    out.push("Strong discovery ability — reliably enters tokens before breakout");
  }

  if (avgRoi != null && avgRoi >= STRENGTH_THRESHOLDS.GREAT_ROI) {
    out.push(`Exceptional average return of ${avgRoi.toFixed(1)}× across positions`);
  }

  const milestoneRate = perf.length > 0
    ? perf.filter((p) => p.reached_1m_mc).length / perf.length
    : 0;
  if (milestoneRate >= STRENGTH_THRESHOLDS.STRONG_MILESTONE_RATE && perf.length >= 3) {
    out.push(`${Math.round(milestoneRate * 100)}% of traded tokens reached $1M+ market cap`);
  }

  if (wallet.conviction_score != null && wallet.conviction_score >= STRENGTH_THRESHOLDS.HIGH_CONVICTION) {
    out.push("Strong holding behaviour — stays in positions through market volatility");
  }

  const multi5m = perf.filter((p) => p.reached_5m_mc).length;
  if (multi5m >= STRENGTH_THRESHOLDS.MULTI_5M_MIN) {
    out.push(`${multi5m} positions have reached $5M+ market cap`);
  }

  return out.slice(0, 5);
}

// ── Weakness computation ──────────────────────────────────────────────────────

/**
 * Generate deterministic observations about trading weaknesses.
 * All thresholds reference WEAKNESS_THRESHOLDS — no AI.
 */
function computeWeaknesses(
  wallet: ExtendedWalletRow,
  perf: ExtendedPerfRow[],
  performance: WalletPerformanceSummary,
  tradingStyle: WalletTradingStyle,
): string[] {
  const out: string[] = [];
  const mc      = wallet.avg_entry_market_cap;
  const winRate = wallet.win_rate;
  const avgRoi  = wallet.average_roi;

  if (mc != null && mc > WEAKNESS_THRESHOLDS.LATE_ENTRY_MC) {
    out.push(
      `Tends to enter tokens late (avg entry at $${(mc / 1_000).toFixed(0)}K MC) — likely missing early gains`,
    );
  }

  if (winRate != null && winRate < WEAKNESS_THRESHOLDS.LOW_WIN_RATE && performance.closedPositions > 0) {
    out.push(
      `Below average win rate of ${Math.round(winRate * 100)}% — majority of closed positions are losses`,
    );
  }

  if (performance.closedPositions < WEAKNESS_THRESHOLDS.MIN_CLOSED_THRESHOLD) {
    out.push("Limited closed position history — not enough data for reliable performance assessment");
  }

  if (
    tradingStyle.avgHoldTimeSecs != null &&
    tradingStyle.avgHoldTimeSecs < WEAKNESS_THRESHOLDS.SHORT_HOLD_SECS &&
    (avgRoi == null || avgRoi < WEAKNESS_THRESHOLDS.SHORT_HOLD_LOW_ROI)
  ) {
    out.push("Very short average hold time — pattern suggests premature exits before peak gains");
  }

  const withBothRoi = perf.filter(
    (p) => p.roi_multiple != null && p.peak_roi != null && p.peak_roi > 0,
  );
  if (withBothRoi.length >= 3) {
    const avgGapPct =
      withBothRoi.reduce((s, p) => {
        const gap = ((p.peak_roi! - Math.max(p.roi_multiple!, 0)) / p.peak_roi!) * 100;
        return s + gap;
      }, 0) / withBothRoi.length;
    if (avgGapPct > WEAKNESS_THRESHOLDS.PEAK_GAP_PCT) {
      out.push("Frequently exits positions well below peak value — leaving significant gains on the table");
    }
  }

  const unknownPct = perf.length > 0 ? performance.unknownPositions / perf.length : 0;
  if (unknownPct > WEAKNESS_THRESHOLDS.HIGH_UNKNOWN_PCT && perf.length >= 3) {
    out.push("Majority of positions have incomplete transaction data — scores may be unreliable");
  }

  if (wallet.wallet_classification === "bot") {
    out.push("Trading pattern resembles automated bot behaviour — high sell/buy ratio with mechanical cadence");
  }

  return out.slice(0, 5);
}

// ── Recommendation computation ────────────────────────────────────────────────
//
// Three-tier verdict derived entirely from existing stored scores.
// No AI, no estimation. Thresholds are conservative to avoid false positives.
//
//  AVOID         — bot classification, very low win rate with real sample,
//                  or significantly negative P&L with poor win rate
//  WORTH FOLLOWING — smart_money/sniper with good intel score, win rate,
//                  and positive avg ROI
//  WATCH ONLY    — everything else (default — always safe to show)

const REC_THRESHOLDS = {
  AVOID_WIN_RATE:       0.30,  // < 30% wins with a real sample → Avoid
  AVOID_MIN_CLOSED:     3,     // require at least 3 closed positions to flag Avoid
  FOLLOW_INTEL_SCORE:   0.50,  // intelligence_score (stored 0–1) must exceed this
  FOLLOW_WIN_RATE:      0.55,  // win_rate must exceed this
  FOLLOW_AVG_ROI:       1.50,  // average_roi must exceed this
  FOLLOW_CLASSIFICATIONS: ["smart_money", "sniper"] as string[],
} as const;

function computeRecommendation(
  wallet: ExtendedWalletRow,
  performance: WalletPerformanceSummary,
): Recommendation {
  const cls      = wallet.wallet_classification;
  const winRate  = wallet.win_rate;
  const avgRoi   = wallet.average_roi;
  const intelScore = wallet.intelligence_score; // stored 0–1

  // ── AVOID ────────────────────────────────────────────────────────────────
  if (cls === "bot") {
    return {
      verdict: "avoid",
      headline: "Avoid",
      rationale: [
        "Trading pattern classified as automated bot — high-frequency, mechanical cadence",
        "Bot wallets typically exploit arbitrage or MEV, not genuine alpha",
        "Following a bot provides no useful signal for human traders",
      ],
    };
  }

  if (
    winRate != null &&
    winRate < REC_THRESHOLDS.AVOID_WIN_RATE &&
    performance.closedPositions >= REC_THRESHOLDS.AVOID_MIN_CLOSED
  ) {
    return {
      verdict: "avoid",
      headline: "Avoid",
      rationale: [
        `Win rate of ${Math.round(winRate * 100)}% across ${performance.closedPositions} closed positions — majority of trades are losses`,
        avgRoi != null && avgRoi < 1
          ? `Average ROI of ${avgRoi.toFixed(2)}× confirms consistently poor exits`
          : "Insufficient ROI data, but win rate alone warrants caution",
        "Tracking this wallet may lead to copying losing trades",
      ],
    };
  }

  // Significantly negative overall P&L with a low win rate
  if (
    performance.realizedPnl < -50 &&
    winRate != null &&
    winRate < 0.40 &&
    performance.closedPositions >= REC_THRESHOLDS.AVOID_MIN_CLOSED
  ) {
    return {
      verdict: "avoid",
      headline: "Avoid",
      rationale: [
        `Realized P&L is significantly negative ($${Math.abs(performance.realizedPnl).toFixed(0)} loss)`,
        `Win rate of ${Math.round(winRate * 100)}% with ${performance.closedPositions} closed positions confirms ongoing losses`,
        "Does not show the consistent profitability required to follow",
      ],
    };
  }

  // ── WORTH FOLLOWING ───────────────────────────────────────────────────────
  const hasGoodClassification = cls != null && REC_THRESHOLDS.FOLLOW_CLASSIFICATIONS.includes(cls);
  const hasGoodIntelScore     = intelScore != null && intelScore >= REC_THRESHOLDS.FOLLOW_INTEL_SCORE;
  const hasGoodWinRate        = winRate    != null && winRate    >= REC_THRESHOLDS.FOLLOW_WIN_RATE;
  const hasGoodRoi            = avgRoi     != null && avgRoi     >= REC_THRESHOLDS.FOLLOW_AVG_ROI;

  if (hasGoodClassification && hasGoodIntelScore && hasGoodWinRate && hasGoodRoi) {
    const rationale: string[] = [];
    rationale.push(
      `Classified as ${cls === "smart_money" ? "Smart Money" : "Sniper"} — consistently profitable trading pattern`,
    );
    rationale.push(
      `Intelligence score of ${((intelScore ?? 0) * 100).toFixed(0)}% with a ${Math.round((winRate ?? 0) * 100)}% win rate`,
    );
    rationale.push(
      `Average ROI of ${(avgRoi ?? 0).toFixed(2)}× across positions — real and repeatable returns`,
    );
    if (wallet.avg_entry_market_cap != null && wallet.avg_entry_market_cap < 50_000) {
      rationale.push(
        `Avg entry at ${fmtMcShort(wallet.avg_entry_market_cap)} MC — enters before most retail participants`,
      );
    }
    return { verdict: "worth_following", headline: "Worth Following", rationale };
  }

  // Partial "worth following" — excellent single metric
  if (hasGoodIntelScore && hasGoodRoi && avgRoi != null && avgRoi >= 3) {
    return {
      verdict: "worth_following",
      headline: "Worth Following",
      rationale: [
        `Strong average ROI of ${avgRoi.toFixed(2)}× — outperforms most tracked wallets`,
        intelScore != null
          ? `Intelligence score of ${(intelScore * 100).toFixed(0)}% confirms quality signal`
          : "Consistent positive returns across tracked positions",
        winRate != null
          ? `Win rate: ${Math.round(winRate * 100)}%`
          : "Win rate data pending — monitor before following aggressively",
      ],
    };
  }

  // ── WATCH ONLY (default) ──────────────────────────────────────────────────
  const rationale: string[] = [];

  if (performance.closedPositions < REC_THRESHOLDS.AVOID_MIN_CLOSED) {
    rationale.push(
      `Only ${performance.closedPositions} closed position${performance.closedPositions !== 1 ? "s" : ""} — insufficient track record for a confident verdict`,
    );
  } else if (winRate != null) {
    rationale.push(
      `Win rate of ${Math.round(winRate * 100)}% — shows some profitability but not consistently high enough to follow confidently`,
    );
  } else {
    rationale.push("No closed positions yet — hold time and exit quality are unknown");
  }

  if (avgRoi != null && avgRoi >= 1 && avgRoi < REC_THRESHOLDS.FOLLOW_AVG_ROI) {
    rationale.push(
      `Average ROI of ${avgRoi.toFixed(2)}× — positive but below the threshold for a strong follow recommendation`,
    );
  }

  rationale.push("Monitor for more closed positions and score improvement before copying trades");

  return { verdict: "watch_only", headline: "Watch Only", rationale };
}

/** Compact market cap string for use inside rationale text. */
function fmtMcShort(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/** Compute median of a non-empty numeric array. */
function computeMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Derive a risk appetite label from avg entry market cap and avg token age.
 *   degen        — avg MC < $10K AND entered in first hour
 *   high         — avg MC < $50K
 *   medium       — avg MC < $200K
 *   conservative — avg MC >= $200K
 *   unknown      — no MC data
 */
function computeRiskAppetite(
  avgEntryMc: number | null,
  avgTokenAgeSecs: number | null,
): RiskAppetite {
  if (avgEntryMc == null) return "unknown";
  if (avgEntryMc < 10_000 && (avgTokenAgeSecs == null || avgTokenAgeSecs < 3_600)) return "degen";
  if (avgEntryMc < 50_000) return "high";
  if (avgEntryMc < 200_000) return "medium";
  return "conservative";
}

// =============================================================================
// MAIN SERVER FUNCTION
// =============================================================================

export const getWalletProfile = createServerFn({ method: "GET" })
  .inputValidator(z.object({ walletAddress: solanaAddress }))
  .handler(
    async ({ data }): Promise<ServiceResult<WalletProfileData | null>> => {
      const { walletAddress } = data;

      // ── Fetch all tables in parallel ───────────────────────────────────────
      const [walletRes, perfRes, activityRes, rawMetricsRes] = await Promise.all([
        supabaseAdmin
          .from("wallets")
          .select("*")
          .eq("wallet_address", walletAddress)
          .limit(1),
        supabaseAdmin
          .from("wallet_performance_history")
          .select("*")
          .eq("wallet_address", walletAddress),
        supabaseAdmin
          .from("wallet_token_activity")
          .select("*")
          .eq("wallet_address", walletAddress)
          .order("timestamp", { ascending: false })
          .limit(1000),
        supabaseAdmin
          .from("wallet_raw_tx_metrics")
          .select("wallet_address, token_address, first_tx_at, last_tx_at")
          .eq("wallet_address", walletAddress),
      ]);

      if (walletRes.error) return { data: null, error: walletRes.error.message };
      if (!walletRes.data?.length) return { data: null, error: null };

      const walletRow     = walletRes.data[0] as unknown as ExtendedWalletRow;
      const perfRows      = (perfRes.data  ?? []) as unknown as ExtendedPerfRow[];
      const activityRows  = (activityRes.data   ?? []) as unknown as ActivityRow[];
      const rawMetricRows = (rawMetricsRes.data  ?? []) as unknown as RawMetricsRow[];

      // ── Identity ───────────────────────────────────────────────────────────
      const identity: WalletIdentity = {
        walletAddress:       walletRow.wallet_address,
        classification:      walletRow.wallet_classification,
        firstSeen:           walletRow.first_seen_timestamp,
        lastSeen:            walletRow.last_seen_timestamp,
        discoveryConfidence: walletRow.discovery_confidence,
      };

      // ── Intelligence ───────────────────────────────────────────────────────
      const rois = perfRows
        .map((p) => p.roi_multiple)
        .filter((v): v is number => v != null);

      const intelligence: WalletIntelligence = {
        intelligenceScore:   walletRow.intelligence_score,
        discoveryScore:      walletRow.discovery_score,
        discoveryTier:       walletRow.discovery_tier,
        discoveryConfidence: walletRow.discovery_confidence,
        winRate:             walletRow.win_rate,
        avgRoi:              walletRow.average_roi,
        bestRoi:             rois.length > 0 ? Math.max(...rois) : null,
        worstRoi:            rois.length > 0 ? Math.min(...rois) : null,
        convictionScore:     walletRow.conviction_score,
        verifiedPositions:   walletRow.verified_positions  ?? null,
        closedPositionCount: walletRow.closed_position_count ?? null,
      };

      // ── Discovery ──────────────────────────────────────────────────────────
      const buyActivity = activityRows.filter((a) => a.action_type === "buy");
      const tokenAges   = buyActivity
        .map((a) => a.token_age_at_entry)
        .filter((v): v is number => v != null);
      const avgTokenAgeSecs = tokenAges.length > 0
        ? tokenAges.reduce((s, v) => s + v, 0) / tokenAges.length
        : null;

      const totalDiscoveries     = walletRow.total_discoveries     ?? perfRows.length;
      const successfulDiscoveries = walletRow.successful_discoveries ?? perfRows.filter((p) => p.reached_1m_mc).length;

      const discovery: WalletDiscovery = {
        totalDiscoveries,
        successfulDiscoveries,
        discoverySuccessPct: totalDiscoveries > 0 ? successfulDiscoveries / totalDiscoveries : null,
        avgEntryMarketCap:   walletRow.avg_entry_market_cap,
        avgTokenAgeSecs,
        tokensReaching100k: perfRows.filter((p) => p.reached_100k_mc).length,
        tokensReaching500k: perfRows.filter((p) => p.reached_500k_mc).length,
        tokensReaching1m:   perfRows.filter((p) => p.reached_1m_mc).length,
        tokensReaching5m:   perfRows.filter((p) => p.reached_5m_mc).length,
      };

      // ── Performance ────────────────────────────────────────────────────────
      const profits   = perfRows.map((p) => p.realized_profit).filter((v): v is number => v != null);
      const multiples = perfRows.map((p) => p.roi_multiple).filter((v): v is number => v != null);

      const performance: WalletPerformanceSummary = {
        totalInvested: walletRow.total_volume_bought_usd,
        totalReturned: walletRow.total_volume_sold_usd,
        totalProfit:   walletRow.realized_pnl + walletRow.unrealized_pnl,
        realizedPnl:   walletRow.realized_pnl,
        unrealizedPnl: walletRow.unrealized_pnl,
        avgMultiple:
          multiples.length > 0
            ? multiples.reduce((s, v) => s + v, 0) / multiples.length
            : null,
        largestWin:
          profits.some((p) => p > 0) ? Math.max(...profits.filter((p) => p > 0)) : null,
        largestLoss:
          profits.some((p) => p < 0) ? Math.min(...profits.filter((p) => p < 0)) : null,
        openPositions:            perfRows.filter((p) => p.position_status === "OPEN").length,
        closedPositions:          perfRows.filter((p) => p.position_status === "CLOSED").length,
        partiallyClosedPositions: perfRows.filter((p) => p.position_status === "PARTIALLY_CLOSED").length,
        unknownPositions:         perfRows.filter((p) => !p.position_status || p.position_status === "UNKNOWN").length,
      };

      // ── Trading Style ──────────────────────────────────────────────────────
      const buySizes = buyActivity
        .map((a) => a.amount_usd)
        .filter((v): v is number => v != null && v > 0);
      const avgBuySize    = buySizes.length > 0 ? buySizes.reduce((s, v) => s + v, 0) / buySizes.length : null;
      const medianBuySize = buySizes.length > 0 ? computeMedian(buySizes) : null;

      const holdTimes = rawMetricRows
        .filter((r) => r.first_tx_at != null && r.last_tx_at != null)
        .map((r) => (new Date(r.last_tx_at!).getTime() - new Date(r.first_tx_at!).getTime()) / 1_000)
        .filter((d) => d > 0);
      const avgHoldTimeSecs = holdTimes.length > 0
        ? holdTimes.reduce((s, v) => s + v, 0) / holdTimes.length
        : null;

      const entryMcs = buyActivity
        .map((a) => a.entry_market_cap)
        .filter((v): v is number => v != null && v > 0);
      const preferredMarketCap = entryMcs.length > 0 ? computeMedian(entryMcs) : null;

      const liquidities = buyActivity
        .map((a) => a.liquidity_at_entry)
        .filter((v): v is number => v != null && v > 0);
      const preferredLiquidity = liquidities.length > 0 ? computeMedian(liquidities) : null;

      const tradingStyle: WalletTradingStyle = {
        avgBuySize,
        medianBuySize,
        avgHoldTimeSecs,
        preferredMarketCap,
        preferredLiquidity,
        preferredTokenAgeSecs: avgTokenAgeSecs,
        riskAppetite: computeRiskAppetite(walletRow.avg_entry_market_cap, avgTokenAgeSecs),
      };

      // ── Token History ──────────────────────────────────────────────────────
      // Build per-token buy time (oldest), sell time (newest), and entry MC
      // from activity rows (already sorted newest-first from query).
      const buyTimeByToken   = new Map<string, string>();
      const sellTimeByToken  = new Map<string, string>();
      const entryMcByToken   = new Map<string, number | null>();

      for (const act of [...activityRows].reverse()) {  // oldest first
        if (act.action_type === "buy") {
          if (!buyTimeByToken.has(act.token_address)) {
            buyTimeByToken.set(act.token_address, act.timestamp);
            entryMcByToken.set(act.token_address, act.entry_market_cap);
          }
        } else if (act.action_type === "sell") {
          sellTimeByToken.set(act.token_address, act.timestamp);  // overwrite → newest
        }
      }

      const holdTimeByToken = new Map<string, number | null>();
      for (const raw of rawMetricRows) {
        if (raw.first_tx_at && raw.last_tx_at) {
          const diffSecs = (new Date(raw.last_tx_at).getTime() - new Date(raw.first_tx_at).getTime()) / 1_000;
          holdTimeByToken.set(raw.token_address, diffSecs > 0 ? diffSecs : null);
        }
      }

      const tokenHistory: TokenHistoryEntry[] = perfRows.map((p) => ({
        tokenAddress: p.token_address,
        buyTime:      buyTimeByToken.get(p.token_address)  ?? null,
        sellTime:     sellTimeByToken.get(p.token_address) ?? null,
        entryMc:      entryMcByToken.get(p.token_address)  ?? null,
        holdTimeSecs: holdTimeByToken.get(p.token_address) ?? null,
        roi:          p.roi_multiple,
        profit:       p.realized_profit,
        status:       p.position_status,
        reached100k:  p.reached_100k_mc,
        reached500k:  p.reached_500k_mc,
        reached1m:    p.reached_1m_mc,
        reached5m:    p.reached_5m_mc,
      }));

      // ── Timeline ───────────────────────────────────────────────────────────
      const timelineEvents: TimelineEvent[] = [];

      for (const act of activityRows.slice(0, 300)) {
        timelineEvents.push({
          timestamp:   act.timestamp,
          type:        act.action_type as "buy" | "sell",
          tokenAddress: act.token_address,
          label:        act.action_type === "buy" ? "Buy" : "Sell",
          amountSol:    act.amount_sol,
          amountUsd:    act.amount_usd,
          entryMc:      act.entry_market_cap,
        });
      }

      const milestoneKeys: Array<{
        field: keyof Pick<ExtendedPerfRow, "reached_100k_mc_at" | "reached_500k_mc_at" | "reached_1m_mc_at" | "reached_5m_mc_at">;
        type: TimelineEventType;
        label: string;
      }> = [
        { field: "reached_100k_mc_at", type: "milestone_100k", label: "Reached $100K MC" },
        { field: "reached_500k_mc_at", type: "milestone_500k", label: "Reached $500K MC" },
        { field: "reached_1m_mc_at",   type: "milestone_1m",   label: "Reached $1M MC" },
        { field: "reached_5m_mc_at",   type: "milestone_5m",   label: "Reached $5M MC" },
      ];

      for (const p of perfRows) {
        for (const m of milestoneKeys) {
          const at = p[m.field];
          if (at) {
            timelineEvents.push({
              timestamp:    at,
              type:         m.type,
              tokenAddress: p.token_address,
              label:        m.label,
            });
          }
        }
      }

      timelineEvents.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      const timeline = timelineEvents.slice(0, 100);

      // ── Badges, Strengths, Weaknesses, Recommendation ─────────────────────
      const badges         = computeBadges(walletRow, perfRows, tradingStyle, performance);
      const strengths      = computeStrengths(walletRow, perfRows, performance);
      const weaknesses     = computeWeaknesses(walletRow, perfRows, performance, tradingStyle);
      const recommendation = computeRecommendation(walletRow, performance);

      return {
        data: {
          identity,
          intelligence,
          discovery,
          performance,
          tradingStyle,
          tokenHistory,
          timeline,
          badges,
          strengths,
          weaknesses,
          recommendation,
        },
        error: null,
      };
    },
  );
