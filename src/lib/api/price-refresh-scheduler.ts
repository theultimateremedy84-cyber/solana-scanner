// =============================================================================
// price-refresh-scheduler.ts
//
// Internal scheduler — fires refreshOpenPositionPrices every 15 minutes
// automatically when the server process starts on Railway.
//
// FIXES (audit SCHED-01, SCHED-02, SCHED-03):
//   SCHED-01: First run now fires immediately on boot (no 15-minute cold wait).
//   SCHED-02: Consecutive failure counter added. After MAX_CONSECUTIVE_FAILURES
//             the scheduler logs a critical alert but keeps running (does not
//             silently accumulate failures with no signal).
//   SCHED-03: startPriceRefreshScheduler() now returns a cleanup function that
//             clears the interval — usable in graceful shutdown handlers or tests.
//
// This does NOT modify the /api/price-refresh route or wallet-price-refresh.ts.
// =============================================================================

import { refreshOpenPositionPrices } from "./wallet-price-refresh";

const LOG        = "[PriceRefreshScheduler]";
const INTERVAL_MS = 15 * 60 * 1000;     // 15 minutes between scheduled runs

/**
 * After this many consecutive failures the scheduler emits a CRITICAL alert.
 * The scheduler continues running — Railway health-check + logs will surface
 * the alert so operators can investigate.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

let running            = false;
let consecutiveFailures = 0;

async function tick(): Promise<void> {
  if (running) {
    console.warn(`${LOG} Previous run still in progress — skipping this tick`);
    return;
  }

  running = true;
  const startedAt = new Date().toISOString();
  console.log(`${LOG} Starting scheduled price refresh at ${startedAt}`);

  try {
    const result = await refreshOpenPositionPrices({ maxTokens: 150, delayMs: 200 });

    // Reset failure counter on success
    consecutiveFailures = 0;

    console.log(
      `${LOG} Done — tokens=${result.tokensProcessed} ` +
      `snapshots=${result.snapshotsInserted} wallets=${result.walletsUpdated} ` +
      `peaks=${result.peaksUpdated} errors=${result.errors.length} ` +
      `duration=${result.durationMs}ms`,
    );

    if (result.errors.length > 0) {
      console.warn(`${LOG} Non-fatal errors during run:`, result.errors);
    }
  } catch (err) {
    consecutiveFailures++;
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `${LOG} Unhandled error during scheduled run: ${message} ` +
      `(consecutive failures: ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
    );

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      // Emit a loud CRITICAL-level alert so monitoring / Railway logs surface it.
      console.error(
        `${LOG} ‼ CRITICAL: ${consecutiveFailures} consecutive price-refresh failures. ` +
        "Check Supabase connectivity, DexScreener availability, and SUPABASE_SERVICE_ROLE_KEY. " +
        "The scheduler will keep retrying every 15 minutes.",
      );
    }
  } finally {
    running = false;
  }
}

/**
 * Start the scheduler. Called once at server boot from src/server.ts.
 *
 * CHANGE: fires an immediate first run on boot so prices are fresh
 * from minute zero, then repeats on the configured interval.
 *
 * Returns a cleanup function that clears the interval — call it in
 * graceful-shutdown handlers or test teardown to avoid dangling timers.
 *
 * @example
 *   const stopScheduler = startPriceRefreshScheduler();
 *   process.on('SIGTERM', () => { stopScheduler(); server.close(); });
 */
export function startPriceRefreshScheduler(): () => void {
  console.log(
    `${LOG} Scheduler starting — interval: ${INTERVAL_MS / 60_000} minutes. ` +
    "Running first refresh immediately.",
  );

  // Immediate first run (fire-and-forget; errors are caught inside tick())
  void tick();

  // Subsequent runs on the fixed interval
  const handle = setInterval(tick, INTERVAL_MS);

  // Return cleanup function for graceful shutdown / testing
  return () => {
    clearInterval(handle);
    console.log(`${LOG} Scheduler stopped.`);
  };
}
