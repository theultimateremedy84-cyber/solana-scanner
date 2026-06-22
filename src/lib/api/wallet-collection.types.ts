// =============================================================================
// Wallet Collection Worker — shared types
// =============================================================================

/** A single job enqueued for wallet collection on a token. */
export interface WalletCollectionJob {
  /** Solana mint address of the token. */
  tokenAddress: string;
  /** DEX pool address (e.g. Raydium AMM or Pump.fun bonding curve). */
  poolAddress: string;
  /** Market-cap at scan time in USD (stored as entry_market_cap). */
  marketCapUsd?: number | null;
  /** Liquidity at scan time in USD. */
  liquidityUsd?: number | null;
  /** Holder count at scan time. */
  holderCount?: number | null;
  /** Token mint/creation timestamp (Unix seconds). */
  tokenCreatedAt?: number | null;
  /** ISO timestamp when this job was enqueued. */
  enqueuedAt: string;
  /** Number of times this job has been attempted. */
  attempts: number;
}

/** Status of a job as it moves through the queue. */
export type JobStatus = "pending" | "processing" | "done" | "failed";

/** Internal queue entry — extends the job with runtime state. */
export interface QueueEntry extends WalletCollectionJob {
  status: JobStatus;
  lastError?: string;
}

/** A parsed buyer/seller from a Helius Enhanced Transaction. */
export interface ParsedTrader {
  walletAddress: string;
  transactionSignature: string;
  actionType: "buy" | "sell";
  amountSol: number;
  tokenAmount: number;
  timestamp: number; // Unix seconds
}

/** Helius Enhanced Transaction shape (relevant fields only). */
export interface HeliusEnhancedTx {
  signature: string;
  timestamp: number;
  feePayer: string;
  source?: string;
  tokenTransfers?: HeliusTokenTransfer[];
  nativeTransfers?: HeliusNativeTransfer[];
}

export interface HeliusTokenTransfer {
  mint: string;
  fromUserAccount: string;
  toUserAccount: string;
  /** Decimal-adjusted token amount. */
  tokenAmount: number;
}

export interface HeliusNativeTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  /** Amount in lamports. */
  amount: number;
}

/** Result returned by the worker for a completed collection run. */
export interface CollectionResult {
  tokenAddress: string;
  poolAddress: string;
  tradersCollected: number;
  buyersCollected: number;
  sellersCollected: number;
  skippedDust: number;
  skippedAirdrop: number;
  errors: string[];
}
