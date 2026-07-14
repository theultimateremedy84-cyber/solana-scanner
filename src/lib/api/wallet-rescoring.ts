// =============================================================================
// Wallet Rescoring  (v2 — adds P2-B Discovery Score computation)
//
// Changes from v1:
//   ADDED  Step 2: computeDiscoveryScores() — runs after wallet classification
//          to populate discovery_score, discovery_confidence, discovery_tier,
//          total_discoveries, successful_discoveries, avg_entry_market_cap
//          on the wallets table.
//
// Unchanged from v1:
//   Step 1: classifyWallets() — re-classifies ALL existing wallets from
//   wallet_raw_tx_metrics (primary) or wallet_performance_history (fallback)
//   and writes wallet_classification, intelligence_score, win_rate,
//   average_roi, conviction_score to wallets table.
//
// Standalone bulk rescorer — no Helius API calls required.
//
// Run via: POST /api/rescore-wallets
//
// When to run:
//   - After deploying P2-B prerequisites migration (one-time backfill)
//   - After any tuning change to wallet-classifier.ts or wallet-discovery-score.ts
//   - Periodically (e.g. every 20 min via rescore-scheduler.ts) to keep scores fresh
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { classifyWallets } from "./wallet-enricher";
import { computeDiscoveryScores } from "./wallet-discovery-score";

const LOG = "[WalletRescoring]";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RescoringResult {
  totalWallets:      number;
  classified:        number;
  discoveryScored:   number;
  rugsMarked:        number;
  batches:           number;
  errors:            string[];
  durationMs:        number;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Re-score all wallets in the database from their existing raw metrics.
 *
 * Runs two sequential passes:
 *   Pass 1 — Intelligence classification (classifyWallets via wallet-enricher)
 *   Pass 2 — Discovery score computation  (computeDiscoveryScores via wallet-discovery-score)
 *
 * @param batchSize  Wallets to classify per batch (default 200).
 * @param delayMs    Pause between classification batches in ms (default 0).
 */
export async function rescoreAllWallets(opts: {
  batchSize?: number;
  delayMs?:   number;
} = {}): Promise<RescoringResult> {
  const batchSize = opts.batchSize ?? 200;
  const delayMs   = opts.delayMs   ?? 0;
  const startTime = Date.now();

  const result: RescoringResult = {
    totalWallets:    0,
    classified:      0,
    discoveryScored: 0,
    rugsMarked:      0,
    batches:         0,
    errors:          [],
    durationMs:      0,
  };

  const sb = supabaseAdmin;
  if (!sb) {
    result.errors.push("Supabase credentials not configured");
    result.durationMs = Date.now() - startTime;
    return result;
  }

  console.log(`${LOG} ═══ Starting full wallet rescore (intelligence + discovery)`);

  // ── Collect all distinct wallet addresses ────────────────────────────────
  const walletAddresses = await collectAllWalletAddresses(sb, result.errors);

  if (walletAddresses.length === 0) {
    console.log(`${LOG} No wallets found to rescore`);
    result.durationMs = Date.now() - startTime;
    return result;
  }

  result.totalWallets = walletAddresses.length;
  console.log(`${LOG} Found ${walletAddresses.length} wallets to rescore`);

  // ══════════════════════════════════════════════════════════════════════════
  // PASS 0 — Implicit rug position resolution (UI accuracy)
  //
  // Updates wallet_performance_history.position_status to CLOSED for dead
  // tokens (< 3% of launch MC, snapshot > 3 days stale). This keeps the UI
  // accurate (position list, P&L displays). The scoring impact is handled
  // separately inside classifyWallets() via its own dead-token detection so
  // rugged positions are counted as losses even without a sell transaction.
  // ══════════════════════════════════════════════════════════════════════════
  console.log(`${LOG} ─── Pass 0: Implicit rug resolution`);
  result.rugsMarked = await markImplicitRugPositions(sb, result.errors);
  console.log(`${LOG} ─── Pass 0 complete: marked ${result.rugsMarked} implicit rug positions`);

  // ══════════════════════════════════════════════════════════════════════════
  // PASS 1 — Intelligence classification
  // classifyWallets() reads wallet_raw_tx_metrics, runs classifyWallet(),
  // and upserts wallet_classification, intelligence_score, win_rate,
  // average_roi, conviction_score into wallets table.
  // ══════════════════════════════════════════════════════════════════════════
  console.log(`${LOG} ─── Pass 1: Intelligence classification`);

  for (let offset = 0; offset < walletAddresses.length; offset += batchSize) {
    const batch = walletAddresses.slice(offset, offset + batchSize);
    const batchErrors: string[] = [];

    // Pass empty tokenAddress — classifyWallets uses cross-token data from
    // wallet_raw_tx_metrics; the tokenAddress parameter scopes no query here.
    const classified = await classifyWallets(sb, batch, "", batchErrors);

    result.classified += classified;
    result.batches++;
    result.errors.push(...batchErrors);

    console.log(
      `${LOG} Pass 1 batch ${result.batches}: classified ${classified}/${batch.length} ` +
      `(${offset + batch.length}/${walletAddresses.length} total)`,
    );

    if (delayMs > 0) await sleep(delayMs);
  }

  console.log(
    `${LOG} ─── Pass 1 complete: ${result.classified}/${result.totalWallets} classified`,
  );

  // ══════════════════════════════════════════════════════════════════════════
  // PASS 2 — Discovery score computation  (P2-B)
  // computeDiscoveryScores() reads wallet_performance_history and
  // wallet_token_activity, computes the 5-factor weighted score with
  // confidence weighting, and upserts discovery_score, discovery_confidence,
  // discovery_tier, total_discoveries, successful_discoveries,
  // avg_entry_market_cap into wallets table.
  // ══════════════════════════════════════════════════════════════════════════
  console.log(`${LOG} ─── Pass 2: Discovery score computation`);

  const discoveryResult = await computeDiscoveryScores(sb, walletAddresses, result.errors);
  result.discoveryScored = discoveryResult.walletsScored;

  console.log(
    `${LOG} ─── Pass 2 complete: ${result.discoveryScored}/${result.totalWallets} discovery-scored`,
  );

  // ══════════════════════════════════════════════════════════════════════════
  // PASS 3 — total_tokens_traded refresh
  //
  // The refresh_wallet_token_counts() Supabase RPC is silently failing for
  // rescoring runs (DB reality: 338/835 wallets show total_tokens_traded=0).
  // This pass computes the count directly in JS from wallet_performance_history
  // and upserts it into wallets, bypassing the RPC entirely.
  //
  // This is lightweight: 864 perf-history rows across 835 wallets takes < 1s.
  // ══════════════════════════════════════════════════════════════════════════
  console.log(`${LOG} ─── Pass 3: total_tokens_traded refresh`);
  const tokenCountsUpdated = await refreshTokenCounts(sb, result.errors);
  console.log(`${LOG} ─── Pass 3 complete: updated ${tokenCountsUpdated} wallets`);

  // ── Final summary ─────────────────────────────────────────────────────────
  result.durationMs = Date.now() - startTime;
  console.log(
    `${LOG} ═══ DONE — wallets=${result.totalWallets} ` +
    `classified=${result.classified} discovery=${result.discoveryScored} ` +
    `batches=${result.batches} errors=${result.errors.length} ` +
    `duration=${result.durationMs}ms`,
  );
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collect all distinct wallet addresses from the database.
 * Primary source: wallet_raw_tx_metrics (most wallets with real evidence).
 * Fallback:       wallets table (guarantees full 835-wallet coverage).
 */
// =============================================================================
// markImplicitRugPositions — Pass 0 of the rescore pipeline
//
// WHY THIS EXISTS
//   Most wallet positions on Pump.fun tokens never get marked CLOSED because:
//   (a) The token rugged — price went to zero but the wallet never sold.
//       The position stays permanently OPEN with no sell transaction on-chain.
//   (b) The token graduated to Raydium and the sell happened on a pool not
//       tracked by the original collection job.
//
//   Without CLOSED positions, win_rate and average_roi stay NULL for the
//   wallet → wallet gets stuck at the participation floor score (~0.35).
//   From live data: 86% of wallets have null win_rate; 93% score at the floor.
//
// WHAT THIS DOES
//   Identifies OPEN / UNKNOWN positions where the token's latest tracked
//   market cap (from token_price_history) has fallen to < 3% of the entry
//   market cap AND the latest price snapshot is > 72 hours old (giving up on
//   any recovery). Marks those positions as CLOSED so the classifier treats
//   them as losses in win_rate.
//
// SAFETY
//   - Only modifies rows where position_status IN ('OPEN', 'UNKNOWN').
//   - Never touches PARTIALLY_CLOSED or already-CLOSED rows.
//   - Conservative threshold (97% loss + 3-day stale) avoids false positives.
//   - Idempotent: running multiple times changes nothing after first pass.
// =============================================================================

async function markImplicitRugPositions(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb:     any,   // ReturnType<typeof createClient> — using any to avoid circular import
  errors: string[],
): Promise<number> {
  const LOG_RUG = "[WalletRescoring/ImplicitRug]";
  // PATCH (monetization-audit issue #5 — 2026-07-14):
  //   Two tuning changes to close more OPEN positions:
  //   (A) Staleness window: 72 h → 48 h.  A token that hasn't recovered in 2 days
  //       is extremely unlikely to recover; the extra day just delayed rug resolution.
  //   (B) MC threshold: 3% → 5%.  More OPEN positions qualify as dead, increasing
  //       win_rate coverage.  5% is still a conservative bar — legitimate volatile
  //       tokens rarely sustain > 95% drawdowns for 48 h without any trading.
  const THREE_DAYS_MS  = 2 * 24 * 60 * 60 * 1000;  // was 3 days — now 48 h
  const RUG_THRESHOLD  = 0.05;  // was 0.03 (3%) — now 5% of entry MC

  try {
    // ── Step 1: latest market_cap_usd snapshot per token ──────────────────
    // Fetch all price snapshots — not scoped to specific tokens since we want
    // to find ALL tokens with stale/dead prices across the entire DB.
    const { data: allPrices, error: priceErr } = await sb
      .from("token_price_history")
      .select("token_address, market_cap_usd, snapshotted_at")
      .not("market_cap_usd", "is", null)
      .gt("market_cap_usd", 0)
      .order("snapshotted_at", { ascending: false })
      .limit(50000);  // cap at 50K rows — sufficient for current scale

    if (priceErr || !allPrices?.length) {
      console.warn(`${LOG_RUG} Could not fetch price history: ${priceErr?.message ?? "no rows"}`);
      return 0;
    }

    // Keep only the most-recent snapshot per token
    const latestByToken = new Map<string, { marketCap: number; snapshotAt: Date }>();
    for (const row of allPrices) {
      if (!latestByToken.has(row.token_address as string)) {
        latestByToken.set(row.token_address as string, {
          marketCap:  Number(row.market_cap_usd),
          snapshotAt: new Date(row.snapshotted_at as string),
        });
      }
    }

    // ── Step 2: fetch OPEN / UNKNOWN positions with known entry MC ─────────
    // BUG-FIX (C-1/C-2 pagination): PostgREST silently caps unranged queries at
    // 1000 rows. With 15 k+ OPEN positions only the first 1000 were ever evaluated
    // — the remaining ~14 k were never considered for implicit-rug detection, leaving
    // them OPEN forever and preventing win_rate from being computed for their wallets.
    // Fix: paginate until exhausted.
    type OpenPosition = {
      wallet_address:    string;
      token_address:     string;
      position_status:   string;
      initial_investment: number;
      total_sol_received: number;
      last_updated:      string;
    };
    const openPositions: OpenPosition[] = [];
    {
      const OPEN_PAGE = 1000;
      let openPage = 0;
      while (true) {
        const { data: chunk, error: posErr } = await sb
          .from("wallet_performance_history")
          .select("wallet_address, token_address, position_status, initial_investment, total_sol_received, last_updated")
          .in("position_status", ["OPEN", "UNKNOWN"])
          .gt("initial_investment", 0)
          .range(openPage * OPEN_PAGE, (openPage + 1) * OPEN_PAGE - 1);
        if (posErr) {
          errors.push(`markImplicitRugPositions open-positions page ${openPage}: ${posErr.message}`);
          break;
        }
        if (!chunk?.length) break;
        openPositions.push(...(chunk as OpenPosition[]));
        if (chunk.length < OPEN_PAGE) break;
        openPage++;
      }
    }

    if (openPositions.length === 0) {
      console.log(`${LOG_RUG} No open positions to evaluate`);
      return 0;
    }
    console.log(`${LOG_RUG} Fetched ${openPositions.length} open positions to evaluate`);

    // ── Step 3: get entry market cap per token from wallet_collection_jobs ──
    // Use the earliest completed job per token as proxy for entry market cap.
    const tokenSet = [...new Set((openPositions as Array<{token_address: string}>).map(p => p.token_address))];

    // Chunk the .in() query to handle > 500 unique tokens (Supabase REST limit)
    const QUERY_CHUNK = 500;
    const jobMcRowsAll: Array<{token_address: string; market_cap_usd: number}> = [];
    for (let qi = 0; qi < tokenSet.length; qi += QUERY_CHUNK) {
      const slice = tokenSet.slice(qi, qi + QUERY_CHUNK);
      const { data: chunk } = await sb
        .from("wallet_collection_jobs")
        .select("token_address, market_cap_usd")
        .in("token_address", slice)
        .not("market_cap_usd", "is", null)
        .gt("market_cap_usd", 0)
        .order("created_at", { ascending: true });
      jobMcRowsAll.push(...(chunk ?? []));
    }
    const jobMcRows = jobMcRowsAll;

    // Keep first (earliest) job MC per token
    const entryMcByToken = new Map<string, number>();
    for (const row of jobMcRows) {
      if (!entryMcByToken.has(row.token_address as string)) {
        entryMcByToken.set(row.token_address as string, Number(row.market_cap_usd));
      }
    }

    // ── Step 4: identify rug candidates ────────────────────────────────────
    const now = Date.now();

    type ClosedCandidate = { wallet_address: string; token_address: string; roi_multiple: number };
    // C-2 FIX: three named buckets for log clarity; all end up in allToClose.
    const toCloseMcDead:  ClosedCandidate[] = [];  // Had price history; MC < 5% of entry (Path A — kept for stats)
    const toCloseDark:    ClosedCandidate[] = [];  // Had price history; snapshot ≥ 48h stale (C-2 — new bucket)
    const toCloseNoPrice: ClosedCandidate[] = [];  // Never appeared in token_price_history (Path B)

    for (const pos of (openPositions as Array<{wallet_address: string; token_address: string; position_status: string; initial_investment: number; total_sol_received: number; last_updated: string}>)) {
      const roi = pos.initial_investment > 0
        ? (pos.total_sol_received ?? 0) / pos.initial_investment
        : 0;

      const latest = latestByToken.get(pos.token_address);
      if (!latest) {
        // ── Path B: no price data ever ─────────────────────────────────────
        // The price refresh scheduler never found liquidity on DexScreener.
        // If the position has been OPEN for > 48h without any price record,
        // the token has never had detectable on-chain liquidity — total loss.
        const posAgeMs = pos.last_updated
          ? now - new Date(pos.last_updated).getTime()
          : Infinity;
        if (posAgeMs > THREE_DAYS_MS) {
          toCloseNoPrice.push({ wallet_address: pos.wallet_address, token_address: pos.token_address, roi_multiple: roi });
        }
        continue;
      }

      // Token has some price history — check staleness.
      // Skip if the most recent snapshot is < 48h old: token is still being
      // tracked by DexScreener and may recover.
      const snapshotAgeMs = now - latest.snapshotAt.getTime();
      if (snapshotAgeMs < THREE_DAYS_MS) continue;

      // ── C-2 FIX: snapshot ≥ 48h stale → token has gone dark ────────────
      // Per C-2 spec: "no price snapshot in the last 48h" is itself the dead
      // signal, independent of the MC ratio. Two gaps in the previous logic:
      //   (a) `if (entryMc <= 0) continue` — silently skipped tokens with a
      //       stale snapshot but no wallet_collection_jobs entry (unknown entry
      //       MC). These tokens had gone dark but were never closed.
      //   (b) MC ratio ≥ 5% — tokens rugged via liquidity removal rather than
      //       sell pressure leave the last snapshot at a "reasonable" MC (e.g.
      //       $50 k), but there is zero liquidity to exit. The 5% threshold
      //       missed all of them.
      //
      // New rule: if DexScreener has returned no data for a token for 48+ hours,
      // the position is a practical total loss regardless of the last known MC.
      // Log MC-dead vs dark separately for observability.
      const entryMc = entryMcByToken.get(pos.token_address) ?? 0;
      if (entryMc > 0 && latest.marketCap / entryMc < RUG_THRESHOLD) {
        // Sub-case: MC also verifiably crashed — log as MC-dead for stats
        toCloseMcDead.push({ wallet_address: pos.wallet_address, token_address: pos.token_address, roi_multiple: roi });
      } else {
        // Sub-case: dark (no entry MC, or MC was still > threshold at last snapshot)
        toCloseDark.push({ wallet_address: pos.wallet_address, token_address: pos.token_address, roi_multiple: roi });
      }
    }

    const allToClose = [...toCloseMcDead, ...toCloseDark, ...toCloseNoPrice];

    if (allToClose.length === 0) {
      console.log(`${LOG_RUG} No implicit rug positions found (checked ${openPositions.length} open positions)`);
      return 0;
    }

    console.log(
      `${LOG_RUG} Marking ${toCloseMcDead.length} MC-dead + ${toCloseDark.length} dark (C-2) + ${toCloseNoPrice.length} no-price-data positions as CLOSED`,
    );

    // ── Step 5: batch-close the identified positions ───────────────────────
    const CHUNK = 50;
    let marked = 0;
    for (let i = 0; i < allToClose.length; i += CHUNK) {
      const chunk = allToClose.slice(i, i + CHUNK);
      const settledResults = await Promise.allSettled(
        chunk.map(({ wallet_address, token_address, roi_multiple }) =>
          sb
            .from("wallet_performance_history")
            .update({
              position_status: "CLOSED",
              roi_multiple,
              updated_at:      new Date().toISOString(),
            })
            .eq("wallet_address", wallet_address)
            .eq("token_address",  token_address)
            .in("position_status", ["OPEN", "UNKNOWN"]),
        ),
      );
      // Supabase .update() resolves even on DB errors — inspect both
      // promise rejection (network/parse failure) AND result.value.error (DB failure).
      let chunkSuccesses = 0;
      for (const r of settledResults) {
        if (r.status === "rejected") {
          errors.push(`markImplicitRugPositions row update threw: ${r.reason}`);
        } else if (r.value?.error) {
          errors.push(`markImplicitRugPositions DB error: ${r.value.error.message}`);
        } else {
          chunkSuccesses++;
        }
      }
      marked += chunkSuccesses;
    }

    console.log(`${LOG_RUG} Done — ${marked} implicit rug positions closed`);
    return marked;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${LOG_RUG} Error: ${msg}`);
    errors.push(`markImplicitRugPositions: ${msg}`);
    return 0;
  }
}

async function collectAllWalletAddresses(
  sb:     ReturnType<typeof createClient>,
  errors: string[],
): Promise<string[]> {
  const seen = new Set<string>();

  // Source 1: wallet_raw_tx_metrics
  try {
    let page = 0;
    const pageSize = 1000;
    while (true) {
      const { data, error } = await sb
        .from("wallet_raw_tx_metrics")
        .select("wallet_address")
        .range(page * pageSize, (page + 1) * pageSize - 1);
      if (error) { errors.push(`raw_metrics page ${page}: ${error.message}`); break; }
      if (!data?.length) break;
      for (const row of data) seen.add(row.wallet_address as string);
      if (data.length < pageSize) break;
      page++;
    }
  } catch (err) {
    errors.push(`collectWallets raw_metrics: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Source 2: wallets table (catches any wallets not yet in raw_metrics)
  try {
    let page = 0;
    const pageSize = 1000;
    while (true) {
      const { data, error } = await sb
        .from("wallets")
        .select("wallet_address")
        .range(page * pageSize, (page + 1) * pageSize - 1);
      if (error) { errors.push(`wallets page ${page}: ${error.message}`); break; }
      if (!data?.length) break;
      for (const row of data) seen.add(row.wallet_address as string);
      if (data.length < pageSize) break;
      page++;
    }
  } catch (err) {
    errors.push(`collectWallets wallets: ${err instanceof Error ? err.message : String(err)}`);
  }

  return Array.from(seen);
}

// getSupabase() consolidated → supabaseAdmin from client.server

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Pass 3: total_tokens_traded refresh (bypasses broken RPC)
// ---------------------------------------------------------------------------

/**
 * Compute total_tokens_traded for every wallet directly from
 * wallet_performance_history (COUNT DISTINCT token_address per wallet) and
 * upsert it into the wallets table.
 *
 * Runs in O(perf_history_rows) time — at 864 rows this is < 500 ms.
 * Replaces the unreliable refresh_wallet_token_counts() RPC call.
 *
 * @returns number of wallet rows updated
 */
async function refreshTokenCounts(
  sb:     ReturnType<typeof createClient>,
  errors: string[],
): Promise<number> {
  // ── Step 1: fetch all (wallet_address, token_address) from perf history ──
  // On any page error we abort entirely (return 0) rather than writing
  // partial counts — a partial upsert would undercount wallets whose pages
  // hadn't been fetched yet.
  const allRows: Array<{ wallet_address: string; token_address: string }> = [];
  try {
    let page = 0;
    const pageSize = 1000;
    while (true) {
      const { data, error } = await sb
        .from("wallet_performance_history")
        .select("wallet_address,token_address")
        .range(page * pageSize, (page + 1) * pageSize - 1);
      if (error) {
        errors.push(`refreshTokenCounts page ${page}: ${error.message} — aborting to avoid partial writes`);
        return 0;   // abort: do not write any counts
      }
      if (!data?.length) break;
      for (const row of data) {
        allRows.push({
          wallet_address: row.wallet_address as string,
          token_address:  row.token_address  as string,
        });
      }
      if (data.length < pageSize) break;
      page++;
    }
  } catch (err) {
    errors.push(`refreshTokenCounts fetch: ${err instanceof Error ? err.message : String(err)} — aborting`);
    return 0;
  }

  // ── Step 2: compute distinct token count per wallet ──────────────────────
  const countByWallet = new Map<string, Set<string>>();
  for (const { wallet_address, token_address } of allRows) {
    if (!countByWallet.has(wallet_address)) {
      countByWallet.set(wallet_address, new Set());
    }
    countByWallet.get(wallet_address)!.add(token_address);
  }

  // ── Step 3: batch upsert into wallets.total_tokens_traded ────────────────
  const upsertRows = Array.from(countByWallet.entries()).map(([wallet_address, tokens]) => ({
    wallet_address,
    total_tokens_traded: tokens.size,
  }));

  const CHUNK = 200;
  let updated = 0;
  for (let i = 0; i < upsertRows.length; i += CHUNK) {
    const chunk = upsertRows.slice(i, i + CHUNK);
    const { error } = await sb
      .from("wallets")
      .upsert(chunk, { onConflict: "wallet_address", ignoreDuplicates: false });
    if (error) {
      errors.push(`refreshTokenCounts upsert chunk ${i}: ${error.message}`);
    } else {
      updated += chunk.length;
    }
  }

  return updated;
}
