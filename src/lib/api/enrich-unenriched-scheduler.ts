// =============================================================================
// enrich-unenriched-scheduler.ts  (P3-D — Automated Enrichment Schedule)
//
// Background scheduler that automatically enriches wallets that have NEVER
// been through the Helius full-history enricher.  These wallets show up as
// win_rate = NULL / wallet_classification = 'unknown' in the leaderboard,
// creating the 62% data-completeness gap identified in the audit.
//
// STRATEGY
// ─────────
// Rather than scanning wallet_performance_history.position_status = 'UNKNOWN'
// (which the existing enrich-handler already handles), this scheduler finds
// wallet × token pairs that are ENTIRELY MISSING from wallet_raw_tx_metrics
// OR whose data_source is NOT 'helius_full_history'.  Those are the "hollow"
// wallet records — populated from holder_scan or pool_extraction but never
// given real Helius transaction history.
//
// Each tick:
//   1. Load all wallet_raw_tx_metrics rows with data_source = 'helius_full_history'
//      (the "already done" set) — capped at 2 000 rows.
//   2. Load all wallet_performance_history rows — this is the full work queue.
//   3. Diff → pick the top TOKENS_PER_RUN tokens with the most hollow wallets.
//   4. For each token call enrichWalletsForToken (up to WALLETS_PER_TOKEN wallets).
//   5. After enrichment, trigger a lightweight rescore so win_rate/average_roi
//      appear immediately without waiting for the 20-minute rescore scheduler.
//
// RATE LIMITING
//   Each enrichWalletsForToken call respects a 1-second inter-wallet delay
//   (the enricher default). With 5 tokens × 10 wallets = 50 wallets max per run
//   the tick takes ≈50-90 seconds, well within the 30-minute interval.
//   See file header RATE LIMITING note — Fix 6 values reverted due to credit exhaustion.
//   Raise these gradually once the tx-reconstructor credit fix is validated.
//
// ROBUSTNESS
//   • Skips if a previous tick is still running.
//   • Consecutive failure counter — emits CRITICAL after 3 failures.
//   • Each tick is idempotent; running it twice doesn't degrade data.
//
// WIRING
//   Called from src/server.ts:  startEnrichUnenrichedScheduler();
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { enrichWalletsForToken } from "./wallet-enricher";
import { fetchTokenPrice } from "./wallet-collection-worker";

const LOG = "[EnrichUnenrichedScheduler]";

// ── Tuning constants ──────────────────────────────────────────────────────────
/** How often to run the enrichment sweep. */
const INTERVAL_MS = 60_000; // 1 minute — tick restarts immediately after previous finishes
// NOTE: the `running` guard prevents concurrent ticks. If a tick takes longer
// than 1 minute (typical with WALLETS_PER_TOKEN=200), the next interval fires
// but is immediately skipped. Effective cadence = tick duration, not interval.
// Setting interval to 1 minute ensures the next tick fires as fast as possible
// after the current one finishes.

/** Warm-up delay before the first run (lets other schedulers initialise first). */
const WARMUP_DELAY_MS = 15_000; // 15 seconds — faster start in BACKLOG_MODE

/** Max tokens to process per scheduler tick. */
// RAISED 10 → 50 (2026-07-10): the backlog is spread thin across ~1,000
// distinct tokens with only 1-2 hollow wallets each, so WALLETS_PER_TOKEN=200
// almost never binds — throughput was actually capped by TOKENS_PER_RUN.
// See RPC_LIMIT below: it is now a FIXED cap, not multiplied by this value,
// so raising this does NOT blow up the find_hollow_pairs() row fetch.
const TOKENS_PER_RUN = 50;

/**
 * Of TOKENS_PER_RUN, how many slots to reserve for the smallest hollow-count
 * tokens instead of always taking the biggest ones (anti-starvation fix —
 * see comment at the call site). 3 of 10 slots keeps most throughput on the
 * big backlog while still guaranteeing the long tail gets cycled through.
 */
const LONG_TAIL_SLOTS = 3; // 30% long-tail reservation of TOKENS_PER_RUN=10

/** Max wallets to enrich per token per tick. */
// BACKLOG_MODE: raised to 200 (from 75) — Helius budget is unlimited (HELIUS_BUDGET=0)
// so the only constraint is Helius per-second RPS, which the enricher handles
// internally via 429 retry logic.
// At 200 wallets × 10 tokens × ~400ms effective/wallet ≈ 13-15 min per tick.
// ~26,800 hollow wallets ÷ 2,000 per tick = ~14 ticks ≈ 3-4 hours to clear.
const WALLETS_PER_TOKEN = 200;

/** After this many consecutive failures, emit a CRITICAL log. */
const MAX_CONSECUTIVE_FAILURES = 3;

// ── State ─────────────────────────────────────────────────────────────────────
let running = false;
let consecutiveFailures = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

// getSupabase() consolidated → supabaseAdmin from client.server

/**
 * Find wallet × token pairs that have NOT yet been enriched with Helius
 * full transaction history.  Returns a map of token_address → wallet[].
 */
export async function findHollowPairs(
  sb: ReturnType<typeof createClient>,
  errors: string[],
): Promise<Map<string, string[]>> {
  // FIX (Supabase compute-exhaustion investigation, 2026-07-08): this used to
  // paginate through the ENTIRE wallet_performance_history table AND the
  // ENTIRE wallet_raw_tx_metrics table (both unbounded, growing tables —
  // wallet_performance_history alone was already 42k+ rows), pull every row
  // into Node memory, and diff them client-side with a JS Set. That's two
  // full-table transfers, every 30 minutes, forever. Both tables already had
  // the composite indexes needed to do this as a single indexed anti-join
  // entirely in Postgres (see find_hollow_pairs() RPC, migration
  // 20260710000001), so the DB now only ever returns the rows that are
  // actually hollow instead of shipping the whole tables over the wire on
  // every tick.
  const tokenMap = new Map<string, string[]>();

  // AUDIT FIX (2026-07-08): pass p_limit so the DB only ships the rows this
  // tick will actually use — previously returned all 38k+ hollow pairs on
  // every 30-minute tick (see migration 20260711000001).
  //
  // FIXED CAP, NOT SCALED BY TOKENS_PER_RUN (2026-07-10): this used to be
  // TOKENS_PER_RUN * WALLETS_PER_TOKEN * 5, which meant raising TOKENS_PER_RUN
  // (to increase throughput against a long-tail backlog where most tokens
  // only have 1-2 hollow wallets) would linearly blow up the row count
  // fetched from find_hollow_pairs() every tick — e.g. 10->50 tokens would
  // have taken this from 10,000 to 50,000 rows/tick (3M+ rows/hour), which
  // is the same shape of full-table-scan-adjacent load that caused the
  // original Supabase compute-exhaustion incident this RPC was built to fix.
  // A flat cap decouples "how many candidate rows we look at" from "how many
  // tokens we act on" — since the backlog's tokens mostly have 1-2 hollow
  // wallets each, even 3,000 candidate rows contains far more than enough
  // distinct tokens to fill TOKENS_PER_RUN slots.
  const RPC_LIMIT = 3_000;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (sb as any).rpc('find_hollow_pairs', { p_limit: RPC_LIMIT });

  if (error) {
    errors.push(`find_hollow_pairs RPC: ${error.message}`);
    return tokenMap;
  }

  for (const row of (data ?? []) as Array<{ wallet_address: string; token_address: string }>) {
    const list = tokenMap.get(row.token_address) ?? [];
    if (!list.includes(row.wallet_address)) list.push(row.wallet_address);
    tokenMap.set(row.token_address, list);
  }

  return tokenMap;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tick
// ─────────────────────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  if (running) {
    console.warn(`${LOG} Previous enrichment run still in progress — skipping this tick`);
    return;
  }

  const sb = supabaseAdmin;

  running = true;
  const startedAt = new Date().toISOString();
  console.log(`${LOG} ═══ Starting unenriched-wallet sweep at ${startedAt}`);

  const errors: string[] = [];

  try {
    // ── Find hollow pairs ────────────────────────────────────────────────
    const tokenMap = await findHollowPairs(sb, errors);

    const totalHollow = Array.from(tokenMap.values()).reduce((s, w) => s + w.length, 0);

    if (totalHollow === 0) {
      console.log(`${LOG} No hollow wallets found — all wallets have Helius history ✓`);
      consecutiveFailures = 0;
      return;
    }

    // ANTI-STARVATION FIX: picking strictly the top N tokens by hollow-count
    // let large tokens dominate every single tick, permanently starving the
    // long tail of tokens that only have 1-2 hollow wallets (e.g. rescanned
    // one-off tokens). This caused a subset of wallets to sit at
    // win_rate=NULL / position_status=UNKNOWN indefinitely even though the
    // scheduler ran every 30 minutes. Fix: reserve LONG_TAIL_SLOTS for the
    // smallest hollow-count tokens (round-robin via oldest-untouched), so
    // every token eventually gets a turn instead of only the biggest ones.
    const allTokensSorted = Array.from(tokenMap.entries())
      .sort((a, b) => b[1].length - a[1].length);

    const bigSlots = TOKENS_PER_RUN - LONG_TAIL_SLOTS;
    const topTokens = allTokensSorted.slice(0, Math.max(0, bigSlots));

    if (LONG_TAIL_SLOTS > 0 && allTokensSorted.length > topTokens.length) {
      const tail = allTokensSorted.slice(topTokens.length);
      // Smallest hollow-count first — these are the ones most likely to have
      // been starved by bigger tokens in previous ticks.
      const tailSorted = [...tail].sort((a, b) => a[1].length - b[1].length);
      topTokens.push(...tailSorted.slice(0, LONG_TAIL_SLOTS));
    }

    console.log(
      `${LOG} ${totalHollow} hollow wallets across ${tokenMap.size} tokens — ` +
      `processing top ${topTokens.length}: ` +
      topTokens.map(([t, w]) => `${t.slice(0, 8)}…(${w.length})`).join(", "),
    );

    // ── Enrich each token ────────────────────────────────────────────────
    let totalEnriched = 0;
    let totalSkipped  = 0;
    let totalTrades   = 0;

    for (const [tokenAddress, wallets] of topTokens) {
      const batch = wallets.slice(0, WALLETS_PER_TOKEN);
      try {
        const priceData = await fetchTokenPrice(tokenAddress);
        const result = await enrichWalletsForToken({
          tokenAddress,
          walletAddresses: batch,
          priceData,
          maxWallets:      batch.length,
          delayMs:         100, // Delay between parallel CHUNKS (not individual wallets).
                                // ENRICHER_CONCURRENCY wallets run simultaneously per chunk;
                                // 100ms gap between chunks is enough to avoid Helius burst
                                // rejection without meaningfully impacting throughput.
                                // Set ENRICHER_CONCURRENCY env var to tune parallelism (default 5).
        });

        totalEnriched += result.walletsEnriched;
        totalSkipped  += result.walletsSkipped;
        totalTrades   += result.tradesInserted;

        console.log(
          `${LOG}   token ${tokenAddress.slice(0, 8)}…` +
          ` enriched=${result.walletsEnriched} skipped=${result.walletsSkipped}` +
          ` trades=${result.tradesInserted} errors=${result.errors.length}`,
        );

        if (result.errors.length > 0) {
          errors.push(...result.errors.slice(0, 3));
        }
      } catch (err) {
        const msg = `token ${tokenAddress.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`;
        console.error(`${LOG} ✗ ${msg}`);
        errors.push(msg);
      }
    }

    // ── Rescore deferred to the dedicated 20-minute rescore scheduler ────────
    // Previously this triggered rescoreAllWallets() after every enrichment tick.
    // With INTERVAL_MS=5 min and WALLETS_PER_TOKEN=75 the tick fires ~4-5×/hour,
    // meaning rescoreAllWallets (3 full passes over 26,838 wallets) would also
    // run 4-5×/hour instead of the previous ~2×/hour — doubling Supabase load
    // for no meaningful UX gain (scores appear within 20 min either way).
    // The standalone rescore scheduler handles this at a fixed cadence.
    if (totalEnriched > 0) {
      console.log(
        `${LOG} ${totalEnriched} wallets enriched — scores will update on next rescore-scheduler tick (≤20 min)`,
      );
    }

    consecutiveFailures = 0;

    console.log(
      `${LOG} ═══ Done — enriched=${totalEnriched} skipped=${totalSkipped} ` +
      `trades=${totalTrades} remaining_hollow=${totalHollow - totalEnriched} ` +
      `errors=${errors.length}`,
    );

    if (errors.length > 0) {
      console.warn(`${LOG} Non-fatal errors during run:`, errors.slice(0, 5));
    }
  } catch (err) {
    consecutiveFailures++;
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `${LOG} Unhandled error during scheduled run: ${message} ` +
      `(consecutive failures: ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
    );

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.error(
        `${LOG} ‼ CRITICAL: ${consecutiveFailures} consecutive enrichment failures. ` +
        "Check HELIUS_API_KEY, SUPABASE_SERVICE_ROLE_KEY, and Supabase connectivity. " +
        "The scheduler will keep retrying every 30 minutes.",
      );
    }
  } finally {
    running = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Start the unenriched-wallet enrichment scheduler.
 * Called ONCE from src/server.ts at boot.
 *
 * Returns a cleanup function that stops both the warmup timer and the
 * recurring interval — call it in graceful-shutdown handlers or tests.
 */
export function startEnrichUnenrichedScheduler(): () => void {
  console.log(
    `${LOG} Scheduler starting — ` +
    `interval: ${INTERVAL_MS / 60_000} minutes, ` +
    `first run in ${WARMUP_DELAY_MS / 1_000}s, ` +
    `tokens/run: ${TOKENS_PER_RUN}, wallets/token: ${WALLETS_PER_TOKEN}.`,
  );

  const warmup = setTimeout(() => { void tick(); }, WARMUP_DELAY_MS);
  const handle = setInterval(tick, INTERVAL_MS);

  return () => {
    clearTimeout(warmup);
    clearInterval(handle);
    console.log(`${LOG} Scheduler stopped.`);
  };
}

/**
 * Returns a snapshot of the enrichment coverage — useful for the leaderboard
 * stats panel and the /api/discovery-status endpoint.
 *
 * Counts distinct wallets (not rows) in wallet_raw_tx_metrics so a wallet
 * with multiple helius-enriched tokens is counted once, not once per token.
 * Paginates through all rows to avoid the hard-limit undercounting issue.
 */
// FIX (2026-07-11, healthcheck-hang incident): this function is called from
// /api/discovery-status, which was (mis)configured as the Railway deploy
// healthcheck. It previously had no overall time budget — under heavy
// concurrent Supabase load (e.g. from the enrichment scheduler's parallel
// wallet processing) its up-to-90-request pagination loop could take long
// enough that health checks timed out. The healthcheck target has been moved
// to the dependency-free /healthz endpoint (see railway.toml), but this
// function is also used elsewhere (leaderboard stats), so it gets its own
// hard deadline regardless of caller — it must never hang.
const COVERAGE_TIMEOUT_MS = 4_000;

export async function getEnrichmentCoverage(): Promise<{
  totalWallets:    number;
  enrichedWallets: number;
  hollowWallets:   number;
  coveragePct:     number;
}> {
  const sb = supabaseAdmin;
  const fallback = { totalWallets: 0, enrichedWallets: 0, hollowWallets: 0, coveragePct: 0 };

  const work = (async () => {
    // Total wallets — use head:true count (single DB round-trip, no row transfer)
    const { count: totalWallets } = await sb
      .from("wallets")
      .select("wallet_address", { count: "exact", head: true });

    // Distinct enriched wallets — paginate to avoid row-limit undercounting.
    // 835 wallets × ~108 tokens average ≈ 90 000 rows worst-case; page at 1 000.
    const enrichedSet = new Set<string>();
    let page = 0;
    const PAGE = 1_000;
    while (true) {
      const { data, error } = await sb
        .from("wallet_raw_tx_metrics")
        .select("wallet_address")
        .eq("data_source", "helius_full_history")
        .range(page * PAGE, (page + 1) * PAGE - 1);
      if (error || !data?.length) break;
      for (const r of data) enrichedSet.add(r.wallet_address as string);
      if (data.length < PAGE) break;
      page++;
    }

    const total          = totalWallets ?? 0;
    const enrichedWallets = enrichedSet.size;
    const hollowWallets   = Math.max(0, total - enrichedWallets);
    const coveragePct     = total > 0 ? Math.round((enrichedWallets / total) * 100) : 0;

    return { totalWallets: total, enrichedWallets, hollowWallets, coveragePct };
  })();

  const timeout = new Promise<typeof fallback>((resolve) => {
    setTimeout(() => resolve(fallback), COVERAGE_TIMEOUT_MS);
  });

  try {
    return await Promise.race([work, timeout]);
  } catch {
    return fallback;
  }
}
