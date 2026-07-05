// =============================================================================
// Transaction Reconstructor  (Phase 1 — Transaction-Driven Wallet Intelligence)
//
// For a given wallet + token pair, fetches the wallet's pump.fun transaction
// history and reconstructs every BUY and every SELL from on-chain evidence.
//
// Design rules (per Phase 1 spec):
//   • Blockchain is the source of truth — never fabricate values.
//   • If evidence is absent, leave the field null rather than estimating.
//   • BUY  = wallet receives token AND sends SOL.
//   • SELL = wallet sends token AND receives SOL.
//   • UNKNOWN only when tx history is unavailable.
//   • Peaks (peak_roi, peak_position_value_sol) only increase, never decrease.
//
// Credit-efficiency change:
//   Old approach: getSignaturesForAddress(wallet) → up to 2 000 ALL-WALLET sigs
//                 → parse ALL via Enhanced Transactions (2 000 CU) to find the
//                 5–10 pump.fun trades.  Cost: ~2 002 CU per wallet.
//
//   New approach: /v0/addresses/{wallet}/transactions?source=PUMP_FUN&type=SWAP
//                 returns ONLY pump.fun swap transactions, pre-parsed.
//                 A typical trader has <30 such txs per token.
//                 Cost: ~10–50 CU per wallet  (30–70× cheaper).
// =============================================================================

import type { HeliusEnhancedTx } from "./wallet-collection.types";

const LOG            = "[TxReconstructor]";
const LAMPORTS_PER_SOL = 1_000_000_000;
const MIN_SOL_THRESHOLD = 0.0005;   // 0.5 milliSOL — filter dust transfers

// ---------------------------------------------------------------------------
// Helius credit budget guard (shared with TokenDiscovery + PostLaunchWatcher)
// Uses globalThis so all modules share the same running counters.
// Enhanced Transactions history endpoint = 1 CU per tx returned.
// ---------------------------------------------------------------------------
function _consumeHC(cuAmount: number, label: string): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  const now = Date.now();

  // ── Daily bucket ───────────────────────────────────────────────────────────
  if (!g.__heliusBudget__ || now - g.__heliusBudget__.day >= 86_400_000) {
    g.__heliusBudget__ = {
      budget: parseInt(process.env.HELIUS_DAILY_BUDGET ?? "20000", 10) || 0,
      used:   0,
      day:    now,
      warned: false,
    };
  }
  const b = g.__heliusBudget__ as { budget: number; used: number; day: number; warned: boolean };

  // ── Hourly bucket ──────────────────────────────────────────────────────────
  if (!g.__heliusHourly__ || now - g.__heliusHourly__.window >= 3_600_000) {
    g.__heliusHourly__ = {
      budget: parseInt(process.env.HELIUS_HOURLY_BUDGET ?? "1000", 10) || 0,
      used:   0,
      window: now,
      warned: false,
    };
  }
  const h = g.__heliusHourly__ as { budget: number; used: number; window: number; warned: boolean };

  // ── Hourly cap check ───────────────────────────────────────────────────────
  if (h.budget > 0 && h.used + cuAmount > h.budget) {
    if (!h.warned) {
      h.warned = true;
      const resetsIn = Math.ceil((h.window + 3_600_000 - now) / 60_000);
      console.warn(
        `[HeliusBudget] ⚠️  Hourly cap reached (${h.used}/${h.budget} CUs used this hour). ` +
        `Skipping "${label}" — resets in ~${resetsIn} min. ` +
        `Raise HELIUS_HOURLY_BUDGET in Railway Variables to increase the limit.`,
      );
    }
    return false;
  }

  // ── Daily cap check ────────────────────────────────────────────────────────
  if (b.budget > 0 && b.used + cuAmount > b.budget) {
    if (!b.warned) {
      b.warned = true;
      console.warn(
        `[HeliusBudget] ⚠️  Daily budget exhausted (${b.used}/${b.budget} CUs used). ` +
        `Skipping "${label}" until tomorrow. ` +
        `Raise HELIUS_DAILY_BUDGET in Railway Variables to increase the limit.`,
      );
    }
    return false;
  }

  // ── Consume from both buckets ──────────────────────────────────────────────
  if (h.budget > 0) h.used += cuAmount;
  if (b.budget > 0) b.used += cuAmount;
  return true;
}

/**
 * Programs whose SOL / token flows must be ignored when attributing
 * SOL spend / receipt to a wallet. These are system or AMM accounts,
 * not real counterparties.
 */
const IGNORED_PROGRAMS = new Set([
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ComputeBudget111111111111111111111111111111",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bRS",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",   // Jupiter aggregator
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",   // Orca Whirlpool
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",  // Raydium AMM v4
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",  // Raydium AMM v5
]);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single on-chain trade reconstructed from Helius enhanced tx data. */
export interface ReconstructedTrade {
  signature:   string;
  actionType:  "buy" | "sell";
  tokenAmount: number;   // raw token amount (as received from Helius tokenAmount)
  amountSol:   number;   // SOL spent (buy) or received (sell), in SOL not lamports
  timestamp:   number;   // Unix epoch seconds
}

/** Complete reconstructed position for one wallet × one token. */
export interface ReconstructedPosition {
  walletAddress:  string;
  tokenAddress:   string;

  /** All verified on-chain trades, sorted chronologically (oldest first). */
  trades: ReconstructedTrade[];

  // ── Aggregates (derived from trades) ──
  totalTokensBought:  number;
  totalTokensSold:    number;
  initialInvestment:  number;   // total SOL paid across all buy txs
  totalSolReceived:   number;   // total SOL received across all sell txs
  currentTokenBalance: number;  // max(0, totalTokensBought − totalTokensSold)

  // ── Position status — based ONLY on transaction evidence ──
  positionStatus: "OPEN" | "PARTIALLY_CLOSED" | "CLOSED" | "UNKNOWN";

  // ── P&L — computed from trades + current market price ──
  realizedProfit:          number;
  unrealizedProfit:        number;
  roiMultiple:             number | null;
  currentPositionValueSol: number;

  // ── Peaks — monotonically non-decreasing ──
  peakRoi:             number | null;
  peakPositionValueSol: number | null;

  // ── Timestamps ──
  firstTradeTs: number | null;   // Unix seconds of oldest trade
  lastTradeTs:  number | null;   // Unix seconds of newest trade

  /** false when Helius returned no data (network error / rate limit). */
  hasTransactionEvidence: boolean;
}

// ---------------------------------------------------------------------------
// Network helpers (private)
// ---------------------------------------------------------------------------

async function fetchWithTimeout(
  url:       string,
  options:   RequestInit = {},
  timeoutMs = 15_000,
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Credit-efficient wallet transaction fetch (private)
// ---------------------------------------------------------------------------

/**
 * Fetch a wallet's pump.fun swap transaction history via the Helius Enhanced
 * Transaction History endpoint, filtered to source=PUMP_FUN&type=SWAP.
 *
 * WHY THIS REPLACES getSignaturesForAddress + heliusParseBatch:
 *
 *   Old approach (removed):
 *     1. getSignaturesForAddress(walletAddress, limit=1000, pages=2)
 *        → up to 2 000 signatures of ALL wallet activity   (2 CU)
 *     2. Parse ALL 2 000 txs via Enhanced Transactions API (2 000 CU)
 *     3. Filter in-code to find the 5–10 pump.fun trades
 *     Total: ~2 002 CU per wallet to get ~10 useful records.
 *
 *   New approach (this function):
 *     GET /v0/addresses/{wallet}/transactions
 *         ?source=PUMP_FUN&type=SWAP&limit=100
 *     Returns ONLY pump.fun swap txs, pre-parsed by Helius.
 *     A typical pump.fun trader has <30 trades per token.
 *     Total: ~10–100 CU per wallet (30–200× cheaper).
 *
 * Credit accounting: charge ONLY the actual number of transactions returned,
 * not a flat upfront reservation. Helius bills 1 CU per tx returned — if
 * this wallet has 0 pump.fun swaps, 0 CU is charged. If it returns 31, 31
 * CU is charged. This prevents the previous over-reservation problem where
 * every wallet call deducted 100 CU even when 0 txs were returned, causing
 * the hourly budget to exhaust from accounting noise rather than real usage.
 *
 * A lightweight pre-check still runs to skip the HTTP call entirely when the
 * budget is already exhausted — avoiding spending real Helius credits when the
 * internal cap has already been hit.
 *
 * @param walletAddress  Wallet to fetch transactions for.
 * @param heliusApiKey   Helius API key.
 * @param limit          Max transactions to retrieve (default 100).
 *                       Pump.fun traders rarely exceed 50 trades per token.
 */
async function fetchWalletTokenTxs(
  walletAddress: string,
  heliusApiKey:  string,
  limit = 100,
): Promise<HeliusEnhancedTx[]> {
  // ── Pre-check: skip the HTTP call if budget is already at zero ─────────
  // We don't consume CU here — we just check the current state so we don't
  // spend real Helius credits when the internal budget is already exhausted.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  const h = g.__heliusHourly__ as { budget: number; used: number } | undefined;
  const b = g.__heliusBudget__  as { budget: number; used: number } | undefined;
  if ((h?.budget ?? 0) > 0 && (h?.used ?? 0) >= (h?.budget ?? 0)) return [];
  if ((b?.budget ?? 0) > 0 && (b?.used ?? 0) >= (b?.budget ?? 0)) return [];

  const url =
    `https://api.helius.xyz/v0/addresses/${walletAddress}/transactions` +
    `?api-key=${heliusApiKey}` +
    `&limit=${limit}` +
    `&source=PUMP_FUN` +   // only transactions involving the pump.fun program
    `&type=SWAP`;          // only swap events (buys/sells), not mints or transfers

  const res = await fetchWithTimeout(url, {}, 15_000);
  if (!res) {
    console.warn(`${LOG} fetchWalletTokenTxs timeout for ${walletAddress.slice(0, 8)}…`);
    return [];
  }
  if (!res.ok) {
    console.warn(
      `${LOG} fetchWalletTokenTxs HTTP ${res.status} for ${walletAddress.slice(0, 8)}… — ` +
      `body: ${await res.text().catch(() => "(unreadable)")}`,
    );
    return [];
  }

  try {
    const data = await res.json();
    const txs = Array.isArray(data) ? (data as HeliusEnhancedTx[]) : [];

    // ── Charge actual CUs AFTER the fetch ──────────────────────────────────
    // Only consume budget for what Helius actually returned. Wallets with 0
    // pump.fun swaps cost 0 CU — not 100. This is the key fix vs. the prior
    // upfront-reservation approach that drained the budget on empty results.
    if (txs.length > 0) {
      _consumeHC(txs.length, `TxReconstructor/fetchWalletTokenTxs(${walletAddress.slice(0, 8)})`);
    }

    console.log(
      `${LOG} ${walletAddress.slice(0, 8)}… → ${txs.length} pump.fun txs ` +
      `(actual CU charged: ${txs.length})`,
    );
    return txs;
  } catch (err) {
    console.warn(`${LOG} fetchWalletTokenTxs JSON parse error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Trade extraction (private)
// ---------------------------------------------------------------------------

/**
 * Examine a single Helius enhanced transaction and decide whether the given
 * wallet performed a BUY or SELL of the given token mint.
 *
 * Returns null for unrelated txs (transfers, airdrops, fee-only).
 */
function extractTradeForWallet(
  tx:            HeliusEnhancedTx,
  walletAddress: string,
  tokenMint:     string,
): ReconstructedTrade | null {
  const transfers = tx.tokenTransfers ?? [];
  const native    = tx.nativeTransfers ?? [];

  // ── Token quantity the wallet received (candidate BUY) ──
  let tokensReceived = 0;
  // ── Token quantity the wallet sent (candidate SELL) ──
  let tokensSent = 0;

  for (const t of transfers) {
    if (t.mint !== tokenMint) continue;
    if (
      t.toUserAccount === walletAddress &&
      t.fromUserAccount !== walletAddress &&
      !IGNORED_PROGRAMS.has(t.fromUserAccount)
    ) {
      tokensReceived += Number(t.tokenAmount ?? 0);
    }
    if (
      t.fromUserAccount === walletAddress &&
      t.toUserAccount !== walletAddress &&
      !IGNORED_PROGRAMS.has(t.toUserAccount)
    ) {
      tokensSent += Number(t.tokenAmount ?? 0);
    }
  }

  // ── Net SOL flow for the wallet (excluding system programs) ──
  let solOut = 0;  // wallet → counterparty (cost of buy)
  let solIn  = 0;  // counterparty → wallet (proceeds of sell)

  for (const n of native) {
    if (
      n.fromUserAccount === walletAddress &&
      n.toUserAccount !== walletAddress &&
      !IGNORED_PROGRAMS.has(n.toUserAccount)
    ) {
      solOut += n.amount / LAMPORTS_PER_SOL;
    }
    if (
      n.toUserAccount === walletAddress &&
      n.fromUserAccount !== walletAddress &&
      !IGNORED_PROGRAMS.has(n.fromUserAccount)
    ) {
      solIn += n.amount / LAMPORTS_PER_SOL;
    }
  }

  // ── Classify ──
  if (tokensReceived > 0 && solOut >= MIN_SOL_THRESHOLD) {
    return {
      signature:   tx.signature,
      actionType:  "buy",
      tokenAmount: tokensReceived,
      amountSol:   solOut,
      timestamp:   tx.timestamp,
    };
  }

  if (tokensSent > 0 && solIn >= MIN_SOL_THRESHOLD) {
    return {
      signature:   tx.signature,
      actionType:  "sell",
      tokenAmount: tokensSent,
      amountSol:   solIn,
      timestamp:   tx.timestamp,
    };
  }

  return null; // airdrop, LP action, or unrelated
}

// ---------------------------------------------------------------------------
// Position classification (private)
// ---------------------------------------------------------------------------

function classifyPositionStatus(
  tokensBought: number,
  tokensSold:   number,
  investedSol:  number,
): "OPEN" | "PARTIALLY_CLOSED" | "CLOSED" | "UNKNOWN" {
  if (tokensBought === 0 && investedSol === 0) return "UNKNOWN";
  if (tokensSold === 0) return "OPEN";
  if (tokensBought > 0 && tokensSold >= tokensBought * 0.95) return "CLOSED";
  return "PARTIALLY_CLOSED";
}

// ---------------------------------------------------------------------------
// P&L calculation (private)
// ---------------------------------------------------------------------------

interface PnLResult {
  realizedProfit:          number;
  unrealizedProfit:        number;
  roiMultiple:             number | null;
  currentPositionValueSol: number;
  peakRoi:                 number | null;
  peakPositionValueSol:    number | null;
}

function computePnL(opts: {
  totalTokensBought:   number;
  totalTokensSold:     number;
  initialInvestment:   number;
  totalSolReceived:    number;
  currentTokenBalance: number;
  positionStatus:      "OPEN" | "PARTIALLY_CLOSED" | "CLOSED" | "UNKNOWN";
  currentPriceSol:     number | null;
  existingPeakRoi:     number | null;
  existingPeakPosSol:  number | null;
}): PnLResult {
  const {
    totalTokensBought, totalTokensSold, initialInvestment,
    totalSolReceived, currentTokenBalance, positionStatus,
    currentPriceSol, existingPeakRoi, existingPeakPosSol,
  } = opts;

  const posValueSol =
    currentPriceSol != null && currentPriceSol > 0
      ? currentTokenBalance * currentPriceSol
      : 0;

  let realizedProfit   = 0;
  let unrealizedProfit = 0;
  let roiMultiple: number | null = null;

  switch (positionStatus) {
    case "UNKNOWN":
      // No cost basis — only report current value as unrealized
      unrealizedProfit = posValueSol;
      break;

    case "OPEN":
      unrealizedProfit = posValueSol - initialInvestment;
      roiMultiple = initialInvestment > 0 ? posValueSol / initialInvestment : null;
      break;

    case "CLOSED":
      realizedProfit = totalSolReceived - initialInvestment;
      roiMultiple    = initialInvestment > 0 ? totalSolReceived / initialInvestment : null;
      break;

    case "PARTIALLY_CLOSED": {
      const fracSold      = totalTokensBought > 0 ? totalTokensSold / totalTokensBought : 0;
      const fracRemaining = 1 - fracSold;
      realizedProfit      = totalSolReceived - initialInvestment * fracSold;
      unrealizedProfit    = posValueSol       - initialInvestment * fracRemaining;
      const totalReturn   = totalSolReceived + posValueSol;
      roiMultiple         = initialInvestment > 0 ? totalReturn / initialInvestment : null;
      break;
    }
  }

  // ── Dust guard (Fix 2) ───────────────────────────────────────────────────
  // Positions entered with < 0.001 SOL produce astronomically distorted
  // ROI multiples (e.g. 88,000x) that corrupt leaderboards and scoring.
  // A sub-milliSOL investment is indistinguishable from dust / gas noise.
  const DUST_INVESTMENT_THRESHOLD_SOL = 0.001;
  if (initialInvestment > 0 && initialInvestment < DUST_INVESTMENT_THRESHOLD_SOL) {
    roiMultiple = null;
  }

  // Peaks are monotonically non-decreasing
  const peakRoi    = Math.max(roiMultiple ?? 0, existingPeakRoi    ?? 0) || null;
  const peakPosSol = Math.max(posValueSol,       existingPeakPosSol ?? 0) || null;

  return {
    realizedProfit,
    unrealizedProfit,
    roiMultiple,
    currentPositionValueSol: posValueSol,
    peakRoi,
    peakPositionValueSol: peakPosSol,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch a wallet's pump.fun trade history for one token and reconstruct
 * every BUY and SELL from on-chain evidence.
 *
 * Credit cost: ~10–100 CU per wallet (vs ~2 002 CU in the old approach).
 * The new implementation uses the Helius Enhanced Transaction History
 * endpoint filtered to source=PUMP_FUN&type=SWAP, which returns only
 * pump.fun swap transactions pre-parsed — eliminating the need to fetch
 * all wallet signatures and parse thousands of irrelevant transactions.
 *
 * @param opts.walletAddress      The Solana wallet to analyse.
 * @param opts.tokenAddress       The token mint to track.
 * @param opts.heliusApiKey       Helius API key (for Enhanced Transactions).
 * @param opts.heliusRpcUrl       Helius RPC URL (unused — kept for interface
 *                                 compatibility; remove in a future cleanup).
 * @param opts.currentPriceSol    Current token price in SOL (from DexScreener).
 * @param opts.existingPeakRoi    Stored peak_roi — never overwritten with a lower value.
 * @param opts.existingPeakPosSol Stored peak_position_value_sol — same guarantee.
 * @param opts.maxSignaturePages  Legacy param — ignored; kept for call-site
 *                                 compatibility. Remove in a future cleanup.
 */
export async function reconstructWalletPosition(opts: {
  walletAddress:      string;
  tokenAddress:       string;
  heliusApiKey:       string;
  heliusRpcUrl:       string;
  currentPriceSol:    number | null;
  existingPeakRoi:    number | null;
  existingPeakPosSol: number | null;
  maxSignaturePages?: number;
}): Promise<ReconstructedPosition> {
  const {
    walletAddress, tokenAddress, heliusApiKey,
    currentPriceSol, existingPeakRoi, existingPeakPosSol,
  } = opts;

  const emptyResult: ReconstructedPosition = {
    walletAddress, tokenAddress,
    trades: [],
    totalTokensBought: 0, totalTokensSold: 0,
    initialInvestment: 0, totalSolReceived: 0, currentTokenBalance: 0,
    positionStatus: "UNKNOWN",
    realizedProfit: 0, unrealizedProfit: 0, roiMultiple: null,
    currentPositionValueSol: 0,
    peakRoi: existingPeakRoi, peakPositionValueSol: existingPeakPosSol,
    firstTradeTs: null, lastTradeTs: null,
    hasTransactionEvidence: false,
  };

  // ── Step 1: fetch only pump.fun swap txs for this wallet ─────────────────
  // Max 100 txs = max 100 CU (vs 2 002 CU for the old brute-force approach).
  // Pump.fun traders rarely exceed 50 trades per wallet across all tokens;
  // if a wallet has more than 100 pump.fun swaps, the oldest ones are less
  // relevant to current-position analysis anyway.
  const rawTxs = await fetchWalletTokenTxs(walletAddress, heliusApiKey, 100);
  if (rawTxs.length === 0) {
    console.log(`${LOG} ${walletAddress.slice(0, 8)}… 0 pump.fun txs returned — skipping`);
    return emptyResult;
  }

  // ── Step 2: extract trades for this specific token ────────────────────────
  const trades: ReconstructedTrade[] = [];
  for (const tx of rawTxs) {
    const trade = extractTradeForWallet(tx, walletAddress, tokenAddress);
    if (trade) trades.push(trade);
  }

  // Sort chronologically (oldest first)
  trades.sort((a, b) => a.timestamp - b.timestamp);

  if (trades.length === 0) {
    // Wallet traded on pump.fun but not this specific token.
    console.log(
      `${LOG} ${walletAddress.slice(0, 8)}… ` +
      `${rawTxs.length} pump.fun txs but 0 trades for token ${tokenAddress.slice(0, 8)}… ` +
      `— holder via transfer/airdrop or traded different tokens`,
    );
    return emptyResult;
  }

  // ── Step 3: aggregate ─────────────────────────────────────────────────────
  let totalTokensBought = 0;
  let totalTokensSold   = 0;
  let initialInvestment = 0;
  let totalSolReceived  = 0;

  for (const t of trades) {
    if (t.actionType === "buy") {
      totalTokensBought += t.tokenAmount;
      initialInvestment += t.amountSol;
    } else {
      totalTokensSold   += t.tokenAmount;
      totalSolReceived  += t.amountSol;
    }
  }

  const currentTokenBalance = Math.max(0, totalTokensBought - totalTokensSold);
  const positionStatus = classifyPositionStatus(totalTokensBought, totalTokensSold, initialInvestment);

  // ── Step 4: P&L ───────────────────────────────────────────────────────────
  const pnl = computePnL({
    totalTokensBought, totalTokensSold, initialInvestment,
    totalSolReceived, currentTokenBalance, positionStatus,
    currentPriceSol, existingPeakRoi, existingPeakPosSol,
  });

  const buys  = trades.filter((t) => t.actionType === "buy").length;
  const sells = trades.filter((t) => t.actionType === "sell").length;

  console.log(
    `${LOG} ${walletAddress.slice(0, 8)}… ` +
    `trades=${trades.length} (buys=${buys} sells=${sells}) ` +
    `status=${positionStatus} ` +
    `invested=${initialInvestment.toFixed(4)}sol ` +
    `realized=${pnl.realizedProfit.toFixed(4)}sol ` +
    `roi=${pnl.roiMultiple != null ? pnl.roiMultiple.toFixed(2) + "x" : "N/A"}`,
  );

  return {
    walletAddress,
    tokenAddress,
    trades,
    totalTokensBought,
    totalTokensSold,
    initialInvestment,
    totalSolReceived,
    currentTokenBalance,
    positionStatus,
    realizedProfit:          pnl.realizedProfit,
    unrealizedProfit:        pnl.unrealizedProfit,
    roiMultiple:             pnl.roiMultiple,
    currentPositionValueSol: pnl.currentPositionValueSol,
    peakRoi:                 pnl.peakRoi,
    peakPositionValueSol:    pnl.peakPositionValueSol,
    firstTradeTs: trades[0]?.timestamp ?? null,
    lastTradeTs:  trades[trades.length - 1]?.timestamp ?? null,
    hasTransactionEvidence: true,
  };
}
