// =============================================================================
// helius-cu-log-retention-scheduler.ts
//
// Fixes audit finding #2: helius_cu_log has unbounded growth and no retention
// job. Even a plain COUNT(*) already times out after only ~3 days of data.
//
// This scheduler runs once daily (with an immediate first run on boot) and
// deletes rows older than RETENTION_DAYS. CU logs are operational telemetry
// for the Helius credit budget guard in token-discovery.ts — not data that
// needs to be kept forever.
//
// Pairs with the index added in
// supabase/migrations/20260709000002_helius_cu_log_table_and_retention.sql,
// which also defines prune_helius_cu_log() as a plain SQL function so the
// same cleanup can be run manually or via pg_cron/Supabase scheduled
// functions if preferred instead of this in-process scheduler.
//
// WIRING
//   Called from src/server.ts:  startHeliusCuLogRetentionScheduler();
// =============================================================================

import { supabaseAdmin } from "@/integrations/supabase/client.server";

const LOG            = "[HeliusCuLogRetention]";
const INTERVAL_MS     = 24 * 60 * 60 * 1000; // once a day
const RETENTION_DAYS  = 14;
const WARMUP_DELAY_MS = 60_000; // let the CU-log flush interval settle first

let running = false;

async function tick(): Promise<void> {
  if (running) {
    console.warn(`${LOG} Previous run still in progress — skipping this tick`);
    return;
  }
  running = true;

  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

    // Supabase caps DELETE result sets, so this may need a few passes on the
    // first run against a large backlog — loop until nothing more is deleted.
    let totalDeleted = 0;
    for (let pass = 0; pass < 20; pass++) {
      // NOTE: "helius_cu_log" is not yet in the generated Database type
      // (src/integrations/supabase/types.ts) — same pre-existing schema-drift
      // gap as `alerts` and `wallet_collection_jobs` elsewhere in this
      // codebase. Regenerate types after applying the accompanying migration
      // (`supabase gen types typescript`) to remove this cast.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabaseAdmin as any)
        .from("helius_cu_log")
        .delete()
        .lt("logged_at", cutoff)
        .select("id");

      if (error) {
        console.error(`${LOG} Delete failed: ${error.message}`);
        break;
      }

      const deleted = data?.length ?? 0;
      totalDeleted += deleted;
      if (deleted === 0) break;
    }

    console.log(
      `${LOG} Pruned ${totalDeleted} row(s) older than ${RETENTION_DAYS} days (cutoff=${cutoff})`,
    );
  } catch (err) {
    console.error(
      `${LOG} Unhandled error during retention run:`,
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    running = false;
  }
}

/**
 * Start the retention scheduler. Called once at server boot from src/server.ts.
 * Fires the first prune after a short warm-up delay, then repeats daily.
 * Returns a cleanup function for graceful shutdown.
 */
export function startHeliusCuLogRetentionScheduler(): () => void {
  console.log(
    `${LOG} Starting — retention: ${RETENTION_DAYS} days, interval: 24h. ` +
    `First run in ${WARMUP_DELAY_MS / 1000}s.`,
  );

  const warmup = setTimeout(() => void tick(), WARMUP_DELAY_MS);
  const handle = setInterval(tick, INTERVAL_MS);

  return () => {
    clearTimeout(warmup);
    clearInterval(handle);
    console.log(`${LOG} Scheduler stopped.`);
  };
}
