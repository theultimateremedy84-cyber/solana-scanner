// =============================================================================
// Wallet Price Refresh Worker  (v1)
//
// PHASE 4 — Periodic price snapshot worker
//
// PURPOSE:
//   Re-fetches live DexScreener prices for tokens that have OPEN or
//   PARTIALLY_CLOSED positions, then:
//     1. Updates current_token_price_sol, current_position_value_sol,
//        unrealized_profit, roi_multiple in wallet_performance_history.
//     2. Inserts a row into token_price_history for time-series tracking.
//     3. Updates peak_roi and peak_position_value_sol when new peaks are hit.
//
// WHY THIS IS SEPARATE FROM WALLET COLLECTION:
//   Wallet collection is expensive (Helius API calls, many RPC calls).
//   Price refresh is cheap (one DexScreener call per token, no RPC calls).
//   This worker can run every 15–30 minutes without hitting rate limits.
//
// CALL FROM:
//   A Railway cron service, a Supabase Edge Function schedule, or an
//   API endpoint called by an external cron (e.g. cron-job.org).
//
// USAGE:
//   import { refreshOpenPositionPrices } from "./wallet-price-refresh";
//   await refreshOpenPositionPrices({ maxTokens: 50 });
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

interface TokenBatch {
  token_address: string;
  wallet_count:  number;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Refresh prices and recalculate P&L for all tokens with open positions.
 *
 * @param maxTokens   Cap on how many tokens to process per run (default 100).
 *                    Increase only if you have confirmed DexScreener rate limits
 *                    are not an issue (typically 300 req/min free tier).
 * @param delayMs     Delay between DexScreener calls in milliseconds (default 200ms).
 *                    At 200ms that's max 5 tokens/second = well within limits.
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

  // ── Step 1: Find tokens with open or partially-closed positions ───────────
  const { data: tokens, error: tokenErr } = await sb
    .from("wallet_performance_history")
    .select("token_address, wallet_count:wallet_address.count()")
    .in("position_status", ["OPEN", "PARTIALLY_CLOSED"])
    .order("wallet_count", { ascending: false })
    .limit(maxTokens) as {
      data: TokenBatch[] | null;
      error: typeof tokenErr;
    };

  if (tokenErr || !tokens?.length) {
    if (tokenErr) result.errors.push(`Token query: ${tokenErr.message}`);
    console.log(`${LOG} No tokens with open positions found.`);
    result.durationMs = Date.now() - startTime;
    return result;
  }

  // Deduplicate (in case the count() alias returns multiple rows)
  const uniqueTokens = Array.from(new Set(tokens.map((t) => t.token_address)));
  console.log(`${LOG} ═══ refreshOpenPositionPrices START — ${uniqueTokens.length} tokens`);

  // ── Step 2: Process each token ────────────────────────────────────────────
  for (const tokenAddress of uniqueTokens) {
    try {
      await processSingleToken(sb, tokenAddress, result);
      // Polite delay to avoid hammering DexScreener
      if (delayMs > 0) await sleep(delayMs);
    } catch (err) {
      const msg = `${tokenAddress.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`;
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
// Per-token processing
// ---------------------------------------------------------------------------

async function processSingleToken(
  sb:           ReturnType<typeof createClient>,
  tokenAddress: string,
  result:       RefreshResult,
): Promise<void> {
  // Fetch live price
  const priceData = await fetchTokenPrice(tokenAddress);

  if (priceData.priceSol == null) {
    console.warn(`${LOG} ${tokenAddress.slice(0, 8)}… no SOL price — skipping wallet updates`);
    // Still insert a snapshot recording that no SOL pair was found
    await insertPriceSnapshot(sb, tokenAddress, priceData, null, null, result);
    return;
  }

  // Insert price snapshot for time-series history
  await insertPriceSnapshot(sb, tokenAddress, priceData, null, null, result);

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

  // Recalculate P&L for each wallet with the new price
  const updates = rows.map((row) => {
    const priceSol            = priceData.priceSol!;
    const balance             = Number(row.current_token_balance ?? 0);
    const currentPositionValue = balance * priceSol;

    const investedSol  = Number(row.initial_investment ?? 0);
    const receivedSol  = Number(row.current_value      ?? 0);
    const tokensBought = Number(row.total_tokens_bought ?? 0);
    const tokensSold   = Number(row.total_tokens_sold   ?? 0);
    const status       = row.position_status as string;

    // Compute P&L using the same logic as the collection worker
    let realizedProfit   = 0;
    let unrealizedProfit = 0;
    let roiMultiple: number | null = null;

    if (status === "OPEN") {
      unrealizedProfit = currentPositionValue - investedSol;
      roiMultiple      = investedSol > 0 ? currentPositionValue / investedSol : null;
    } else if (status === "PARTIALLY_CLOSED") {
      const fractionSold     = tokensBought > 0 ? tokensSold / tokensBought : 0;
      const fractionRemaining = 1 - fractionSold;
      realizedProfit   = receivedSol - investedSol * fractionSold;
      unrealizedProfit = currentPositionValue - investedSol * fractionRemaining;
      roiMultiple      = investedSol > 0 ? (receivedSol + currentPositionValue) / investedSol : null;
    }

    // Preserve peaks
    const existingPeakRoi = Number(row.peak_roi ?? 0);
    const existingPeakPos = Number(row.peak_position_value_sol ?? 0);
    const newPeakRoi      = Math.max(roiMultiple ?? 0, existingPeakRoi) || null;
    const newPeakPos      = Math.max(currentPositionValue, existingPeakPos) || null;

    return {
      wallet_address:              row.wallet_address as string,
      token_address:               tokenAddress,
      current_token_price_sol:     priceSol,
      current_token_price_usd:     priceData.priceUsd ?? null,
      current_market_cap_usd:      priceData.marketCapUsd ?? null,
      current_position_value_sol:  currentPositionValue,
      realized_profit:             realizedProfit,
      unrealized_profit:           unrealizedProfit,
      roi_multiple:                roiMultiple,
      peak_roi:                    newPeakRoi,
      peak_position_value_sol:     newPeakPos,
      last_updated:                priceData.fetchedAt,
      // Check if peaks moved
      _peakMoved: newPeakRoi !== existingPeakRoi || newPeakPos !== existingPeakPos,
    };
  });

  // Count peak updates before stripping the helper field
  const peaksMovedCount = updates.filter((u) => u._peakMoved).length;
  const cleanUpdates    = updates.map(({ _peakMoved: _, ...rest }) => rest);

  // Upsert in chunks of 200
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
// Price snapshot insert
// ---------------------------------------------------------------------------

async function insertPriceSnapshot(
  sb:           ReturnType<typeof createClient>,
  tokenAddress: string,
  priceData:    Awaited<ReturnType<typeof fetchTokenPrice>>,
  pairAddress:  string | null,
  dexId:        string | null,
  result:       RefreshResult,
): Promise<void> {
  const { error } = await sb.from("token_price_history").insert({
    token_address:       tokenAddress,
    snapshotted_at:      priceData.fetchedAt,
    source:              "dexscreener",
    pair_address:        pairAddress,
    dex_id:              dexId,
    quote_token_symbol:  priceData.priceSol != null ? "SOL" : null,
    price_sol:           priceData.priceSol   ?? null,
    price_usd:           priceData.priceUsd   ?? null,
    market_cap_usd:      priceData.marketCapUsd ?? null,
    trigger:             "refresh",
  });

  if (error) {
    // Non-fatal — snapshot insert failure shouldn't abort the wallet update
    console.warn(`${LOG} snapshot insert failed for ${tokenAddress.slice(0, 8)}: ${error.message}`);
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
