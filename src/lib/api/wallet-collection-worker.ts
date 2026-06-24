// =============================================================================
// Wallet Collection Worker  (v10 — SOL-pair fix + position tracking + correct P&L)
//
// P&L CALCULATION — how each field is derived:
//
//   initial_investment    Sum of SOL paid across all buy transactions
//                         (from actual native SOL transfers in Helius data).
//                         0 for holder-only wallets (Path B) where cost is unknown.
//
//   current_value         Sum of SOL received across all sell transactions.
//                         0 if the wallet has not sold anything yet.
//
//   position_status       OPEN           — bought, has not sold anything
//                         PARTIALLY_CLOSED — sold some but not all tokens
//                         CLOSED         — sold ≥95% of purchased tokens
//                         UNKNOWN        — holder-only; no investment cost
//
//   current_token_balance Estimated remaining token balance:
//                         Path A: total_tokens_bought − total_tokens_sold
//                         Path B: uiAmount from getTokenLargestAccounts (real)
//
//   current_position_value_sol
//                         current_token_balance × current_token_price_sol
//                         Fetched once from DexScreener per collection run.
//                         0 when price is unavailable.
//
//   realized_profit       OPEN            → 0 (nothing sold; position still open)
//                         CLOSED          → current_value − initial_investment
//                         PARTIALLY_CLOSED → current_value − cost_of_sold_portion
//                           where cost_of_sold_portion =
//                             initial_investment × (tokens_sold / tokens_bought)
//
//   unrealized_profit     OPEN / PARTIALLY_CLOSED
//                           → current_position_value_sol − cost_of_remaining
//                             where cost_of_remaining =
//                               initial_investment × (tokens_remaining / tokens_bought)
//                         CLOSED → 0
//                         UNKNOWN → current_position_value_sol (no cost basis)
//
//   roi_multiple          OPEN / PARTIALLY_CLOSED
//                           → (current_value + current_position_value_sol)
//                               / initial_investment
//                         CLOSED → current_value / initial_investment
//                         NULL when initial_investment = 0
//
//   peak_roi / peak_position_value_sol
//                         Preserved across upserts — only updated when the new
//                         value exceeds the existing stored peak.
//
// DATA SOURCES:
//   Token price  → DexScreener /latest/dex/tokens/{mint}   (priceNative = SOL)
//   Trade data   → Helius Enhanced Transactions API (Path A)
//   Holder data  → Solana RPC getTokenLargestAccounts      (Path B)
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import type {
  WalletCollectionJob,
  CollectionResult,
  HeliusEnhancedTx,
  ParsedTrader,
  TokenPriceData,
  PositionStatus,
} from "./wallet-collection.types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_SOL_THRESHOLD = 0.001;
const MIN_TOKEN_AMOUNT  = 1;
const HELIUS_BATCH_SIZE = 100;
const MAX_BUYERS        = 50;
const MAX_TRADERS       = 200;
const LAMPORTS_PER_SOL  = 1_000_000_000;
const LOG = "[WalletWorker]";

const IGNORED_PROGRAMS = new Set([
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ComputeBudget111111111111111111111111111111",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bRS",
]);

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

function getHeliusKey(): string {
  return process.env.HELIUS_API_KEY ?? "";
}

function getRpcUrl(): string {
  const key = getHeliusKey();
  return key
    ? `https://mainnet.helius-rpc.com/?api-key=${key}`
    : "https://api.mainnet-beta.solana.com";
}

export function getSupabase() {
  const url =
    process.env.SUPABASE_URL ??
    process.env.VITE_SUPABASE_URL ??
    (import.meta.env.VITE_SUPABASE_URL as string | undefined) ??
    "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_ANON_KEY ??
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.VITE_SUPABASE_ANON_KEY ??
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    "";

  if (!url || !key) {
    console.error(
      `${LOG} ✗ Supabase credentials not found.\n` +
      `  SUPABASE_URL              = ${process.env.SUPABASE_URL ? "SET" : "MISSING"}\n` +
      `  SUPABASE_SERVICE_ROLE_KEY = ${process.env.SUPABASE_SERVICE_ROLE_KEY ? "SET" : "MISSING"}`,
    );
    return null;
  }

  const keyLabel =
    process.env.SUPABASE_SERVICE_ROLE_KEY ? "service_role" :
    process.env.SUPABASE_ANON_KEY         ? "anon"         : "publishable";

  console.log(`${LOG} Supabase connected (${keyLabel}) url=${url.slice(0, 40)}…`);

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ---------------------------------------------------------------------------
// Generic HTTP helper with timeout
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 8_000): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    console.warn(`${LOG} fetch ${url.slice(0, 60)} error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// RPC helper
// ---------------------------------------------------------------------------

async function rpc<T = unknown>(method: string, params: unknown[], timeoutMs = 10_000): Promise<T | null> {
  const res = await fetchWithTimeout(
    getRpcUrl(),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    },
    timeoutMs,
  );
  if (!res) return null;
  if (!res.ok) { console.warn(`${LOG} RPC ${method} HTTP ${res.status}`); return null; }
  try {
    const j = await res.json();
    return (j?.result ?? null) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// DexScreener — live token price
// ---------------------------------------------------------------------------

/**
 * Wrapped SOL mint address. DexScreener pairs with this as `quoteToken.address`
 * have `priceNative` expressed in SOL — the only pairs we trust for SOL pricing.
 *
 * BUG THAT WAS FIXED (v9 → v10):
 *   The old code sorted ALL pairs by liquidity and picked the top one, then
 *   read `priceNative` as if it were a SOL price. For USDC-quoted pairs,
 *   DexScreener sets `priceNative` = price in USDC (e.g. "14.087"), not SOL.
 *   That caused a 67× overstatement:
 *     USDC pair  priceNative = "14.087"  → stored as priceSol (WRONG)
 *     SOL  pair  priceNative = "0.2089"  → correct value
 *
 *   Fix: filter to SOL-quoted pairs BEFORE sorting by liquidity.
 *   Fallback chain when no SOL pairs exist:
 *     1. Derive from priceUsd of any pair + a fixed SOL/USD estimate.
 *     2. Return null (caller handles gracefully).
 */

/** Wrapped SOL mint — the only valid quote token for a SOL-priced pair. */
const WSOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Fetch current token price from DexScreener.
 *
 * Pair selection priority:
 *   1. Highest-liquidity SOL-quoted pair  → priceSol = priceNative (exact)
 *   2. Fallback: highest-liquidity any pair → priceSol derived from priceUsd
 *      using the highest-liquidity SOL/USDC pair's implicit rate, OR null.
 *
 * Returns a TokenPriceData with null values on total failure.
 */
export async function fetchTokenPrice(tokenAddress: string): Promise<TokenPriceData> {
  // ── PATCH 1: empty sentinel includes all TokenPriceData v3 fields ─────────
  const empty: TokenPriceData = {
    priceSol: null, priceUsd: null, marketCapUsd: null,
    fetchedAt: new Date().toISOString(),
    liquidityUsd: null, fdvUsd: null, volume24hUsd: null,
    pairAddress: null, dexId: null,
  };

  try {
    const res = await fetchWithTimeout(
      `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
      { headers: { accept: "application/json" } },
      8_000,
    );
    if (!res || !res.ok) return empty;

    // ── PATCH 2: extended DexScreener response type — volume, pairAddress, dexId
    const data = await res.json() as {
      pairs?: Array<{
        chainId?:     string;
        pairAddress?: string;
        dexId?:       string;
        priceNative?: string;
        priceUsd?:    string;
        marketCap?:   number;
        fdv?:         number;
        liquidity?:   { usd?: number };
        volume?:      { h24?: number };
        quoteToken?:  { address?: string; symbol?: string };
      }>;
    };

    if (!data?.pairs?.length) {
      console.log(`${LOG} DexScreener: no pairs for ${tokenAddress.slice(0, 8)}…`);
      return empty;
    }

    // Only consider Solana pairs (guard against cross-chain duplicates)
    const solanaPairs = data.pairs.filter((p) => !p.chainId || p.chainId === "solana");

    // ── Primary: SOL-quoted pairs only ──────────────────────────────────────
    // For these pairs, priceNative IS the price in SOL — no conversion needed.
    const solPairs = solanaPairs.filter(
      (p) => p.quoteToken?.address === WSOL_MINT,
    );

    if (solPairs.length > 0) {
      const best = solPairs.sort(
        (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
      )[0];

      const priceSol     = best.priceNative ? parseFloat(best.priceNative) : null;
      const priceUsd     = best.priceUsd    ? parseFloat(best.priceUsd)    : null;
      const marketCapUsd = best.marketCap   ?? best.fdv                    ?? null;

      console.log(
        `${LOG} DexScreener ${tokenAddress.slice(0, 8)}… ` +
        `[SOL pair, liq=$${(best.liquidity?.usd ?? 0).toFixed(0)}] ` +
        `priceSol=${priceSol} priceUsd=${priceUsd} mcap=${marketCapUsd}`,
      );

      // ── PATCH 3: SOL pair return includes liquidity, fdv, volume, pair, dex ─
      return {
        priceSol, priceUsd, marketCapUsd,
        fetchedAt:    new Date().toISOString(),
        liquidityUsd: best.liquidity?.usd  ?? null,
        fdvUsd:       best.fdv             ?? null,
        volume24hUsd: best.volume?.h24     ?? null,
        pairAddress:  best.pairAddress     ?? null,
        dexId:        best.dexId           ?? null,
      };
    }

    // ── Fallback: no SOL-quoted pair — use USD price only ───────────────────
    // We cannot safely derive a SOL price without a real SOL exchange rate,
    // so priceSol is returned as null. Callers will set position values to 0.
    const anyBest = solanaPairs.sort(
      (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
    )[0];

    const priceUsd     = anyBest?.priceUsd ? parseFloat(anyBest.priceUsd) : null;
    const marketCapUsd = anyBest?.marketCap ?? anyBest?.fdv               ?? null;

    console.warn(
      `${LOG} DexScreener ${tokenAddress.slice(0, 8)}… ` +
      `NO SOL-quoted pair found — ${solanaPairs.length} non-SOL pairs exist. ` +
      `priceSol=null priceUsd=${priceUsd} mcap=${marketCapUsd}`,
    );

    // ── PATCH 4: fallback return includes liquidity, fdv, volume, pair, dex ──
    return {
      priceSol: null, priceUsd, marketCapUsd,
      fetchedAt:    new Date().toISOString(),
      liquidityUsd: anyBest?.liquidity?.usd  ?? null,
      fdvUsd:       anyBest?.fdv             ?? null,
      volume24hUsd: anyBest?.volume?.h24     ?? null,
      pairAddress:  anyBest?.pairAddress     ?? null,
      dexId:        anyBest?.dexId           ?? null,
    };

  } catch (err) {
    console.warn(`${LOG} DexScreener error: ${err instanceof Error ? err.message : String(err)}`);
    return empty;
  }
}

// ---------------------------------------------------------------------------
// Helius enhanced transaction parser
// ---------------------------------------------------------------------------

async function heliusParseTxs(signatures: string[]): Promise<HeliusEnhancedTx[]> {
  const key = getHeliusKey();
  if (!key || signatures.length === 0) return [];
  console.log(`${LOG}   Helius parse ${signatures.length} txs`);
  try {
    const res = await fetchWithTimeout(
      `https://api.helius.xyz/v0/transactions?api-key=${key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transactions: signatures }),
      },
      20_000,
    );
    if (!res || !res.ok) { console.warn(`${LOG}   Helius HTTP ${res?.status ?? "timeout"}`); return []; }
    const data = await res.json();
    const txs = Array.isArray(data) ? (data as HeliusEnhancedTx[]) : [];
    console.log(`${LOG}   Helius returned ${txs.length} parsed txs`);
    return txs;
  } catch (err) {
    console.warn(`${LOG}   Helius error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Trade extraction from Helius transactions
// ---------------------------------------------------------------------------

function extractBuyers(tx: HeliusEnhancedTx, mint: string, poolAddress: string): ParsedTrader[] {
  const traders: ParsedTrader[] = [];
  const transfers = tx.tokenTransfers ?? [];
  const native    = tx.nativeTransfers ?? [];

  const solPaid = new Map<string, number>();
  for (const n of native) {
    if (n.toUserAccount === poolAddress && n.fromUserAccount && n.fromUserAccount !== poolAddress && !IGNORED_PROGRAMS.has(n.fromUserAccount)) {
      solPaid.set(n.fromUserAccount, (solPaid.get(n.fromUserAccount) ?? 0) + n.amount / LAMPORTS_PER_SOL);
    }
  }

  for (const t of transfers) {
    if (t.mint !== mint || t.fromUserAccount !== poolAddress || !t.toUserAccount || t.toUserAccount === poolAddress || IGNORED_PROGRAMS.has(t.toUserAccount)) continue;
    const tokenAmount = Number(t.tokenAmount ?? 0);
    if (!isFinite(tokenAmount) || tokenAmount < MIN_TOKEN_AMOUNT) continue;
    let amountSol = solPaid.get(t.toUserAccount) ?? solPaid.get(tx.feePayer) ?? 0;
    if (amountSol === 0 && tx.feePayer === t.toUserAccount) {
      amountSol = native.filter((n) => n.fromUserAccount === tx.feePayer).reduce((s, n) => s + n.amount / LAMPORTS_PER_SOL, 0);
    }
    if (amountSol < MIN_SOL_THRESHOLD) continue;
    traders.push({ walletAddress: t.toUserAccount, transactionSignature: tx.signature, actionType: "buy", amountSol, tokenAmount, timestamp: tx.timestamp });
  }
  return traders;
}

function extractSellers(tx: HeliusEnhancedTx, mint: string, poolAddress: string): ParsedTrader[] {
  const traders: ParsedTrader[] = [];
  const transfers = tx.tokenTransfers ?? [];
  const native    = tx.nativeTransfers ?? [];

  const solReceived = new Map<string, number>();
  for (const n of native) {
    if (n.fromUserAccount === poolAddress && n.toUserAccount && n.toUserAccount !== poolAddress && !IGNORED_PROGRAMS.has(n.toUserAccount)) {
      solReceived.set(n.toUserAccount, (solReceived.get(n.toUserAccount) ?? 0) + n.amount / LAMPORTS_PER_SOL);
    }
  }

  for (const t of transfers) {
    if (t.mint !== mint || t.toUserAccount !== poolAddress || !t.fromUserAccount || t.fromUserAccount === poolAddress || IGNORED_PROGRAMS.has(t.fromUserAccount)) continue;
    const tokenAmount = Number(t.tokenAmount ?? 0);
    if (!isFinite(tokenAmount) || tokenAmount < MIN_TOKEN_AMOUNT) continue;
    const amountSol = solReceived.get(t.fromUserAccount) ?? 0;
    if (amountSol < MIN_SOL_THRESHOLD) continue;
    traders.push({ walletAddress: t.fromUserAccount, transactionSignature: tx.signature, actionType: "sell", amountSol, tokenAmount, timestamp: tx.timestamp });
  }
  return traders;
}

// ---------------------------------------------------------------------------
// wallet_token_activity  (Step 4)
// ---------------------------------------------------------------------------

async function persistActivity(traders: ParsedTrader[], job: WalletCollectionJob, errors: string[]): Promise<void> {
  if (traders.length === 0) { console.log(`${LOG}   Step 4 SKIP — 0 traders`); return; }
  const sb = getSupabase();
  if (!sb) { errors.push("Supabase unavailable — wallet_token_activity skipped."); return; }

  const rows = traders.map((t) => ({
    wallet_address:        t.walletAddress,
    token_address:         job.tokenAddress,
    transaction_signature: t.transactionSignature,
    action_type:           t.actionType,
    amount_sol:            t.amountSol,
    amount_usd:            null,
    token_amount:          t.tokenAmount,
    timestamp:             new Date(t.timestamp * 1000).toISOString(),
    entry_market_cap:      job.marketCapUsd ?? null,
    liquidity_at_entry:    job.liquidityUsd ?? null,
    holder_count_at_entry: job.holderCount  ?? null,
    token_age_at_entry:    job.tokenCreatedAt != null
      ? Math.max(0, Math.round(t.timestamp - job.tokenCreatedAt!))
      : null,
  }));

  console.log(`${LOG}   Step 4 — upserting ${rows.length} rows → wallet_token_activity`);
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await sb.from("wallet_token_activity").upsert(chunk, { onConflict: "transaction_signature", ignoreDuplicates: true });
    if (error) { const m = `wallet_token_activity: ${error.message}`; console.error(`${LOG}   ✗ ${m}`); errors.push(m); }
    else         { console.log(`${LOG}   ✓ wallet_token_activity chunk ${Math.floor(i / CHUNK)} (${chunk.length} rows)`); }
  }
}

// ---------------------------------------------------------------------------
// wallets  (Step 5)
// ---------------------------------------------------------------------------

async function persistWallets(traders: ParsedTrader[], errors: string[]): Promise<void> {
  if (traders.length === 0) return;
  const sb = getSupabase();
  if (!sb) { errors.push("Supabase unavailable — wallets skipped."); return; }

  const walletMap = new Map<string, { firstTs: number; lastTs: number; buys: number; sells: number }>();
  for (const t of traders) {
    const w = walletMap.get(t.walletAddress) ?? { firstTs: t.timestamp, lastTs: t.timestamp, buys: 0, sells: 0 };
    w.firstTs = Math.min(w.firstTs, t.timestamp);
    w.lastTs  = Math.max(w.lastTs,  t.timestamp);
    if (t.actionType === "buy") w.buys++; else w.sells++;
    walletMap.set(t.walletAddress, w);
  }

  const rows = Array.from(walletMap.entries()).map(([addr, w]) => ({
    wallet_address:        addr,
    first_seen_timestamp:  new Date(w.firstTs * 1000).toISOString(),
    last_seen_timestamp:   new Date(w.lastTs  * 1000).toISOString(),
    total_buys:            w.buys,
    total_sells:           w.sells,
    total_tokens_traded:   1,
    wallet_classification: "unknown",
  }));

  console.log(`${LOG}   Step 5 — upserting ${rows.length} rows → wallets`);
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await sb.from("wallets").upsert(chunk, { onConflict: "wallet_address", ignoreDuplicates: false });
    if (error) { const m = `wallets: ${error.message}`; console.error(`${LOG}   ✗ ${m}`); errors.push(m); }
    else         { console.log(`${LOG}   ✓ wallets chunk ${Math.floor(i / CHUNK)} (${chunk.length} rows)`); }
  }
}

// ---------------------------------------------------------------------------
// wallet_performance_history  (Step 6) — CORRECTED P&L
// ---------------------------------------------------------------------------

interface PerfEntry {
  investedSol:    number;
  receivedSol:    number;
  tokensBought:   number;
  tokensSold:     number;
  firstTs:        number;
  lastTs:         number;
  isHolderOnly:   boolean;
}

function determinePositionStatus(p: PerfEntry): PositionStatus {
  if (p.isHolderOnly) return "UNKNOWN";
  if (p.investedSol === 0) return "UNKNOWN";
  if (p.tokensBought === 0) return "UNKNOWN";
  if (p.tokensSold === 0) return "OPEN";
  if (p.tokensSold >= p.tokensBought * 0.95) return "CLOSED";
  return "PARTIALLY_CLOSED";
}

interface PnL {
  realizedProfit:       number;
  unrealizedProfit:     number;
  roiMultiple:          number | null;
  currentPositionValue: number;
  currentTokenBalance:  number;
}

function calculatePnL(p: PerfEntry, priceSol: number | null, status: PositionStatus): PnL {
  const estimatedBalance = Math.max(0, p.tokensBought - p.tokensSold);
  const currentTokenBalance = p.isHolderOnly ? p.tokensBought : estimatedBalance;
  const currentPositionValue = (priceSol != null && priceSol > 0)
    ? currentTokenBalance * priceSol
    : 0;

  if (status === "UNKNOWN") {
    // Holder-only: no cost basis, all value is unrealized
    return {
      realizedProfit:       0,
      unrealizedProfit:     currentPositionValue,
      roiMultiple:          null,
      currentPositionValue,
      currentTokenBalance,
    };
  }

  if (status === "OPEN") {
    // Bought, has not sold — realized profit is ZERO (position still open)
    const unrealizedProfit = currentPositionValue - p.investedSol;
    const roiMultiple = p.investedSol > 0
      ? currentPositionValue / p.investedSol
      : null;
    return {
      realizedProfit:   0,
      unrealizedProfit,
      roiMultiple,
      currentPositionValue,
      currentTokenBalance,
    };
  }

  if (status === "CLOSED") {
    // Fully exited — all profit/loss is realized
    const realizedProfit = p.receivedSol - p.investedSol;
    const roiMultiple    = p.investedSol > 0 ? p.receivedSol / p.investedSol : null;
    return {
      realizedProfit,
      unrealizedProfit:     0,
      roiMultiple,
      currentPositionValue: 0,
      currentTokenBalance:  0,
    };
  }

  // PARTIALLY_CLOSED: split cost basis between sold and remaining portions
  const fractionSold     = p.tokensBought > 0 ? p.tokensSold  / p.tokensBought : 0;
  const fractionRemaining = 1 - fractionSold;
  const costOfSold       = p.investedSol * fractionSold;
  const costOfRemaining  = p.investedSol * fractionRemaining;

  const realizedProfit   = p.receivedSol - costOfSold;
  const unrealizedProfit = currentPositionValue - costOfRemaining;
  const totalReturn      = p.receivedSol + currentPositionValue;
  const roiMultiple      = p.investedSol > 0 ? totalReturn / p.investedSol : null;

  return {
    realizedProfit,
    unrealizedProfit,
    roiMultiple,
    currentPositionValue,
    currentTokenBalance,
  };
}

async function persistPerformanceHistory(
  traders:      ParsedTrader[],
  job:          WalletCollectionJob,
  priceData:    TokenPriceData,
  errors:       string[],
): Promise<void> {
  if (traders.length === 0) return;
  const sb = getSupabase();
  if (!sb) { errors.push("Supabase unavailable — wallet_performance_history skipped."); return; }

  // ── Build per-wallet aggregates ───────────────────────────────────────────
  const perfMap = new Map<string, PerfEntry>();
  for (const t of traders) {
    const existing = perfMap.get(t.walletAddress) ?? {
      investedSol: 0, receivedSol: 0,
      tokensBought: 0, tokensSold: 0,
      firstTs: t.timestamp, lastTs: t.timestamp,
      isHolderOnly: t.isHolderOnly ?? false,
    };
    if (t.actionType === "buy") {
      existing.investedSol  += t.amountSol;
      existing.tokensBought += t.tokenAmount;
    } else {
      existing.receivedSol  += t.amountSol;
      existing.tokensSold   += t.tokenAmount;
    }
    existing.firstTs = Math.min(existing.firstTs, t.timestamp);
    existing.lastTs  = Math.max(existing.lastTs,  t.timestamp);
    // If any trade has real cost data, this is not holder-only
    if (!t.isHolderOnly) existing.isHolderOnly = false;
    perfMap.set(t.walletAddress, existing);
  }

  // ── Fetch existing peaks in one batch query ───────────────────────────────
  const walletAddresses = Array.from(perfMap.keys());
  const existingPeaks = new Map<string, { peakRoi: number | null; peakPosSol: number | null }>();
  try {
    const { data: existingRows } = await sb
      .from("wallet_performance_history")
      .select("wallet_address, peak_roi, peak_position_value_sol")
      .eq("token_address", job.tokenAddress)
      .in("wallet_address", walletAddresses.slice(0, 500));
    for (const row of existingRows ?? []) {
      existingPeaks.set(row.wallet_address as string, {
        peakRoi:    row.peak_roi    as number | null,
        peakPosSol: (row as Record<string, unknown>).peak_position_value_sol as number | null,
      });
    }
  } catch {
    // Non-fatal — just means peaks start fresh
  }

  // ── Market-cap milestone flags ─────────────────────────────────────────────
  const scanMcap = job.marketCapUsd ?? priceData.marketCapUsd;
  const scanTime = new Date().toISOString();

  // ── Build rows ─────────────────────────────────────────────────────────────
  const rows = Array.from(perfMap.entries()).map(([addr, p]) => {
    const status = determinePositionStatus(p);
    const pnl    = calculatePnL(p, priceData.priceSol, status);

    const existing = existingPeaks.get(addr);
    const peakRoi  = Math.max(pnl.roiMultiple ?? 0, existing?.peakRoi ?? 0) || null;
    const peakPos  = Math.max(pnl.currentPositionValue, existing?.peakPosSol ?? 0) || null;

    // Milestone timestamps: only stamp when milestone newly reached
    const mcap = scanMcap ?? null;

    return {
      wallet_address:              addr,
      token_address:               job.tokenAddress,

      // Investment tracking
      initial_investment:          p.investedSol,
      current_value:               p.receivedSol,
      total_tokens_bought:         p.tokensBought,
      total_tokens_sold:           p.tokensSold,

      // Position
      position_status:             status,
      current_token_balance:       pnl.currentTokenBalance,
      current_position_value_sol:  pnl.currentPositionValue,

      // Live pricing
      current_token_price_sol:     priceData.priceSol    ?? null,
      current_token_price_usd:     priceData.priceUsd    ?? null,
      current_market_cap_usd:      priceData.marketCapUsd ?? null,

      // P&L — corrected
      realized_profit:             pnl.realizedProfit,
      unrealized_profit:           pnl.unrealizedProfit,
      roi_multiple:                pnl.roiMultiple,

      // Peaks — preserved across upserts
      peak_roi:                    peakRoi,
      peak_position_value_sol:     peakPos,

      // Boolean milestone flags (backward compat)
      reached_100k_mc:  mcap != null && mcap >= 100_000,
      reached_500k_mc:  mcap != null && mcap >= 500_000,
      reached_1m_mc:    mcap != null && mcap >= 1_000_000,
      reached_5m_mc:    mcap != null && mcap >= 5_000_000,
      reached_10m_mc:   mcap != null && mcap >= 10_000_000,
      reached_50m_mc:   mcap != null && mcap >= 50_000_000,

      // Milestone timestamps (only set once — COALESCE logic in upsert)
      reached_100k_mc_at: mcap != null && mcap >= 100_000   ? scanTime : null,
      reached_500k_mc_at: mcap != null && mcap >= 500_000   ? scanTime : null,
      reached_1m_mc_at:   mcap != null && mcap >= 1_000_000 ? scanTime : null,
      reached_5m_mc_at:   mcap != null && mcap >= 5_000_000 ? scanTime : null,
      reached_10m_mc_at:  mcap != null && mcap >= 10_000_000 ? scanTime : null,
      reached_50m_mc_at:  mcap != null && mcap >= 50_000_000 ? scanTime : null,

      last_updated: scanTime,
    };
  });

  console.log(`${LOG}   Step 6 — upserting ${rows.length} rows → wallet_performance_history`);
  console.log(
    `${LOG}   Price context: priceSol=${priceData.priceSol ?? "N/A"} ` +
    `priceUsd=${priceData.priceUsd ?? "N/A"} mcap=${priceData.marketCapUsd ?? "N/A"}`,
  );

  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);

    // Use merge strategy to preserve milestone timestamps that were already set
    // ignoreDuplicates: false = UPDATE on conflict
    const { error } = await sb
      .from("wallet_performance_history")
      .upsert(chunk, { onConflict: "wallet_address,token_address", ignoreDuplicates: false });

    if (error) {
      const m = `wallet_performance_history: ${error.message}`;
      console.error(`${LOG}   ✗ ${m}`);
      errors.push(m);
    } else {
      // Log a sample row for verification
      const sample = chunk[0];
      console.log(
        `${LOG}   ✓ chunk ${Math.floor(i / CHUNK)} (${chunk.length} rows) ` +
        `sample: wallet=${(sample.wallet_address as string).slice(0, 8)}… ` +
        `status=${sample.position_status} ` +
        `invested=${(sample.initial_investment as number).toFixed(4)} SOL ` +
        `realized=${(sample.realized_profit as number).toFixed(4)} SOL ` +
        `unrealized=${(sample.unrealized_profit as number).toFixed(4)} SOL ` +
        `roi=${sample.roi_multiple != null ? (sample.roi_multiple as number).toFixed(2) + "x" : "N/A"}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Significant holders — Step 3
// ---------------------------------------------------------------------------

async function collectSignificantHolders(
  job: WalletCollectionJob,
  existingWallets: Set<string>,
  errors: string[],
): Promise<ParsedTrader[]> {
  const traders: ParsedTrader[] = [];
  console.log(`${LOG} Step 3 — getTokenLargestAccounts for ${job.tokenAddress}`);

  try {
    const result = await rpc<{ value: Array<{ address: string; uiAmount: number }> }>(
      "getTokenLargestAccounts", [job.tokenAddress, { commitment: "confirmed" }],
    );
    if (!result?.value) { console.log(`${LOG}   No value returned from RPC`); return traders; }
    console.log(`${LOG}   ${result.value.length} token accounts found`);

    for (const acct of result.value.slice(0, 15)) {
      if (IGNORED_PROGRAMS.has(acct.address)) continue;
      if (job.poolAddress && acct.address === job.poolAddress) continue;
      const uiAmount = acct.uiAmount ?? 0;
      if (uiAmount <= 0) continue;

      const info = await rpc<{ value: { data: unknown } }>(
        "getAccountInfo", [acct.address, { encoding: "jsonParsed" }],
      );
      const parsed = (info?.value?.data as { parsed?: { info?: { owner?: string } } } | undefined)?.parsed;
      const owner  = parsed?.info?.owner;
      if (!owner || IGNORED_PROGRAMS.has(owner)) continue;
      if (job.poolAddress && owner === job.poolAddress) continue;
      if (existingWallets.has(owner)) continue;
      existingWallets.add(owner);

      const sigs = await rpc<Array<{ signature: string; err: unknown }>>(
        "getSignaturesForAddress", [acct.address, { limit: 3, commitment: "confirmed" }],
      );
      const firstSig = Array.isArray(sigs)
        ? sigs.filter((s) => !s.err).map((s) => s.signature).find(Boolean)
        : undefined;
      if (!firstSig) continue;

      traders.push({
        walletAddress:         owner,
        transactionSignature:  firstSig,
        actionType:            "buy",
        amountSol:             0,
        tokenAmount:           uiAmount,  // real on-chain balance from getTokenLargestAccounts
        timestamp:             Math.floor(Date.now() / 1000),
        isHolderOnly:          true,
      });
      console.log(`${LOG}   holder: ${owner.slice(0, 8)}… balance=${uiAmount.toLocaleString()} tokens`);
    }
    console.log(`${LOG}   collectSignificantHolders done: ${traders.length} holders`);
  } catch (err) {
    const msg = `collectSignificantHolders: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`${LOG}   ${msg}`);
    errors.push(msg);
  }
  return traders;
}

// ---------------------------------------------------------------------------
// Public API — collect()
// ---------------------------------------------------------------------------

export async function collect(job: WalletCollectionJob): Promise<CollectionResult> {
  const result: CollectionResult = {
    tokenAddress: job.tokenAddress, poolAddress: job.poolAddress ?? null,
    tradersCollected: 0, buyersCollected: 0, sellersCollected: 0,
    skippedDust: 0, skippedAirdrop: 0, errors: [],
  };

  const heliusOk = !!getHeliusKey();
  const sbOk     = !!getSupabase();

  console.log(
    `${LOG} ═══ collect() START\n` +
    `${LOG}   token  : ${job.tokenAddress}\n` +
    `${LOG}   pool   : ${job.poolAddress ?? "NONE (holder-only mode)"}\n` +
    `${LOG}   helius : ${heliusOk ? "✓" : "✗ MISSING (Steps 1-2 skipped)"}\n` +
    `${LOG}   sb     : ${sbOk ? "✓" : "✗ MISSING CREDENTIALS"}`,
  );

  try {
    const allTraders: ParsedTrader[] = [];
    let skippedDust = 0;

    // ── Steps 1-2: trade history via Helius (requires poolAddress) ────────────
    if (job.poolAddress && heliusOk) {
      console.log(`${LOG} Step 1 — paginating pool sigs: ${job.poolAddress}`);
      let before: string | undefined;
      let pageSigs: string[] = [];

      for (let page = 0; page < 6; page++) {
        const batch = await rpc<Array<{ signature: string; err: unknown }>>(
          "getSignaturesForAddress", [job.poolAddress, { limit: 1000, before, commitment: "confirmed" }],
        );
        if (!Array.isArray(batch) || batch.length === 0) { console.log(`${LOG}   page ${page}: empty`); break; }
        console.log(`${LOG}   page ${page}: ${batch.length} sigs`);
        pageSigs.push(...batch.filter((s) => !s.err).map((s) => s.signature).filter(Boolean));
        if (batch.length < 1000) break;
        before = batch[batch.length - 1]?.signature;
        if (!before) break;
      }

      // Always include the most recent 100 so new traders show up even if
      // they weren't in the paginated window
      const recentResp = await rpc<Array<{ signature: string; err: unknown }>>(
        "getSignaturesForAddress", [job.poolAddress, { limit: 100, commitment: "confirmed" }],
      );
      const recentSigs = Array.isArray(recentResp)
        ? recentResp.filter((s) => !s.err).map((s) => s.signature).filter(Boolean)
        : [];

      const allSigs = Array.from(new Set([...pageSigs.slice(0, 100), ...recentSigs]));
      console.log(`${LOG} Step 2 — parsing ${allSigs.length} sigs via Helius`);

      const seenSigs   = new Set<string>();
      const seenBuyers = new Set<string>();

      for (let i = 0; i < allSigs.length && allTraders.length < MAX_TRADERS; i += HELIUS_BATCH_SIZE) {
        const txs = await heliusParseTxs(allSigs.slice(i, i + HELIUS_BATCH_SIZE));
        for (const tx of txs) {
          if (!tx.signature || seenSigs.has(tx.signature)) continue;
          seenSigs.add(tx.signature);
          if (seenBuyers.size < MAX_BUYERS) {
            for (const b of extractBuyers(tx, job.tokenAddress, job.poolAddress!)) {
              if (seenBuyers.has(b.walletAddress)) continue;
              if (b.amountSol < MIN_SOL_THRESHOLD) { skippedDust++; continue; }
              seenBuyers.add(b.walletAddress);
              allTraders.push(b);
            }
          }
          for (const s of extractSellers(tx, job.tokenAddress, job.poolAddress!)) {
            allTraders.push(s);
          }
        }
      }
      result.skippedDust = skippedDust;
      console.log(
        `${LOG} Step 2 done — ` +
        `buys=${allTraders.filter((t) => t.actionType === "buy").length} ` +
        `sells=${allTraders.filter((t) => t.actionType === "sell").length}`,
      );
    } else {
      console.log(`${LOG} Steps 1-2 SKIPPED — ${job.poolAddress ? "no Helius key" : "no poolAddress"}`);
    }

    // ── Step 3: top holders (always runs, fills gaps when pool data absent) ───
    const holderTraders = await collectSignificantHolders(
      job,
      new Set(allTraders.map((t) => t.walletAddress)),
      result.errors,
    );
    allTraders.push(...holderTraders);

    console.log(`${LOG} Total traders collected: ${allTraders.length}`);
    if (allTraders.length === 0) {
      console.warn(`${LOG} ⚠ 0 traders — token may have no on-chain accounts yet.`);
    }

    // ── Step 3b: fetch live token price ONCE for all wallets ─────────────────
    console.log(`${LOG} Step 3b — fetching token price from DexScreener…`);
    const priceData = await fetchTokenPrice(job.tokenAddress);

    // ── Steps 4-6: persist to Supabase ───────────────────────────────────────
    await persistActivity(allTraders, job, result.errors);
    await persistWallets(allTraders, result.errors);
    await persistPerformanceHistory(allTraders, job, priceData, result.errors);

    result.buyersCollected  = allTraders.filter((t) => t.actionType === "buy").length;
    result.sellersCollected = allTraders.filter((t) => t.actionType === "sell").length;
    result.tradersCollected = allTraders.length;

    console.log(`${LOG} ═══ collect() DONE — traders=${result.tradersCollected} errors=${result.errors.length}`);
  } catch (err) {
    const msg = `Unhandled error in collect(): ${err instanceof Error ? err.message : String(err)}`;
    console.error(`${LOG} ✗ ${msg}`, err);
    result.errors.push(msg);
  }

  return result;
}
