// Shared types for the Advanced Manipulation Detection engine.
// Map your existing trade/transaction shape onto `Trade` before calling
// the detector. Anything you don't have can be left undefined — the
// individual layers degrade gracefully.

import type { EntityLabel, TradeOrigin } from "./mapper";

export interface Trade {
  /** Unique signature / tx hash */
  signature: string;
  /** Unix epoch (ms) */
  timestamp: number;
  /** Wallet that initiated the trade */
  wallet: string;
  /** "buy" or "sell" relative to the token being scanned */
  side: "buy" | "sell";
  /** Token amount traded (absolute, in UI units) */
  amount: number;
  /** Quote-side amount, e.g. SOL or USD value */
  quoteAmount?: number;

  // ---- Optional on-chain metadata (Solana-flavoured) ----
  /** Compute units consumed by the tx */
  computeUnits?: number;
  /** Hash/fingerprint of the instruction data layout (see helpers below) */
  instructionFingerprint?: string;
  /** Programs invoked, in order */
  programIds?: string[];
  /** Optional source-of-funds wallet (first funder of `wallet`) */
  funderWallet?: string;

  // ---- Enrichment layer (populated by mapper.ts) ----
  /** Registry / heuristic label for the initiating wallet */
  walletEntity?: EntityLabel;
  /** Was this trade signed by a human via a wallet UI, or a bot? */
  origin?: TradeOrigin;
  /** 0–1 confidence in `origin` */
  originConfidence?: number;
  /** Human-readable reasons that justified the classification */
  originReasons?: string[];

  // ---- Counter-party metadata (Phase 2) ----
  /** Counter-party wallet on the other side of the swap, if known */
  counterpartyWallet?: string;
  /** Entity label of the counter-party (if resolvable) */
  counterpartyEntity?: EntityLabel;
}

export interface DetectionResult {
  /** 0 = clean, 100 = almost certainly manipulated */
  anomalyScore: number;
  /** Human-readable verdict */
  verdict: "clean" | "suspicious" | "likely_manipulated" | "manipulated";
  /** Ordered list of patterns detected (highest weight first) */
  patterns: DetectedPattern[];
  /** Per-layer breakdown for UI / debugging */
  breakdown: {
    walletCluster: number;
    tradeCadence: number;
    netZero: number;
    txMetadata: number;
    /** Phase 2 — added so UI can render the new lanes */
    washTrading?: number;
    sybilCluster?: number;
    liquidityImpact?: number;
  };

  // ---- Phase 2 surfaced metrics for the frontend ----
  /** 0–100 — confidence that volume is artificial / wash-traded */
  washTradingScore?: number;
  /** Categorical risk level for the Sybil-cluster layer */
  clusterRiskLevel?: ClusterRiskLevel;
  /** 0–1 — fractional price move expected for the simulated sell size */
  slippageImpactRatio?: number;
}

export type ClusterRiskLevel = "none" | "low" | "medium" | "high" | "critical";

export interface DetectedPattern {
  id:
    | "shared_funding_source"
    | "internal_circular_trading"
    | "robotic_cadence"
    | "burst_cadence"
    | "round_trip_net_zero"
    | "identical_instruction_fingerprint"
    | "uniform_compute_units"
    | "programmatic_dominance"
    | "mixer_counterparty"
    // Phase 2 additions
    | "artificial_wash_trading"
    | "uniform_trade_size"
    | "circular_top_holder_trading"
    | "sybil_cluster"
    | "synchronized_sybil_activity"
    | "shallow_liquidity"
    | "high_slippage_impact";
  label: string;
  description: string;
  /** 0–100, contribution to the score */
  weight: number;
  /** Optional evidence (wallets, sample sigs, intervals…) */
  evidence?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Off-chain intelligence types
// Added to support the offChainIntelligence service.
// ---------------------------------------------------------------------------

/**
 * A single social signal detected during hype scoring.
 */
export interface HypeSignal {
  /** Human-readable source label (e.g. "Twitter/@handle", "Telegram") */
  source: string;
  /** Classification of the signal */
  type: "quality_mention" | "spam_mention" | "neutral";
  /** Mention count or member count, depending on platform */
  count: number;
  /** Up to three representative examples */
  examples?: string[];
}

/**
 * A single flag raised by the website authenticity audit.
 */
export interface WebsiteFlag {
  /** Short machine-readable identifier */
  id: string;
  /** Human-readable label (shown in UI) */
  label: string;
  /** Severity of this finding */
  severity: "critical" | "high" | "warn" | "info";
  /** Full explanation for the UI tooltip / detail panel */
  detail: string;
}

/**
 * Consolidated off-chain intelligence result.
 *
 * Produced by `runOffChainIntelligence()` in offChainIntelligence.ts and
 * passed into `buildScanResult()` via `RawInputs.offChain`.
 */
export interface OffChainIntelligenceResult {
  /** False when all external checks failed or no URLs were available. */
  available: boolean;

  // --- Social sentiment ---
  /**
   * 0–100 hype score.
   * 0 = highly organic discourse; 100 = pure spam / artificial hype.
   */
  hypeScore: number;
  /** Qualitative classification of the social signal mix. */
  hypeVerdict: "organic" | "mixed" | "spam_heavy" | "unavailable";
  /** Detailed per-source signals that produced the hype score. */
  hypeSignals: HypeSignal[];

  // --- Website authenticity ---
  /**
   * Letter grade for the project website.
   * A = no red flags; F = broken / plagiarised / placeholder.
   * "unavailable" when no website URL was provided or the fetch failed.
   */
  websiteAuthenticityGrade: "A" | "B" | "C" | "D" | "F" | "unavailable";
  /** Individual flags raised during the website audit. */
  websiteFlags: WebsiteFlag[];

  // --- Intent scoring ---
  /**
   * 0–100 intent risk score.
   * 0 = genuine project effort; 100 = strong indicators of malicious intent.
   * Derived from hypeScore + websiteAuthenticityGrade.
   */
  intentScore: number;
  /** Qualitative verdict for the intent score. */
  intentVerdict: "genuine" | "suspicious" | "likely_scam" | "unavailable";

  /**
   * Unified developer risk score (0–100, higher = more risky).
   * Blends on-chain developer reputation with the off-chain intent score.
   * This is the value used by the Global Risk Score synthesis engine.
   * Rule: "Safe on-chain code does not override dangerous off-chain behavior."
   */
  unifiedDevScore: number;
}
