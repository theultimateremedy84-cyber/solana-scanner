// =============================================================================
// Wallet Price Refresh Worker  (v5 — token coverage rotation fix)
//
// CHANGES FROM v4:
//   BUG-FIX (coverage gap): Only 86 of 8,084+ discovered tokens had any price
//   history. Root causes:
//     1. buildTokenList() used .limit(500) with no offset — same first-500 done
//        jobs selected every run (alphabetical order, never rotates).
//     2. snapshotSlots = Math.max(0, maxTokens - openCandidates.length):
//        when open-position tokens fill the 150-token budget, snapshotSlots=0
//        and snapshot-only tokens are completely excluded every run.
//
//   v5 fix:
//     1. Time-based rotating offset on the done-jobs query — each 15-minute
//        window fetches a different page of 1,000 done tokens, ensuring all
//        8,000+ discovered tokens are eventually covered.
//     2. Guaranteed SNAPSHOT_MIN_SLOTS (50) for snapshot-only tokens regardless
//        of how many open-position tokens exist.
//
//   v3 fix (kept): buildTokenList() uses a two-source union approach:
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
import { guardRoiMultiple } from "./tx-reconstructor";

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
// Token list builder — two-source union (v5: rotating coverage fix)
// ---------------------------------------------------------------------------

async function buildTokenList(
  sb:        ReturnType<typeof createClient>,
  maxTokens: number,
  errors:    string[],
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

  // Source B: rotating page of done jobs so ALL discovered tokens get price
  //   snapshots over time.
  //
  // FIX (v5 — coverage gap: 86 of 8,000+ tokens had price history):
  //   Old code: .limit(500) with no offset → same first-500 done jobs every
  //   run. Combined with open-position tokens consuming all maxTokens slots,
  //   snapshot-only tokens got zero slots on every busy run.
  //
  //   Fix: (1) Time-based rotating offset cycles through all done jobs across
  //   60 windows (one per 15-min scheduler tick). Each window fetches a
  //   DIFFERENT page of SNAPSHOT_PAGE_SIZE done tokens, ensuring all 8,000+
  //   discovered tokens are covered within ~15 hours (60 × 15 min).
  //   (2) SNAPSHOT_MIN_SLOTS guarantees at least 50 snapshot-only token slots
  //   every run, independent of how many open-position tokens fill the budget.
  //
  //   Coverage maths: 1,000 tokens/page × 60 windows = 60,000 distinct tokens
  //   rotateable — well beyond the current 8,000 done jobs.
  const SNAPSHOT_PAGE_SIZE = 1_000;
  const SNAPSHOT_MIN_SLOTS = 50;

  // rotationWindow increments once per 15-minute scheduler tick; mod 60 gives
  // a 0–59 window index that cycles through 60 × 1,000 = 60,000 done tokens.
  const rotationWindow  = Math.floor(Date.now() / (15 * 60 * 1_000));
  const rotatingOffset  = (rotationWindow % 60) * SNAPSHOT_PAGE_SIZE;

  const { data: jobRows, error: jobErr } = await sb
    .from("wallet_collection_jobs")
    .select("token_address")
    .eq("status", "done")
    .range(rotatingOffset, rotatingOffset + SNAPSHOT_PAGE_SIZE - 1);

  if (jobErr) errors.push(`Token jobs query: ${jobErr.message}`);

  const allTokens = new Set<string>(openTokenCount.keys());
  for (const row of jobRows ?? []) {
    allTokens.add(row.token_address as string);
  }

  // FIX (Issue 2 — staleness priority, v6):
  //   Source C — tokens with NO price snapshot in the last 7 days. These are
  //   tokens that have been missed by the rotating offset window (e.g. were
  //   briefly in the "processing" state when their offset window ran, or were
  //   discovered after the window passed).  Querying token_price_history for
  //   the recent cutoff and building a "recently snapped" exclusion set lets us
  //   promote stale tokens to the FRONT of the snapshot queue regardless of the
  //   current rotation window — guaranteeing a maximum 7-day price staleness.
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data: recentSnaps, error: recentErr } = await sb
    .from("token_price_history")
    .select("token_address")
    .gte("snapshotted_at", sevenDaysAgo)
    .limit(20_000);
  if (recentErr) errors.push(`Source C recent-snaps query: ${recentErr.message}`);
  const recentlySnapped = new Set<string>((recentSnaps ?? []).map((r) => r.token_address as string));

  // OPEN/PARTIALLY_CLOSED position tokens are always included — no cap.
  // FIX (v4, Fix 5A): the old candidates.slice(0, maxTokens) silently dropped
  // low-wallet-count OPEN tokens when snapshot-only tokens filled the list,
  // leaving 57 OPEN positions with current_position_value_sol = 0 forever.
  // Only snapshot-only (Source B) tokens are capped at remaining slots.

  // Step 1: ALL open-position tokens — no cap
  const openCandidates: TokenCandidate[] = Array.from(openTokenCount.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([ta, count]) => ({ tokenAddress: ta, walletCount: count, needsPnlUpdate: true }));

  // Step 2: snapshot-only tokens — guaranteed minimum of SNAPSHOT_MIN_SLOTS.
  //   Stale tokens (not in recentlySnapped) are sorted to the FRONT so they
  //   are processed first within the snapshot budget, ahead of freshly snapped
  //   tokens from the current rotation window.
  //
  // FIX (v5): was Math.max(0, maxTokens - openCandidates.length) — gave 0
  // slots whenever open-position tokens exceeded maxTokens, meaning snapshot-
  // only tokens were never processed on busy runs. SNAPSHOT_MIN_SLOTS (50)
  // guarantees at least 50 done-job tokens are snapshotted every run.
  const snapshotSlots = Math.max(SNAPSHOT_MIN_SLOTS, maxTokens - openCandidates.length);
  const snapshotCandidatesRaw: TokenCandidate[] = [];
  for (const ta of allTokens) {
    if (!openTokenCount.has(ta)) {
      snapshotCandidatesRaw.push({ tokenAddress: ta, walletCount: 0, needsPnlUpdate: false });
    }
  }
  // Stale (never / >7d snapped) tokens first, fresh tokens second
  snapshotCandidatesRaw.sort((a, b) => {
    const aStale = !recentlySnapped.has(a.tokenAddress) ? 0 : 1;
    const bStale = !recentlySnapped.has(b.tokenAddress) ? 0 : 1;
    return aStale - bStale;
  });
  const snapshotCandidates = snapshotCandidatesRaw.slice(0, snapshotSlots);

  const staleCount = snapshotCandidates.filter((c) => !recentlySnapped.has(c.tokenAddress)).length;
  console.log(
    `${LOG} buildTokenList — open=${openCandidates.length} ` +
    `snapshot-only=${snapshotCandidates.length} (stale>7d=${staleCount}, offset=${rotatingOffset} window=${rotationWindow % 60}/60)`,
  );

  return [...openCandidates, ...snapshotCandidates];
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
  let priceData = await fetchTokenPrice(tokenAddress);

  // BUG-FIX (56.5% NULL price_usd rows): a single DexScreener miss (rate
  // limit, transient timeout, or the pair not yet indexed) was recorded as a
  // permanent null snapshot with no retry. Retry once after a short delay
  // before giving up — this alone resolves most transient misses without
  // adding real latency to the refresh loop.
  if (priceData.priceSol == null && priceData.priceUsd == null) {
    await sleep(500);
    priceData = await fetchTokenPrice(tokenAddress);
  }

  if (priceData.priceSol == null && priceData.priceUsd == null) {
    // Still nothing after retry — most likely a pre-graduation pump.fun token
    // with no DexScreener pair yet, not a bug. Skip the snapshot insert
    // instead of writing an all-null row: a null row carries no information
    // and was inflating the "price coverage" denominator, making the true
    // null-rate look worse than it is on every read of token_price_history.
    console.warn(
      `${LOG} ${tokenAddress.slice(0, 8)}… no price after retry — skipping snapshot (no DexScreener pair yet)`,
    );
    return;
  }

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
    const balance = Number(row.current_token_balance ?? 0);

    // FIX (Fix 5B): when DexScreener returns no SOL price (delisted, no pair
    // yet, or transient miss), preserve the existing DB value rather than
    // overwriting it with 0. Writing balance * null = 0 was the root cause of
    // 57 OPEN positions showing current_position_value_sol = 0 permanently.
    const currentPositionValue: number | null =
      priceSol != null && priceSol > 0 ? balance * priceSol : null;

    const investedSol  = Number(row.initial_investment ?? 0);
    const receivedSol  = Number(row.current_value      ?? 0);
    const tokensBought = Number(row.total_tokens_bought ?? 0);
    const tokensSold   = Number(row.total_tokens_sold   ?? 0);
    const status       = row.position_status as string;

    let realizedProfit   = 0;
    let unrealizedProfit = 0;
    let roiMultiple: number | null = null;

    // Only compute unrealized P&L when we have a live SOL price
    if (currentPositionValue != null) {
      if (status === 'OPEN') {
        unrealizedProfit = currentPositionValue - investedSol;
        roiMultiple      = investedSol > 0 ? currentPositionValue / investedSol : null;
      } else if (status === 'PARTIALLY_CLOSED') {
        const fractionSold      = tokensBought > 0 ? tokensSold / tokensBought : 0;
        const fractionRemaining = 1 - fractionSold;
        realizedProfit   = receivedSol - investedSol * fractionSold;
        unrealizedProfit = currentPositionValue - investedSol * fractionRemaining;
        roiMultiple      = investedSol > 0 ? (receivedSol + currentPositionValue) / investedSol : null;
      }
    }

    // GUARD (2026-07-12, extended after redeploy audit): this worker recomputes
    // roi_multiple/peak_roi on every price tick, independent of computePnL /
    // classifyWallets — it was the one call site the original fix missed, and
    // it re-produced the same 15,000-19,000x distortion on the next tick after
    // deploy. Apply the same shared guard used everywhere else.
    roiMultiple = guardRoiMultiple(roiMultiple, investedSol);

    const existingPeakRoi = Number(row.peak_roi ?? 0);
    const existingPeakPos = Number(row.peak_position_value_sol ?? 0);
    const newPeakRoi      = Math.max(roiMultiple ?? 0, existingPeakRoi) || null;
    const newPeakPos      = currentPositionValue != null
      ? Math.max(currentPositionValue, existingPeakPos) || null
      : existingPeakPos || null;

    return {
      wallet_address:             row.wallet_address as string,
      token_address:              tokenAddress,
      current_token_price_sol:    priceSol,
      current_token_price_usd:    priceData.priceUsd     ?? null,
      current_market_cap_usd:     priceData.marketCapUsd ?? null,
      // Omit when price unavailable so upsert preserves existing DB value
      ...(currentPositionValue != null ? { current_position_value_sol: currentPositionValue } : {}),
      realized_profit:            realizedProfit,
      unrealized_profit:          unrealizedProfit,
      roi_multiple:               roiMultiple,
      peak_roi:                   newPeakRoi,
      peak_position_value_sol:    newPeakPos,
      last_updated:               priceData.fetchedAt,
      _peakMoved:    newPeakRoi !== existingPeakRoi || newPeakPos !== existingPeakPos,
      // Fix 5B complete: flag rows without usable price so they are excluded
      // from the upsert entirely — prevents realizedProfit/unrealizedProfit
      // zero-defaults from overwriting valid prior P&L stored in the DB.
      _hasPriceData: currentPositionValue != null,
    };
  });

  // Fix 5B: drop rows where price was unavailable — prevents zero-defaults
  // for realizedProfit/unrealizedProfit from overwriting valid prior DB values.
  const priceAvailableUpdates = updates.filter((u) => u._hasPriceData);
  const noPriceCount          = updates.length - priceAvailableUpdates.length;
  if (noPriceCount > 0) {
    console.warn(
      `${LOG} ${tokenAddress.slice(0, 8)}… skipping ${noPriceCount} wallet upsert(s) ` +
      `— price unavailable, preserving existing P&L`,
    );
  }
  const peaksMovedCount = priceAvailableUpdates.filter((u) => u._peakMoved).length;
  const cleanUpdates    = priceAvailableUpdates.map(({ _peakMoved: _, _hasPriceData: __, ...rest }) => rest);

  const CHUNK = 200;
  for (let i = 0; i < cleanUpdates.length; i += CHUNK) {
    const chunk = cleanUpdates.slice(i, i + CHUNK);
    const { error: upsertErr } = await sb
      .from("wallet_performance_history")
      .upsert(chunk, { onConflict: "wallet_address,token_address", ignoreDuplicates: false });
    if (upsertErr) throw new Error(`upsert: ${upsertErr.message}`);
  }

  result.walletsUpdated += priceAvailableUpdates.length;
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
