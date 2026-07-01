// =============================================================================
// Wallet Price Refresh Worker  (v3 — full token coverage)
//
// CHANGES FROM v2:
//   BUG-FIX: Previously only queried tokens with OPEN/PARTIALLY_CLOSED positions.
//   This left 62.7% of positions (UNKNOWN status) without any price snapshots,
//   causing price_history to cover only ~6 of 119 tokens.
//
//   v3 fix: buildTokenList() now uses a two-source union approach:
//     Source A — wallet_performance_history WHERE position_status IN
//                ('OPEN', 'PARTIALLY_CLOSED') — for full P&L recalculation
//     Source B — wallet_collection_jobs WHERE status = 'done' — for all tokens
//                ever scanned, so UNKNOWN-status tokens still get price snapshots
//                and MC milestone tracking
//   Tokens from Source A are marked as needsPnlUpdate=true and receive full
//   wallet row updates. Tokens from Source B only (Source A has no matching rows)
//   get a price snapshot inserted but no wallet row updates (nothing to update).
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import { fetchTokenPrice, getSupabase } from "./wallet-collection-worker";

const LOG = "[PriceRefresh]";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RefreshResult {
  tokensProcessed:     number;
  walletsUpdated:      number;
  snapshotsInserted:   number;
  peaksUpdated:        number;
  errors:              string[];
  durationMs:          number;
}

interface TokenCandidate {
  tokenAddress:  string;
  walletCount:   number;
  needsPnlUpdate: boolean;  // true = has OPEN/PARTIALLY_CLOSED rows to update
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Refresh prices and recalculate P&L for all tokens with open positions,
 * and insert price snapshots for all other scanned tokens.
 *
 * @param maxTokens   Cap on how many tokens to process per run (default 100).
 * @param delayMs     Delay between DexScreener calls in ms (default 200ms).
 */
export async function refreshOpenPositionPrices(opts: {
  maxTokens?: number;
  delayMs?: number;
} = {}): Promise<RefreshResult> {
  const maxTokens = opts.maxTokens ?? 100;
  const delayMs   = opts.delayMs   ?? 200;
  const startTime = Date.now();

  const result: RefreshResult = {
    tokensProcessed: 0, walletsUpdated: 0,
    snapshotsInserted: 0, peaksUpdated: 0,
    errors: [], durationMs: 0,
  };

  const sb = getSupabase();
  if (!sb) {
    result.errors.push("Supabase unavailable");
    result.durationMs = Date.now() - startTime;
    return result;
  }

  // ── Build unified token list from two sources ─────────────────────────────
  const candidates = await buildTokenList(sb, maxTokens, result.errors);

  if (candidates.length === 0) {
    console.log(`${LOG} No tokens to refresh.`);
    result.durationMs = Date.now() - startTime;
    return result;
  }

  console.log(
    `${LOG} ═══ refreshOpenPositionPrices START — ${candidates.length} tokens ` +
    `(${candidates.filter((c) => c.needsPnlUpdate).length} with open positions)`,
  );

  // ── Process each token ────────────────────────────────────────────────────
  for (const candidate of candidates) {
    try {
      await processSingleToken(sb, candidate, result);
      if (delayMs > 0) await sleep(delayMs);
    } catch (err) {
      const msg = `${candidate.tokenAddress.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`${LOG} ✗ ${msg}`);
      result.errors.push(msg);
    }
    result.tokensProcessed++;
  }

  result.durationMs = Date.now() - startTime;
  console.log(
    `${LOG} ═══ DONE — tokens=${result.tokensProcessed} ` +
    `wallets=${result.walletsUpdated} snapshots=${result.snapshotsInserted} ` +
    `peaks=${result.peaksUpdated} errors=${result.errors.length} ` +
    `duration=${result.durationMs}ms`,
  );
  return result;
}

// ---------------------------------------------------------------------------
// Token list builder — two-source union (BUG FIX for 6/119 coverage)
// ---------------------------------------------------------------------------

async function buildTokenList(
  sb:       ReturnType<typeof createClient>,
  maxTokens: number,
  errors:   string[],
): Promise<TokenCandidate[]> {
  // Source A: tokens with OPEN or PARTIALLY_CLOSED positions
  //   These get full P&L wallet row updates.
  const { data: openRows, error: openErr } = await sb
    .from("wallet_performance_history")
    .select("token_address")
    .in("position_status", ["OPEN", "PARTIALLY_CLOSED"])
    .limit(2000);

  if (openErr) errors.push(`Token open-positions query: ${openErr.message}`);

  const openTokenCount = new Map<string, number>();
  for (const row of openRows ?? []) {
    const ta = row.token_address as string;
    openTokenCount.set(ta, (openTokenCount.get(ta) ?? 0) + 1);
  }

  // Source B: all tokens ever scanned (via wallet_collection_jobs)
  //   These get price snapshots + MC milestone updates only.
  const { data: jobRows, error: jobErr } = await sb
    .from("wallet_collection_jobs")
    .select("token_address")
    .eq("status", "done")
    .limit(500);

  if (jobErr) errors.push(`Token jobs query: ${jobErr.message}`);

  const allTokens = new Set<string>(openTokenCount.keys());
  for (const row of jobRows ?? []) {
    allTokens.add(row.token_address as string);
  }

  // Build ranked candidate list: open-position tokens first (by wallet count),
  // then snapshot-only tokens from jobs, capped at maxTokens total.
  const candidates: TokenCandidate[] = [];

  // Open-position tokens sorted by wallet count descending
  const openSorted = Array.from(openTokenCount.entries())
    .sort((a, b) => b[1] - a[1]);
  for (const [ta, count] of openSorted) {
    candidates.push({ tokenAddress: ta, walletCount: count, needsPnlUpdate: true });
  }

  // Snapshot-only tokens (not already in openTokenCount)
  for (const ta of allTokens) {
    if (!openTokenCount.has(ta)) {
      candidates.push({ tokenAddress: ta, walletCount: 0, needsPnlUpdate: false });
    }
  }

  return candidates.slice(0, maxTokens);
}

// ---------------------------------------------------------------------------
// Per-token processing
// ---------------------------------------------------------------------------

async function processSingleToken(
  sb:        ReturnType<typeof createClient>,
  candidate: TokenCandidate,
  result:    RefreshResult,
): Promise<void> {
  const { tokenAddress, needsPnlUpdate } = candidate;
  const priceData = await fetchTokenPrice(tokenAddress);

  if (priceData.priceSol == null) {
    console.warn(`${LOG} ${tokenAddress.slice(0, 8)}… no SOL price — recording null snapshot`);
    await insertPriceSnapshot(sb, tokenAddress, priceData, "refresh", result);
    return;
  }

  // Always insert a price snapshot for the time-series record
  await insertPriceSnapshot(sb, tokenAddress, priceData, "refresh", result);

  // Only update wallet P&L rows for tokens with OPEN/PARTIALLY_CLOSED positions
  if (!needsPnlUpdate) {
    console.log(
      `${LOG} ${tokenAddress.slice(0, 8)}… snapshot only ` +
      `(no open positions — priceSol=${priceData.priceSol})`,
    );
    return;
  }

  // Fetch all open/partially-closed wallets for this token
  const { data: rows, error } = await sb
    .from("wallet_performance_history")
    .select(
      "wallet_address, position_status, initial_investment, current_value, " +
      "current_token_balance, total_tokens_bought, total_tokens_sold, " +
      "peak_roi, peak_position_value_sol",
    )
    .eq("token_address", tokenAddress)
    .in("position_status", ["OPEN", "PARTIALLY_CLOSED"]);

  if (error || !rows?.length) {
    if (error) throw new Error(`wallet fetch: ${error.message}`);
    return;
  }

  const priceSol = priceData.priceSol;

  const updates = rows.map((row) => {
    const balance              = Number(row.current_token_balance ?? 0);
    const currentPositionValue = balance * priceSol;

    const investedSol  = Number(row.initial_investment ?? 0);
    const receivedSol  = Number(row.current_value      ?? 0);
    const tokensBought = Number(row.total_tokens_bought ?? 0);
    const tokensSold   = Number(row.total_tokens_sold   ?? 0);
    const status       = row.position_status as string;

    let realizedProfit   = 0;
    let unrealizedProfit = 0;
    let roiMultiple: number | null = null;

    if (status === "OPEN") {
      unrealizedProfit = currentPositionValue - investedSol;
      roiMultiple      = investedSol > 0 ? currentPositionValue / investedSol : null;
    } else if (status === "PARTIALLY_CLOSED") {
      const fractionSold      = tokensBought > 0 ? tokensSold / tokensBought : 0;
      const fractionRemaining = 1 - fractionSold;
      realizedProfit   = receivedSol - investedSol * fractionSold;
      unrealizedProfit = currentPositionValue - investedSol * fractionRemaining;
      roiMultiple      = investedSol > 0 ? (receivedSol + currentPositionValue) / investedSol : null;
    }

    const existingPeakRoi = Number(row.peak_roi ?? 0);
    const existingPeakPos = Number(row.peak_position_value_sol ?? 0);
    const newPeakRoi      = Math.max(roiMultiple ?? 0, existingPeakRoi) || null;
    const newPeakPos      = Math.max(currentPositionValue, existingPeakPos) || null;

    return {
      wallet_address:             row.wallet_address as string,
      token_address:              tokenAddress,
      current_token_price_sol:    priceSol,
      current_token_price_usd:    priceData.priceUsd     ?? null,
      current_market_cap_usd:     priceData.marketCapUsd ?? null,
      current_position_value_sol: currentPositionValue,
      realized_profit:            realizedProfit,
      unrealized_profit:          unrealizedProfit,
      roi_multiple:               roiMultiple,
      peak_roi:                   newPeakRoi,
      peak_position_value_sol:    newPeakPos,
      last_updated:               priceData.fetchedAt,
      _peakMoved: newPeakRoi !== existingPeakRoi || newPeakPos !== existingPeakPos,
    };
  });

  const peaksMovedCount = updates.filter((u) => u._peakMoved).length;
  const cleanUpdates    = updates.map(({ _peakMoved: _, ...rest }) => rest);

  const CHUNK = 200;
  for (let i = 0; i < cleanUpdates.length; i += CHUNK) {
    const chunk = cleanUpdates.slice(i, i + CHUNK);
    const { error: upsertErr } = await sb
      .from("wallet_performance_history")
      .upsert(chunk, { onConflict: "wallet_address,token_address", ignoreDuplicates: false });
    if (upsertErr) throw new Error(`upsert: ${upsertErr.message}`);
  }

  result.walletsUpdated += rows.length;
  result.peaksUpdated   += peaksMovedCount;

  console.log(
    `${LOG} ${tokenAddress.slice(0, 8)}… ` +
    `priceSol=${priceSol} wallets=${rows.length} peaks_moved=${peaksMovedCount}`,
  );
}

// ---------------------------------------------------------------------------
// Price snapshot insert — writes ALL token_price_history columns
// ---------------------------------------------------------------------------

async function insertPriceSnapshot(
  sb:            ReturnType<typeof createClient>,
  tokenAddress:  string,
  priceData:     Awaited<ReturnType<typeof fetchTokenPrice>>,
  refreshSource: string,
  result:        RefreshResult,
): Promise<void> {
  const { error } = await sb.from("token_price_history").insert({
    token_address:      tokenAddress,
    snapshotted_at:     priceData.fetchedAt,
    source:             "dexscreener",
    refresh_source:     refreshSource,
    pair_address:       priceData.pairAddress   ?? null,
    dex_id:             priceData.dexId         ?? null,
    quote_token_symbol: priceData.priceSol != null ? "SOL" : null,
    price_sol:          priceData.priceSol      ?? null,
    price_usd:          priceData.priceUsd      ?? null,
    market_cap_usd:     priceData.marketCapUsd  ?? null,
    liquidity_usd:      priceData.liquidityUsd  ?? null,
    fdv_usd:            priceData.fdvUsd        ?? null,
    volume_24h_usd:     priceData.volume24hUsd  ?? null,
    trigger:            "price_refresh_worker",
  });

  if (error) {
    const isDuplicate = error.message.includes("duplicate key");
    if (isDuplicate) {
      console.debug(
        `${LOG} snapshot duplicate skipped for ${tokenAddress.slice(0, 8)} (unique constraint)`,
      );
    } else {
      console.warn(`${LOG} snapshot insert failed for ${tokenAddress.slice(0, 8)}: ${error.message}`);
    }
  } else {
    result.snapshotsInserted++;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
