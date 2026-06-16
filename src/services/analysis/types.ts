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
