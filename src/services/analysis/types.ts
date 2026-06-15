// Shared types for the Advanced Manipulation Detection engine.
// Map your existing trade/transaction shape onto `Trade` before calling
// the detector. Anything you don't have can be left undefined — the
// individual layers degrade gracefully.

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
  };
}

export interface DetectedPattern {
  id:
    | "shared_funding_source"
    | "internal_circular_trading"
    | "robotic_cadence"
    | "burst_cadence"
    | "round_trip_net_zero"
    | "identical_instruction_fingerprint"
    | "uniform_compute_units";
  label: string;
  description: string;
  /** 0–100, contribution to the score */
  weight: number;
  /** Optional evidence (wallets, sample sigs, intervals…) */
  evidence?: Record<string, unknown>;
}
