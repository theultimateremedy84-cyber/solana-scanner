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
//   (the enricher default). With 10 tokens × 20 wallets = 200 wallets max per run
//   the tick takes ≈200-360 seconds, within the 30-minute interval.
//   Throughput doubled (Fix 6) to clear 62% win_rate null backlog faster.
//   If Helius budget pressure appears, reduce WALLETS_PER_TOKEN back to 10.
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
import { rescoreAllWallets } from "./wallet-rescoring";

const LOG = "[EnrichUnenrichedScheduler]";

// ── Tuning constants ──────────────────────────────────────────────────────────
/** How often to run the enrichment sweep. */
const INTERVAL_MS = 30 * 60 * 1_000; // 30 minutes

/** Warm-up delay before the first run (lets other schedulers initialise first). */
const WARMUP_DELAY_MS = 30_000; // 30 seconds

/** Max tokens to process per scheduler tick. */
const TOKENS_PER_RUN = 10;  // was 5 (Fix 6)

/**
 * Of TOKENS_PER_RUN, how many slots to reserve for the smallest hollow-count
 * tokens instead of always taking the biggest ones (anti-starvation fix —
 * see comment at the call site). 3 of 10 slots keeps most throughput on the
 * big backlog while still guaranteeing the long tail gets cycled through.
 */
const LONG_TAIL_SLOTS = 3;

/** Max wallets to enrich per token per tick (respects Helius rate limits). */
const WALLETS_PER_TOKEN = 20;  // was 10 (Fix 6)

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
  // ── Step 1: load the "already done" set ─────────────────────────────────
  const enrichedSet = new Set<string>();
  try {
    let page = 0;
    const pageSize = 1_000;
    while (true) {
      const { data, error } = await sb
        .from("wallet_raw_tx_metrics")
        .select("wallet_address, token_address")
        .eq("data_source", "helius_full_history")
        .range(page * pageSize, (page + 1) * pageSize - 1);
      if (error) { errors.push(`enrichedSet page ${page}: ${error.message}`); break; }
      if (!data?.length) break;
      for (const r of data) {
        enrichedSet.add(`${r.wallet_address as string}::${r.token_address as string}`);
      }
      if (data.length < pageSize) break;
      page++;
    }
  } catch (err) {
    errors.push(`enrichedSet fetch: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Step 2: load the full work queue from wallet_performance_history ─────
  const perfPairs: Array<{ wallet_address: string; token_address: string }> = [];
  try {
    let page = 0;
    const pageSize = 1_000;
    while (true) {
      const { data, error } = await sb
        .from("wallet_performance_history")
        .select("wallet_address, token_address")
        .range(page * pageSize, (page + 1) * pageSize - 1);
      if (error) { errors.push(`perfPairs page ${page}: ${error.message}`); break; }
      if (!data?.length) break;
      for (const r of data) {
        perfPairs.push({
          wallet_address: r.wallet_address as string,
          token_address:  r.token_address  as string,
        });
      }
      if (data.length < pageSize) break;
      page++;
    }
  } catch (err) {
    errors.push(`perfPairs fetch: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Step 3: diff → group hollow wallets by token ─────────────────────────
  const tokenMap = new Map<string, string[]>();
  for (const { wallet_address, token_address } of perfPairs) {
    const key = `${wallet_address}::${token_address}`;
    if (!enrichedSet.has(key)) {
      const list = tokenMap.get(token_address) ?? [];
      if (!list.includes(wallet_address)) list.push(wallet_address);
      tokenMap.set(token_address, list);
    }
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
          delayMs:         800, // slightly below the default 1000ms to stay within budget
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

    // ── Lightweight rescore so scores appear without waiting 20 minutes ──
    if (totalEnriched > 0) {
      console.log(`${LOG} Triggering post-enrichment rescore for ${totalEnriched} newly enriched wallets`);
      try {
        const rescore = await rescoreAllWallets({ batchSize: 200, delayMs: 0 });
        console.log(
          `${LOG} Rescore done — classified=${rescore.classified} discovery=${rescore.discoveryScored} ` +
          `errors=${rescore.errors.length}`,
        );
      } catch (err) {
        const msg = `rescore: ${err instanceof Error ? err.message : String(err)}`;
        console.warn(`${LOG} Non-fatal rescore error: ${msg}`);
        errors.push(msg);
      }
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
export async function getEnrichmentCoverage(): Promise<{
  totalWallets:    number;
  enrichedWallets: number;
  hollowWallets:   number;
  coveragePct:     number;
}> {
  const sb = supabaseAdmin;

  try {
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
  } catch {
    return { totalWallets: 0, enrichedWallets: 0, hollowWallets: 0, coveragePct: 0 };
  }
}
