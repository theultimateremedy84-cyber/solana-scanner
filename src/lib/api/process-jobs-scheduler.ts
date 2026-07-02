// =============================================================================
// process-jobs-scheduler.ts — In-process scheduler for wallet_collection_jobs
//
// PATCH v2 — fixes the root cause of 51 jobs stuck at pending/attempts=0
//
// ROOT CAUSE (diagnosed):
//   The original `running` lock covered BOTH the fast DB stamp phase AND the
//   slow collect() phase (3–50 minutes per batch of 5 jobs). Every 60-second
//   tick after the first hit `running = true` and returned immediately, leaving
//   all subsequent pending jobs permanently untouched (attempts = 0).
//
// FIXES in this version:
//   1.  LOCK SCOPE — `running` now covers ONLY the fast DB phase (fetch + stamp
//       jobs as "processing"). collect() runs OUTSIDE the lock so the next tick
//       can immediately pick up the next batch.
//
//   2.  CONCURRENCY CAP — `inFlightCount` tracks active collect() calls.
//       MAX_CONCURRENT = 3 prevents runaway parallelism while still processing
//       multiple tokens simultaneously.
//
//   3.  OPTIMISTIC STAMP — The UPDATE that marks a job "processing" now also
//       filters on the job's CURRENT status (.eq("status", job.status)) to
//       prevent double-processing in edge cases. The error is now CHECKED and
//       logged — previously it was silently discarded.
//
//   4.  BATCH_SIZE raised 5 → 10 — with concurrent collect() calls the old
//       limit of 5 was too conservative.
//
//   5.  DIAGNOSTICS — getSchedulerStats() is exported so the
//       /api/discovery-status handler can surface live scheduler state.
//
// ENTRY POINT (unchanged):
//   import { startProcessJobsScheduler } from "./lib/api/process-jobs-scheduler";
//   startProcessJobsScheduler();   // called once in server.ts at boot
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { collect } from "./wallet-collection-worker";

const LOG          = "[ProcessJobsScheduler]";
const INTERVAL_MS  = 60_000;   // tick every 60 s
const BATCH_SIZE   = 10;        // jobs to stamp per tick (raised from 5)
const MAX_CONCURRENT = 3;       // max simultaneous collect() calls in flight

// Module-level state
let stampRunning       = false;   // true only during the fast DB stamp phase
let inFlightCount      = 0;       // number of collect() calls currently running
let totalProcessed     = 0;       // cumulative jobs completed this session
let totalFailed        = 0;       // cumulative jobs failed this session
let consecutiveTickErr = 0;       // tick-level (non-job) errors in a row
const MAX_TICK_ERRORS  = 5;

// ---------------------------------------------------------------------------
// Supabase client
// ---------------------------------------------------------------------------

// getSupabase() consolidated → supabaseAdmin from client.server

// ---------------------------------------------------------------------------
// Job-status updater (same bulletproof pattern as all other handlers)
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

  console.error(`${LOG} [${jobId}] Full update failed (${e1.message}) — trying minimal`);

  const minExtra: Record<string, unknown> = {};
  if (extra.last_error) minExtra.last_error = extra.last_error;

  const { error: e2 } = await sb
    .from("wallet_collection_jobs")
    .update({ status, completed_at: completedAt, ...minExtra })
    .eq("id", jobId);

  if (e2) {
    console.error(
      `${LOG} [${jobId}] Minimal update also failed: ${e2.message}. ` +
      "Check SUPABASE_SERVICE_ROLE_KEY is set in Railway → Variables and that " +
      "migration 20260627000001 has been applied (RLS hardening).",
    );
  }
}

// ---------------------------------------------------------------------------
// FIX #1 — runJobBackground
//
// Runs collect() for a single job OUTSIDE the stamp lock so the scheduler
// can immediately pick up new batches without waiting for collect() to finish.
// ---------------------------------------------------------------------------

async function runJobBackground(
  sb: ReturnType<typeof createClient>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  job: Record<string, any>,
): Promise<void> {
  const jobId = job.id as string;
  const token = job.token_address as string;

  try {
    console.log(`${LOG} [${jobId}] collect() START — token=${token.slice(0, 8)}…`);

    const result = await collect({
      tokenAddress:   token,
      poolAddress:    (job.pool_address as string | null)  ?? null,
      marketCapUsd:   (job.market_cap_usd as number | null) ?? null,
      liquidityUsd:   (job.liquidity_usd  as number | null) ?? null,
      holderCount:    (job.holder_count   as number | null) ?? null,
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

    totalProcessed++;
    console.log(
      `${LOG} [${jobId}] DONE — traders=${result.tradersCollected} ` +
      `buyers=${result.buyersCollected} sellers=${result.sellersCollected} ` +
      `(session total: ${totalProcessed})`,
    );
  } catch (err) {
    totalFailed++;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${LOG} [${jobId}] FAILED: ${msg}`);
    await safeUpdateJob(sb, jobId, "failed", { last_error: msg }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// FIX #2 — tick()
//
// The lock now covers ONLY the fast DB stamp phase (milliseconds).
// collect() is fired as a detached promise outside the lock.
// ---------------------------------------------------------------------------

async function tick(): Promise<void> {
  // Guard 1: stamp phase must not overlap
  if (stampRunning) {
    console.warn(`${LOG} Stamp phase still running — skipping tick`);
    return;
  }

  // Guard 2: respect the concurrency cap
  if (inFlightCount >= MAX_CONCURRENT) {
    console.log(
      `${LOG} Concurrency cap reached (${inFlightCount}/${MAX_CONCURRENT} in flight) — skipping tick`,
    );
    return;
  }

  const sb = supabaseAdmin;

  stampRunning = true;

  try {
    const stuckCutoff   = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const pendingCutoff = new Date(Date.now() - 30 * 1000).toISOString();

    // Fetch pending/stuck jobs — limit to what capacity allows
    const available = MAX_CONCURRENT - inFlightCount;
    const limit     = Math.min(BATCH_SIZE, available);

    const { data: jobs, error: fetchError } = await sb
      .from("wallet_collection_jobs")
      .select("*")
      .or(
        `and(status.eq.processing,started_at.lt.${stuckCutoff}),` +
        `and(status.eq.pending,enqueued_at.lt.${pendingCutoff})`,
      )
      .order("enqueued_at", { ascending: true })
      .limit(limit);

    if (fetchError) {
      throw new Error(`DB fetch failed: ${fetchError.message}`);
    }

    if (!jobs || jobs.length === 0) {
      consecutiveTickErr = 0;
      return;
    }

    console.log(`${LOG} Found ${jobs.length} job(s) — stamping as processing`);

    // FIX #3 — stamp jobs as "processing" with CHECKED error + optimistic lock
    const toProcess: typeof jobs = [];

    for (const job of jobs) {
      const jobId = job.id as string;

      const { error: stampErr } = await sb
        .from("wallet_collection_jobs")
        .update({
          status:     "processing",
          started_at: new Date().toISOString(),
          attempts:   ((job.attempts as number) ?? 0) + 1,
        })
        .eq("id", jobId)
        .eq("status", job.status as string); // optimistic: only stamp if status unchanged

      if (stampErr) {
        // This is the previously silent failure that kept attempts=0 forever.
        console.error(
          `${LOG} [${jobId}] STAMP FAILED: ${stampErr.message}. ` +
          "Likely cause: SUPABASE_SERVICE_ROLE_KEY not set, or RLS migration " +
          "20260627000001 applied but anon key is in use.",
        );
        // Do NOT add to toProcess — skip this job for this tick
      } else {
        toProcess.push(job);
      }
    }

    consecutiveTickErr = 0;

    if (toProcess.length === 0) return;

    console.log(
      `${LOG} Stamped ${toProcess.length} job(s) — launching collect() outside lock ` +
      `(in-flight before: ${inFlightCount})`,
    );

    // FIX #1 — fire collect() OUTSIDE the stamp lock so subsequent ticks aren't blocked
    for (const job of toProcess) {
      inFlightCount++;
      runJobBackground(sb, job).finally(() => {
        inFlightCount--;
      });
    }
  } catch (err) {
    consecutiveTickErr++;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `${LOG} Tick error (${consecutiveTickErr}/${MAX_TICK_ERRORS}): ${msg}`,
    );

    if (consecutiveTickErr >= MAX_TICK_ERRORS) {
      console.error(
        `${LOG} ‼ CRITICAL: ${consecutiveTickErr} consecutive tick errors. ` +
        "Check SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and Supabase connectivity.",
      );
    }
  } finally {
    stampRunning = false; // always release immediately after the DB stamp phase
  }
}

// ---------------------------------------------------------------------------
// Diagnostics — exported for /api/discovery-status
// ---------------------------------------------------------------------------

export function getSchedulerStats() {
  return {
    stampRunning,
    inFlightCount,
    totalProcessed,
    totalFailed,
    consecutiveTickErr,
    intervalMs:    INTERVAL_MS,
    batchSize:     BATCH_SIZE,
    maxConcurrent: MAX_CONCURRENT,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the in-process job scheduler. Called once at server boot from server.ts.
 * Fires an immediate first tick, then repeats every 60 seconds.
 * Returns a cleanup function for graceful shutdown.
 */
export function startProcessJobsScheduler(): () => void {
  console.log(
    `${LOG} Starting — interval: ${INTERVAL_MS / 1000}s, ` +
    `batch: ${BATCH_SIZE}, maxConcurrent: ${MAX_CONCURRENT}. ` +
    "Running first tick immediately.",
  );

  void tick();

  const handle = setInterval(tick, INTERVAL_MS);

  return () => {
    clearInterval(handle);
    console.log(
      `${LOG} Scheduler stopped. ` +
      `Session totals: processed=${totalProcessed} failed=${totalFailed}`,
    );
  };
}
