// =============================================================================
// process-jobs-scheduler.ts — In-process scheduler for wallet_collection_jobs
//
// WHY THIS EXISTS:
//   The original design relied on a Railway cron job (bun cron-trigger.mjs)
//   that POST-ed to /api/process-jobs over HTTPS. This created a fragile
//   4-failure-point chain:
//     1. [[deploy.cronJobs]] must be a valid Railway TOML key
//     2. RAILWAY_PUBLIC_DOMAIN must be set correctly
//     3. CRON_SECRET must be set in Railway Variables
//     4. The HTTPS self-loopback call must succeed
//
//   Any one of these failing causes all discovered jobs to stall in "pending"
//   forever with attempts=0 — exactly the observed symptom.
//
// HOW THIS FIXES IT:
//   Calls the processing logic directly inside the server process every 60s,
//   with no external HTTP call, no CRON_SECRET requirement, no RAILWAY_PUBLIC_DOMAIN.
//   Identical pattern to price-refresh-scheduler.ts.
//
//   The Railway cron job (bun cron-trigger.mjs) is kept as belt-and-suspenders:
//   if CRON_SECRET is set and the cron runs, it's a no-op (jobs are already
//   being processed by this scheduler).
//
// ENTRY POINT:
//   import { startProcessJobsScheduler } from "./lib/api/process-jobs-scheduler";
//   startProcessJobsScheduler();
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import { collect } from "./wallet-collection-worker";

const LOG        = "[ProcessJobsScheduler]";
const INTERVAL_MS = 60_000;   // run every 60 seconds
const BATCH_SIZE  = 5;         // match the HTTP handler — 5 jobs per tick

let running            = false;
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 3;

// ---------------------------------------------------------------------------
// Supabase client — resolved from env at call time
// ---------------------------------------------------------------------------

function getSupabase() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_ANON_KEY ??
    "";
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ---------------------------------------------------------------------------
// Minimal job-status updater (mirrors process-jobs-handler.ts)
// ---------------------------------------------------------------------------

async function safeUpdateJob(
  sb: ReturnType<typeof createClient>,
  jobId: string,
  status: "done" | "failed",
  extra: Record<string, unknown> = {},
): Promise<void> {
  const completedAt = new Date().toISOString();

  const { error: e1 } = await sb
    .from("wallet_collection_jobs")
    .update({ status, completed_at: completedAt, ...extra })
    .eq("id", jobId);

  if (!e1) return;

  // Fallback: minimal update
  const minExtra: Record<string, unknown> = {};
  if (extra.last_error) minExtra.last_error = extra.last_error;
  const { error: e2 } = await sb
    .from("wallet_collection_jobs")
    .update({ status, completed_at: completedAt, ...minExtra })
    .eq("id", jobId);

  if (e2) {
    console.error(`${LOG} Status update failed for job ${jobId}: ${e2.message}`);
  }
}

// ---------------------------------------------------------------------------
// Core tick — picks up pending/stuck jobs and runs collect()
// ---------------------------------------------------------------------------

async function tick(): Promise<void> {
  if (running) {
    console.warn(`${LOG} Previous tick still running — skipping`);
    return;
  }

  const sb = getSupabase();
  if (!sb) {
    console.warn(`${LOG} Supabase credentials not configured — skipping tick`);
    return;
  }

  running = true;

  try {
    const stuckCutoff   = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const pendingCutoff = new Date(Date.now() - 30 * 1000).toISOString();

    const { data: jobs, error: fetchError } = await sb
      .from("wallet_collection_jobs")
      .select("*")
      .or(
        `and(status.eq.processing,started_at.lt.${stuckCutoff}),` +
        `and(status.eq.pending,enqueued_at.lt.${pendingCutoff})`,
      )
      .order("enqueued_at", { ascending: true })
      .limit(BATCH_SIZE);

    if (fetchError) {
      throw new Error(`DB fetch failed: ${fetchError.message}`);
    }

    if (!jobs || jobs.length === 0) {
      consecutiveFailures = 0;
      return; // nothing to do
    }

    console.log(`${LOG} Found ${jobs.length} job(s) to process`);

    for (const job of jobs) {
      const jobId = job.id as string;
      const token = job.token_address as string;

      try {
        // Mark as processing before calling collect()
        await sb
          .from("wallet_collection_jobs")
          .update({
            status:     "processing",
            started_at: new Date().toISOString(),
            attempts:   ((job.attempts as number) ?? 0) + 1,
          })
          .eq("id", jobId);

        console.log(`${LOG} [${jobId}] Running collect() for ${token}`);

        const result = await collect({
          tokenAddress:   token,
          poolAddress:    (job.pool_address as string | null) ?? null,
          marketCapUsd:   (job.market_cap_usd as number | null) ?? null,
          liquidityUsd:   (job.liquidity_usd as number | null) ?? null,
          holderCount:    (job.holder_count as number | null) ?? null,
          tokenCreatedAt: null,
          enqueuedAt:     job.enqueued_at as string,
          attempts:       ((job.attempts as number) ?? 0) + 1,
        });

        await safeUpdateJob(sb, jobId, "done", {
          traders_collected: result.tradersCollected,
          buyers_collected:  result.buyersCollected,
          sellers_collected: result.sellersCollected,
          errors:            result.errors.length > 0 ? result.errors : null,
        });

        console.log(
          `${LOG} [${jobId}] Done — traders=${result.tradersCollected} ` +
          `buyers=${result.buyersCollected} sellers=${result.sellersCollected}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${LOG} [${jobId}] Failed: ${msg}`);
        await safeUpdateJob(sb, jobId, "failed", { last_error: msg }).catch(() => {});
      }
    }

    consecutiveFailures = 0;
  } catch (err) {
    consecutiveFailures++;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `${LOG} Tick error: ${msg} (consecutive failures: ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
    );

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.error(
        `${LOG} ‼ CRITICAL: ${consecutiveFailures} consecutive failures. ` +
        "Check Supabase connectivity and SUPABASE_SERVICE_ROLE_KEY.",
      );
    }
  } finally {
    running = false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the in-process job scheduler. Called once at server boot from server.ts.
 * Fires an immediate first run, then repeats every 60 seconds.
 * Returns a cleanup function for graceful shutdown.
 */
export function startProcessJobsScheduler(): () => void {
  console.log(
    `${LOG} Starting — interval: ${INTERVAL_MS / 1000}s. Running first tick immediately.`,
  );

  // Immediate first run
  void tick();

  const handle = setInterval(tick, INTERVAL_MS);

  return () => {
    clearInterval(handle);
    console.log(`${LOG} Scheduler stopped.`);
  };
}
