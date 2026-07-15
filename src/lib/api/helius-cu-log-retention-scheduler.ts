// =============================================================================
// helius-cu-log-retention-scheduler.ts
//
// Daily retention/pruning scheduler. Two cleanup targets run in the same tick:
//
//   1. helius_cu_log  — operational CU telemetry. Rows older than 14 days are
//      deleted. Even a plain COUNT(*) times out after ~3 days of accumulation.
//
//   2. wallet_raw_tx_metrics (tombstones)  — Phase 3 Task 7.
//      Rows with has_evidence = false are "tombstones": wallets that were
//      checked by Helius and had zero Pump.fun activity. They have no scoring
//      value but consume 66%+ of the WRM table and block re-enrichment.
//      Tombstones older than WRM_TOMBSTONE_RETENTION_DAYS are deleted daily.
//      If a wallet is re-discovered later it is re-enriched fresh.
//      Index: idx_wrm_evidence_created (added in migration below) makes the
//      DELETE a fast index scan rather than a full-table sequential scan.
//
// WIRING
//   Called from src/server.ts:  startHeliusCuLogRetentionScheduler();
// =============================================================================

import { supabaseAdmin } from "@/integrations/supabase/client.server";

const LOG = "[HeliusCuLogRetention]";

// ── Tuning constants ──────────────────────────────────────────────────────────
const INTERVAL_MS                   = 24 * 60 * 60 * 1000; // once a day
const WARMUP_DELAY_MS               = 60_000;               // let CU-log flush settle first
const CU_LOG_RETENTION_DAYS         = 14;
const WRM_TOMBSTONE_RETENTION_DAYS  = 14; // tombstones older than 14d have no re-enrichment value

let running = false;

// ---------------------------------------------------------------------------
// Target 1: helius_cu_log
// ---------------------------------------------------------------------------

async function pruneHeliusCuLog(): Promise<number> {
  const cutoff = new Date(
    Date.now() - CU_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  // Supabase caps DELETE result sets — loop until nothing more is deleted.
  let totalDeleted = 0;
  for (let pass = 0; pass < 20; pass++) {
    const { data, error } = await supabaseAdmin
      .from("helius_cu_log")
      .delete()
      .lt("logged_at", cutoff)
      .select("id");

    if (error) {
      console.error(`${LOG} [cu_log] Delete pass ${pass + 1} failed: ${error.message}`);
      break;
    }

    const deleted = data?.length ?? 0;
    totalDeleted += deleted;
    if (deleted === 0) break;
  }

  return totalDeleted;
}

// ---------------------------------------------------------------------------
// Target 2: wallet_raw_tx_metrics tombstones  (Task 7 — Phase 3)
// ---------------------------------------------------------------------------

async function pruneWrmTombstones(): Promise<number> {
  const cutoff = new Date(
    Date.now() - WRM_TOMBSTONE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  // Tombstone rows: has_evidence = false, created_at older than cutoff.
  // Loop to handle Supabase DELETE row-count cap.
  let totalDeleted = 0;
  for (let pass = 0; pass < 50; pass++) {
    const { data, error } = await supabaseAdmin
      .from("wallet_raw_tx_metrics")
      .delete()
      .eq("has_evidence", false)
      .lt("created_at", cutoff)
      .select("wallet_address");

    if (error) {
      console.error(`${LOG} [wrm_tombstones] Delete pass ${pass + 1} failed: ${error.message}`);
      break;
    }

    const deleted = data?.length ?? 0;
    totalDeleted += deleted;
    if (deleted === 0) break;
  }

  return totalDeleted;
}

// ---------------------------------------------------------------------------
// Main tick
// ---------------------------------------------------------------------------

async function tick(): Promise<void> {
  if (running) {
    console.warn(`${LOG} Previous run still in progress — skipping this tick`);
    return;
  }
  running = true;

  try {
    // Run both cleanup targets; log results independently so one failure
    // doesn't hide the other's output.
    const [cuDeleted, wrmDeleted] = await Promise.all([
      pruneHeliusCuLog().catch((err: unknown) => {
        console.error(`${LOG} [cu_log] Unhandled error:`, err instanceof Error ? err.message : String(err));
        return 0;
      }),
      pruneWrmTombstones().catch((err: unknown) => {
        console.error(`${LOG} [wrm_tombstones] Unhandled error:`, err instanceof Error ? err.message : String(err));
        return 0;
      }),
    ]);

    console.log(
      `${LOG} Daily cleanup complete — ` +
      `cu_log: ${cuDeleted} row(s) pruned (>${CU_LOG_RETENTION_DAYS}d), ` +
      `wrm_tombstones: ${wrmDeleted} row(s) pruned (>${WRM_TOMBSTONE_RETENTION_DAYS}d)`,
    );
  } finally {
    running = false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the retention scheduler. Called once at server boot from src/server.ts.
 * Fires the first prune after a short warm-up delay, then repeats daily.
 * Returns a cleanup function for graceful shutdown.
 */
export function startHeliusCuLogRetentionScheduler(): () => void {
  console.log(
    `${LOG} Starting — ` +
    `cu_log retention: ${CU_LOG_RETENTION_DAYS}d, ` +
    `wrm_tombstone retention: ${WRM_TOMBSTONE_RETENTION_DAYS}d, ` +
    `interval: 24h. First run in ${WARMUP_DELAY_MS / 1000}s.`,
  );

  const warmup = setTimeout(() => void tick(), WARMUP_DELAY_MS);
  const handle = setInterval(tick, INTERVAL_MS);

  return () => {
    clearTimeout(warmup);
    clearInterval(handle);
    console.log(`${LOG} Scheduler stopped.`);
  };
}
