// =============================================================================
// rescore-scheduler.ts
//
// Internal scheduler — fires rescoreAllWallets() automatically on a fixed
// interval, mirroring the pattern used by price-refresh-scheduler.ts.
//
// PATCH FIX (audit-6 staleness gap):
//   Previously, rescoring only ran once via startRescoreOnBoot() (rescore-
//   handler.ts), fired after a 10s warmup delay and NEVER AGAIN for the life
//   of the process. Because enrichment (Helius scans) keeps running in the
//   background via the wallet_collection_jobs scheduler, that one boot-time
//   rescore captured whatever partial state existed 10s after boot and then
//   went permanently stale — this is exactly why win_rate/average_roi were
//   observed frozen at values computed from only 38 wallets while 835 had
//   since been enriched.
//
//   Fix: rescoreAllWallets() now runs on a recurring interval, so scoring
//   always catches up with whatever enrichment has completed since the last
//   tick, regardless of how long enrichment takes or when it finishes.
//
// Safe to run repeatedly — rescoreAllWallets() only reads existing DB rows
// (no Helius calls) and scores only improve, never degrade.
// =============================================================================

import { rescoreAllWallets } from "./wallet-rescoring";

const LOG        = "[RescoreScheduler]";
const INTERVAL_MS = 20 * 60 * 1000;   // 20 minutes between scheduled rescores

/** After this many consecutive failures the scheduler emits a CRITICAL alert. */
const MAX_CONSECUTIVE_FAILURES = 3;

let running             = false;
let consecutiveFailures = 0;

async function tick(): Promise<void> {
  if (running) {
    console.warn(`${LOG} Previous rescore still in progress — skipping this tick`);
    return;
  }

  running = true;
  const startedAt = new Date().toISOString();
  console.log(`${LOG} Starting scheduled rescore at ${startedAt}`);

  try {
    const result = await rescoreAllWallets({ batchSize: 200, delayMs: 0 });

    consecutiveFailures = 0;

    console.log(
      `${LOG} Done — wallets=${result.totalWallets} classified=${result.classified} ` +
      `batches=${result.batches} errors=${result.errors.length} duration=${result.durationMs}ms`,
    );

    if (result.errors.length > 0) {
      console.warn(`${LOG} Non-fatal errors during run:`, result.errors.slice(0, 5));
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
        `${LOG} ‼ CRITICAL: ${consecutiveFailures} consecutive rescore failures. ` +
        "Check Supabase connectivity and SUPABASE_SERVICE_ROLE_KEY. " +
        "The scheduler will keep retrying every 20 minutes.",
      );
    }
  } finally {
    running = false;
  }
}

/**
 * Start the rescore scheduler. Called once at server boot from src/server.ts.
 *
 * Fires an immediate first rescore (after a short warmup delay so DB
 * connections and other schedulers are up), then repeats on the configured
 * interval for the lifetime of the process — replacing the old one-shot
 * startRescoreOnBoot() behaviour.
 *
 * Returns a cleanup function that clears the interval — call it in
 * graceful-shutdown handlers or tests to avoid dangling timers.
 */
export function startRescoreScheduler(): () => void {
  console.log(
    `${LOG} Scheduler starting — interval: ${INTERVAL_MS / 60_000} minutes. ` +
    "First rescore fires after a 10s warmup delay.",
  );

  const warmup = setTimeout(() => {
    void tick();
  }, 10_000);

  const handle = setInterval(tick, INTERVAL_MS);

  return () => {
    clearTimeout(warmup);
    clearInterval(handle);
    console.log(`${LOG} Scheduler stopped.`);
  };
}
