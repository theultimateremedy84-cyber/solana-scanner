// =============================================================================
// Wallet Intelligence Profile — shared TypeScript types
//
// Used by wallet-profile.functions.ts (server) and wallet.$address.tsx (client).
// =============================================================================

export type RiskAppetite = "degen" | "high" | "medium" | "conservative" | "unknown";
export type BadgeColor = "gold" | "silver" | "green" | "blue" | "orange" | "red" | "purple";
export type TimelineEventType =
  | "buy"
  | "sell"
  | "milestone_100k"
  | "milestone_500k"
  | "milestone_1m"
  | "milestone_5m";

// ── Section 1: Identity ───────────────────────────────────────────────────────
export interface WalletIdentity {
  walletAddress: string;
  classification: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
  discoveryConfidence: number | null;
}

// ── Section 2: Intelligence ───────────────────────────────────────────────────
export interface WalletIntelligence {
  intelligenceScore: number | null;
  discoveryScore: number | null;
  discoveryTier: string | null;
  discoveryConfidence: number | null;
  winRate: number | null;
  avgRoi: number | null;
  bestRoi: number | null;
  worstRoi: number | null;
  convictionScore: number | null;
}

// ── Section 3: Discovery Ability ──────────────────────────────────────────────
export interface WalletDiscovery {
  totalDiscoveries: number;
  successfulDiscoveries: number;
  discoverySuccessPct: number | null;
  avgEntryMarketCap: number | null;
  avgTokenAgeSecs: number | null;
  tokensReaching100k: number;
  tokensReaching500k: number;
  tokensReaching1m: number;
  tokensReaching5m: number;
}

// ── Section 4: Performance ────────────────────────────────────────────────────
export interface WalletPerformanceSummary {
  totalInvested: number;
  totalReturned: number;
  totalProfit: number;
  realizedPnl: number;
  unrealizedPnl: number;
  avgMultiple: number | null;
  largestWin: number | null;
  largestLoss: number | null;
  openPositions: number;
  closedPositions: number;
  partiallyClosedPositions: number;
  unknownPositions: number;
}

// ── Section 5: Trading Style ──────────────────────────────────────────────────
export interface WalletTradingStyle {
  avgBuySize: number | null;
  medianBuySize: number | null;
  avgHoldTimeSecs: number | null;
  preferredMarketCap: number | null;
  preferredLiquidity: number | null;
  preferredTokenAgeSecs: number | null;
  riskAppetite: RiskAppetite;
}

// ── Section 6: Token History (one row per token) ──────────────────────────────
export interface TokenHistoryEntry {
  tokenAddress: string;
  buyTime: string | null;
  sellTime: string | null;
  entryMc: number | null;
  holdTimeSecs: number | null;
  roi: number | null;
  profit: number | null;
  status: string | null;
  reached100k: boolean;
  reached500k: boolean;
  reached1m: boolean;
  reached5m: boolean;
}

// ── Section 7: Timeline ───────────────────────────────────────────────────────
export interface TimelineEvent {
  timestamp: string;
  type: TimelineEventType;
  tokenAddress: string;
  label: string;
  amountSol?: number | null;
  amountUsd?: number | null;
  entryMc?: number | null;
}

// ── Section 8: Badges ─────────────────────────────────────────────────────────
export interface Badge {
  id: string;
  label: string;
  description: string;
  color: BadgeColor;
}

// ── Section 9/10: Recommendation ─────────────────────────────────────────────
// A single deterministic verdict summarising all existing metrics for a
// non-technical reader. Never estimated — derived only from stored scores.

export type RecommendationType = "worth_following" | "watch_only" | "avoid";

export interface Recommendation {
  verdict: RecommendationType;
  /** Short headline shown in the identity bar. */
  headline: string;
  /** 2–4 bullet points explaining the verdict. */
  rationale: string[];
}

// ── Composite profile ─────────────────────────────────────────────────────────
export interface WalletProfileData {
  identity: WalletIdentity;
  intelligence: WalletIntelligence;
  discovery: WalletDiscovery;
  performance: WalletPerformanceSummary;
  tradingStyle: WalletTradingStyle;
  tokenHistory: TokenHistoryEntry[];
  timeline: TimelineEvent[];
  badges: Badge[];
  strengths: string[];
  weaknesses: string[];
  recommendation: Recommendation;
}
