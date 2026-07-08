// =============================================================================
// Wallet Collection Worker — shared types  (v3 — price history fields)
//
// CHANGES FROM v2:
//   TokenPriceData extended with 5 new fields required by token_price_history:
//     liquidityUsd, fdvUsd, volume24hUsd, pairAddress, dexId
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
  /**
   * Per-account lamport balance deltas for the whole transaction.
   *
   * REQUIRED for sell detection on Pump.fun (and most custom AMM/bonding-curve
   * programs): the SOL payout to a seller is moved via a direct lamport
   * account mutation inside the program, not a `system_instruction::transfer`.
   * Helius's `nativeTransfers` array only contains parsed System Program
   * transfer instructions, so it never includes this payout — it only shows
   * up here, as a positive `nativeBalanceChange` on the seller's account.
   * Diagnosed 2026-07-08: 100% of Pump.fun sells have nativeTransferToSeller
   * === 0 while accountData nativeBalanceChange is positive and correct.
   */
  accountData?: HeliusAccountData[];
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

export interface HeliusAccountData {
  account: string;
  /** Net lamport change for this account across the whole tx. Positive = received SOL. */
  nativeBalanceChange: number;
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
 *
 * v3 — 5 new fields sourced from the DexScreener pair response:
 *   liquidityUsd  → token_price_history.liquidity_usd
 *   fdvUsd        → token_price_history.fdv_usd
 *   volume24hUsd  → token_price_history.volume_24h_usd
 *   pairAddress   → token_price_history.pair_address
 *   dexId         → token_price_history.dex_id
 *
 * All nullable — gracefully absent for illiquid or delisted tokens.
 */
export interface TokenPriceData {
  priceSol:      number | null;
  priceUsd:      number | null;
  marketCapUsd:  number | null;
  fetchedAt:     string;

  liquidityUsd:  number | null;
  fdvUsd:        number | null;
  volume24hUsd:  number | null;
  pairAddress:   string | null;
  dexId:         string | null;
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
