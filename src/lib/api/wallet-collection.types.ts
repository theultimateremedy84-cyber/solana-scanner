// =============================================================================
// Wallet Collection Worker — shared types  (v2 — position tracking)
// =============================================================================

/** A single job enqueued for wallet collection on a token. */
export interface WalletCollectionJob {
  tokenAddress: string;
  poolAddress?: string | null;
  marketCapUsd?: number | null;
  liquidityUsd?: number | null;
  holderCount?: number | null;
  tokenCreatedAt?: number | null;
  enqueuedAt: string;
  attempts: number;
  dbJobId?: string | null;
}

export type JobStatus = "pending" | "processing" | "done" | "failed";

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
  /** True if this wallet was found via holder scan (no real SOL data). */
  isHolderOnly?: boolean;
}

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
  tokenAmount: number;
}

export interface HeliusNativeTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  amount: number; // lamports
}

/**
 * How far through a position a wallet is.
 *   OPEN             — bought, has not sold anything yet
 *   PARTIALLY_CLOSED — sold some tokens, still holds a remainder
 *   CLOSED           — sold ≥95% of what they bought
 *   UNKNOWN          — holder-only data, no investment cost available
 */
export type PositionStatus = "OPEN" | "PARTIALLY_CLOSED" | "CLOSED" | "UNKNOWN";

/**
 * Live price data fetched from DexScreener for a single token.
 * All values are null when the fetch fails or the token has no pairs.
 */
export interface TokenPriceData {
  priceSol:      number | null; // price per token in SOL (priceNative)
  priceUsd:      number | null;
  marketCapUsd:  number | null;
  fetchedAt:     string;        // ISO timestamp
}

/** Result returned by the worker for a completed collection run. */
export interface CollectionResult {
  tokenAddress: string;
  poolAddress?: string | null;
  tradersCollected: number;
  buyersCollected: number;
  sellersCollected: number;
  skippedDust: number;
  skippedAirdrop: number;
  errors: string[];
}
