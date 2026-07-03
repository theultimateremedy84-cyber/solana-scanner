// =============================================================================
// Transaction Reconstructor  (Phase 1 — Transaction-Driven Wallet Intelligence)
//
// For a given wallet + token pair, fetches the wallet's COMPLETE Helius
// transaction history and reconstructs every BUY and every SELL from
// on-chain evidence.
//
// Design rules (per Phase 1 spec):
//   • Blockchain is the source of truth — never fabricate values.
//   • If evidence is absent, leave the field null rather than estimating.
//   • BUY  = wallet receives token AND sends SOL.
//   • SELL = wallet sends token AND receives SOL.
//   • UNKNOWN only when tx history is unavailable.
//   • Peaks (peak_roi, peak_position_value_sol) only increase, never decrease.
// =============================================================================

import type { HeliusEnhancedTx } from "./wallet-collection.types";

const LOG            = "[TxReconstructor]";
const LAMPORTS_PER_SOL = 1_000_000_000;
const MIN_SOL_THRESHOLD = 0.0005;   // 0.5 milliSOL — filter dust transfers
const HELIUS_BATCH_SIZE = 25;       // Reduced from 100 → 25 to make budget checks granular

// ---------------------------------------------------------------------------
// Helius credit budget guard (shared with TokenDiscovery + PostLaunchWatcher)
// Uses globalThis so all modules share the same running counters.
// getSignaturesForAddress = 1 CU per call, Enhanced Transactions = 1 CU per tx.
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

/**
 * Paginate getSignaturesForAddress for a WALLET address (not a pool).
 * Returns up to maxPages × 1000 confirmed signature strings.
 * Each RPC page costs 1 Helius CU — guarded by _consumeHC.
 */
async function getWalletSignatures(
  walletAddress: string,
  heliusRpcUrl:  string,
  maxPages = 2,
): Promise<string[]> {
  const signatures: string[] = [];
  let before: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    if (!_consumeHC(1, `TxReconstructor/getSignaturesForAddress page ${page}`)) break;

    const params: [string, Record<string, unknown>] = [
      walletAddress,
      { limit: 1000, commitment: "confirmed" },
    ];
    if (before) params[1].before = before;

    const res = await fetchWithTimeout(
      heliusRpcUrl,
      {
        method:  "POST",
        headers: { "content-type": "application/json" },
        body:    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress", params }),
      },
      15_000,
    );

    if (!res || !res.ok) break;
    const json = await res.json() as { result?: Array<{ signature: string; err: unknown }> };
    const batch = json?.result ?? [];
    if (batch.length === 0) break;

    for (const s of batch) {
      if (!s.err && s.signature) signatures.push(s.signature);
    }

    if (batch.length < 1000) break;
    before = batch[batch.length - 1]?.signature;
    if (!before) break;
  }

  return signatures;
}

/**
 * Parse a batch of signatures via the Helius Enhanced Transactions API.
 * Each transaction parsed costs 1 Helius CU — guarded by _consumeHC.
 */
async function heliusParseBatch(
  signatures:   string[],
  heliusApiKey: string,
): Promise<HeliusEnhancedTx[]> {
  if (signatures.length === 0) return [];
  if (!_consumeHC(signatures.length, `TxReconstructor/parseBatch(${signatures.length})`)) return [];
  try {
    const res = await fetchWithTimeout(
      `https://api.helius.xyz/v0/transactions?api-key=${heliusApiKey}`,
      {
        method:  "POST",
        headers: { "content-type": "application/json" },
        body:    JSON.stringify({ transactions: signatures }),
      },
      25_000,
    );
    if (!res || !res.ok) {
      console.warn(`${LOG} Helius HTTP ${res?.status ?? "timeout"} parsing ${signatures.length} sigs`);
      return [];
    }
    const data = await res.json();
    return Array.isArray(data) ? (data as HeliusEnhancedTx[]) : [];
  } catch (err) {
    console.warn(`${LOG} Helius parse error: ${err instanceof Error ? err.message : String(err)}`);
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
 * Fetch a wallet's complete Helius transaction history for one token and
 * reconstruct every BUY and SELL from on-chain evidence.
 *
 * @param opts.walletAddress      The Solana wallet to analyse.
 * @param opts.tokenAddress       The token mint to track.
 * @param opts.heliusApiKey       Helius API key (for Enhanced Transactions).
 * @param opts.heliusRpcUrl       Helius RPC URL (for getSignaturesForAddress).
 * @param opts.currentPriceSol    Current token price in SOL (from DexScreener).
 * @param opts.existingPeakRoi    Stored peak_roi — never overwritten with a lower value.
 * @param opts.existingPeakPosSol Stored peak_position_value_sol — same guarantee.
 * @param opts.maxSignaturePages  Max pages of 1000 sigs to fetch (default 5 = 5000 txs).
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
    walletAddress, tokenAddress, heliusApiKey, heliusRpcUrl,
    currentPriceSol, existingPeakRoi, existingPeakPosSol,
    maxSignaturePages = 5,
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

  // ── Step 1: get all signatures for this wallet ────────────────────────────
  const signatures = await getWalletSignatures(walletAddress, heliusRpcUrl, maxSignaturePages);
  if (signatures.length === 0) {
    console.log(`${LOG} ${walletAddress.slice(0, 8)}… 0 signatures — skipping`);
    return emptyResult;
  }

  // ── Step 2: parse via Helius Enhanced Transactions in batches ─────────────
  const trades: ReconstructedTrade[] = [];
  for (let i = 0; i < signatures.length; i += HELIUS_BATCH_SIZE) {
    const batch = await heliusParseBatch(signatures.slice(i, i + HELIUS_BATCH_SIZE), heliusApiKey);
    for (const tx of batch) {
      const trade = extractTradeForWallet(tx, walletAddress, tokenAddress);
      if (trade) trades.push(trade);
    }
  }

  // Sort chronologically (oldest first)
  trades.sort((a, b) => a.timestamp - b.timestamp);

  if (trades.length === 0) {
    // Had signatures but none involved this token — wallet is a holder via transfer/airdrop
    console.log(
      `${LOG} ${walletAddress.slice(0, 8)}… ` +
      `${signatures.length} sigs but 0 relevant token trades — treating as holder-only`,
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
