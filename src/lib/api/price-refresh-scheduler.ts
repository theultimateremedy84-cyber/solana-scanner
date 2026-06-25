// =============================================================================
// price-refresh-scheduler.ts
//
// Internal scheduler — fires refreshOpenPositionPrices every 15 minutes
// automatically when the server process starts on Railway.
//
// This replaces the need for a Railway Cron Job service.
// Does NOT modify the /api/price-refresh route or wallet-price-refresh.ts logic.
// =============================================================================

import { refreshOpenPositionPrices } from "./wallet-price-refresh";

const LOG        = "[PriceRefreshScheduler]";
const INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

let running = false;

async function tick(): Promise<void> {
  if (running) {
    console.warn(`${LOG} Previous run still in progress — skipping this tick`);
    return;
  }

  running = true;
  const startedAt = new Date().toISOString();
  console.log(`${LOG} Starting scheduled price refresh at ${startedAt}`);

  try {
    const result = await refreshOpenPositionPrices({ maxTokens: 50, delayMs: 200 });

    console.log(
      `${LOG} Done — tokens=${result.tokensProcessed} ` +
      `snapshots=${result.snapshotsInserted} wallets=${result.walletsUpdated} ` +
      `peaks=${result.peaksUpdated} errors=${result.errors.length} ` +
      `duration=${result.durationMs}ms`,
    );

    if (result.errors.length > 0) {
      console.warn(`${LOG} Errors:`, result.errors);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${LOG} Unhandled error during scheduled run: ${message}`);
  } finally {
    running = false;
  }
}

/**
 * Start the scheduler. Called once at server boot from src/server.ts.
 * Fires the first run after INTERVAL_MS (not immediately on boot),
 * then repeats on the same interval.
 */
export function startPriceRefreshScheduler(): void {
  console.log(
    `${LOG} Scheduler armed — will fire every ${INTERVAL_MS / 60_000} minutes. ` +
    `First run in ${INTERVAL_MS / 60_000} minutes.`,
  );

  setInterval(tick, INTERVAL_MS);
}
