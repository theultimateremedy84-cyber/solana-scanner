// =============================================================================
// process-jobs-handler.ts — Direct handler for /api/process-jobs
//
// PATCH v3 — done-but-hollow self-heal + budget-exhausted requeue
//
// WHY THIS EXISTS:
//   createAPIFileRoute (@tanstack/react-start/api) does not register handlers
//   when using the node-server Nitro preset on Railway. The handler in
//   src/routes/api/process-jobs.ts is therefore unreachable via Railway cron.
//   This module exports plain functions that server.ts intercepts directly.
//
// FIXES in v2:
//   1.  The UPDATE that marks a job "processing" now CHECKS stampErr and logs
//       loudly if it fails — previously the error was silently discarded,
//       causing jobs to stay at pending/attempts=0 forever while collect()
//       ran with no record of the attempt.
//   2.  Optimistic lock: the UPDATE also filters on .eq("status", job.status)
//       so a job that was concurrently stamped by the in-process scheduler
//       is not double-processed.
//   3.  Supabase key diagnostics on every request — surfaced in response body
//       so Railway log tailing immediately shows the misconfiguration.
//
// FIXES in v3 (self-heal):
//   4.  Budget-exhausted requeue — when collect() returns 0 traders because
//       the hourly Helius CU budget was exhausted, the job is reset to
//       "pending" instead of being marked "done". Capped at
//       MAX_BUDGET_REQUEUE_ATTEMPTS to prevent infinite churn on persistently
//       low budgets. Jobs that exceed the cap are marked "failed" with a clear
//       message so operators can investigate.
//
//   5.  Done-but-hollow scan — a second pass runs after the stuck-job loop.
//       It queries recently completed "done" jobs where traders_collected = 0
//       AND no wallet_raw_tx_metrics rows exist for that token. These are jobs
//       that succeeded technically (no exception) but produced empty data —
//       the classic "hollow done" state from the original RLS-rejection bug or
//       from DexScreener/Helius timeouts. They are reset to "pending" so the
//       next scheduler cycle can retry them.
//       Guard: only jobs that HAD a pool_address are requeued — jobs with no
//       pool_address had no pool to scan and will always produce 0 traders;
//       re-queuing them is pointless and would cause infinite churn.
//       Capped at MAX_HOLLOW_REQUEUE per call and MAX_HOLLOW_ATTEMPTS total.
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { collect } from "./wallet-collection-worker";

const LOG = "[process-jobs]";

/** Max times a budget-exhausted job will be reset to pending before giving up. */
const MAX_BUDGET_REQUEUE_ATTEMPTS = 5;

/** Max hollow-done jobs requeued per handler call (flood guard). */
const MAX_HOLLOW_REQUEUE  = 10;

/** Max total attempts before a hollow job is abandoned (left as done). */
const MAX_HOLLOW_ATTEMPTS = 3;

/** How many hours back the hollow scan looks. */
const HOLLOW_LOOKBACK_H   = 72;

// getSupabase() consolidated → supabaseAdmin (always service_role)
function getSupabase() {
  return { client: supabaseAdmin, keyType: "service_role" as const };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function checkAuth(request: Request): Response | null {
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    console.error(
      `${LOG} CRON_SECRET env var is not set — all requests rejected. ` +
      "Set it in Railway → Variables before using this endpoint.",
    );
    return json(
      {
        ok: false,
        error:
          "Service misconfigured: CRON_SECRET is not set. " +
          "Set it in Railway → Variables.",
      },
      503,
    );
  }

  const incoming = request.headers.get("x-cron-secret");
  if (!incoming || incoming !== cronSecret) {
    console.warn(`${LOG} Unauthorized — bad or missing x-cron-secret`);
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  return null;
}

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
      "Verify SUPABASE_SERVICE_ROLE_KEY is set and migration 20260627000001 is applied.",
    );
  }
}

// ---------------------------------------------------------------------------
// FIX v3-4: Budget-exhausted requeue — with attempt cap
//
// Resets a job to "pending" when collect() bailed out because the hourly
// Helius CU window was exhausted. Enforces MAX_BUDGET_REQUEUE_ATTEMPTS so a
// persistently under-budgeted deployment cannot spin jobs forever.
// ---------------------------------------------------------------------------

async function requeueBudgetExhaustedJob(
  sb:              ReturnType<typeof createClient>,
  jobId:           string,
  currentAttempts: number,
  errMsg:          string,
): Promise<"requeued" | "abandoned"> {
  if (currentAttempts >= MAX_BUDGET_REQUEUE_ATTEMPTS) {
    // Cap reached — mark failed so operators know to raise HELIUS_HOURLY_BUDGET.
    console.warn(
      `${LOG} [${jobId}] budget-exhausted cap reached (${currentAttempts}/${MAX_BUDGET_REQUEUE_ATTEMPTS}). ` +
      "Marking failed. Raise HELIUS_HOURLY_BUDGET in Railway Variables to prevent this.",
    );
    await safeUpdateJob(sb, jobId, "failed", {
      last_error: `budget_exhausted_cap_reached after ${currentAttempts} attempts — raise HELIUS_HOURLY_BUDGET`,
    });
    return "abandoned";
  }

  const { error } = await sb
    .from("wallet_collection_jobs")
    .update({
      status:     "pending",
      started_at: null,
      last_error: `${errMsg} (requeue ${currentAttempts + 1}/${MAX_BUDGET_REQUEUE_ATTEMPTS})`,
    })
    .eq("id", jobId);

  if (error) {
    console.error(`${LOG} [${jobId}] requeue-pending failed: ${error.message}`);
    return "abandoned";
  }

  console.log(
    `${LOG} [${jobId}] reset to pending — budget exhausted ` +
    `(attempt ${currentAttempts + 1}/${MAX_BUDGET_REQUEUE_ATTEMPTS}), will retry next window`,
  );
  return "requeued";
}

// ---------------------------------------------------------------------------
// FIX v3-5: Done-but-hollow scan — with pool_address guard + attempt cap
//
// Finds "done" jobs with traders_collected = 0 that have no corresponding
// wallet_raw_tx_metrics rows, then resets them to "pending" for retry.
//
// Guard: only tokens that had a pool_address are re-queued. Jobs with
// pool_address = null had no pool to scan and will always produce 0 traders
// legitimately — re-queuing them would cause infinite churn.
// ---------------------------------------------------------------------------

async function requeueHollowDoneJobs(
  sb: ReturnType<typeof createClient>,
): Promise<{ requeued: number; checked: number; abandoned: number }> {
  const cutoff = new Date(Date.now() - HOLLOW_LOOKBACK_H * 3_600_000).toISOString();

  // Step 1: find done jobs with 0 traders in the lookback window.
  // Only fetch jobs that had a pool_address — without one there is no way
  // to scan pool transactions, so 0 traders is the expected outcome.
  const { data: candidates, error: fetchErr } = await sb
    .from("wallet_collection_jobs")
    .select("id, token_address, pool_address, completed_at, attempts")
    .eq("status", "done")
    .eq("traders_collected", 0)
    .not("pool_address", "is", null)       // guard: skip no-pool-address jobs
    .gte("completed_at", cutoff)
    .order("completed_at", { ascending: true })
    .limit(MAX_HOLLOW_REQUEUE * 3);        // over-fetch so we can filter below

  if (fetchErr || !candidates?.length) {
    if (fetchErr) {
      console.warn(`${LOG} hollow-scan fetch error: ${fetchErr.message}`);
    }
    return { requeued: 0, checked: 0, abandoned: 0 };
  }

  let requeued  = 0;
  let abandoned = 0;

  for (const job of candidates) {
    if (requeued >= MAX_HOLLOW_REQUEUE) break;

    const jobId = job.id as string;
    const token = job.token_address as string;

    // Step 2: verify no metrics rows exist for this token (not just this job).
    // If rows exist from a different job run, this token isn't hollow — leave it.
    const { count, error: countErr } = await sb
      .from("wallet_raw_tx_metrics")
      .select("wallet_address", { count: "exact", head: true })
      .eq("token_address", token);

    if (countErr) {
      console.warn(`${LOG} [${jobId}] hollow-check error: ${countErr.message}`);
      continue;
    }

    if ((count ?? 0) > 0) {
      // Data exists for this token from another run — not hollow. Leave done.
      continue;
    }

    // Step 3: apply attempt cap
    const currentAttempts = (job.attempts as number) ?? 0;
    if (currentAttempts >= MAX_HOLLOW_ATTEMPTS) {
      console.warn(
        `${LOG} [${jobId}] hollow job has ${currentAttempts} attempts — ` +
        `leaving as done (cap ${MAX_HOLLOW_ATTEMPTS} reached). Manual investigation needed.`,
      );
      abandoned++;
      continue;
    }

    // Step 4: reset to pending
    const { error: resetErr } = await sb
      .from("wallet_collection_jobs")
      .update({
        status:     "pending",
        started_at: null,
        last_error: `hollow-done requeue (attempt ${currentAttempts + 1}/${MAX_HOLLOW_ATTEMPTS}) — 0 traders, 0 metrics rows`,
      })
      .eq("id", jobId)
      .eq("status", "done"); // optimistic guard — don't race with another handler

    if (resetErr) {
      console.error(`${LOG} [${jobId}] hollow requeue failed: ${resetErr.message}`);
    } else {
      console.log(
        `${LOG} [${jobId}] hollow done → pending ` +
        `(token=${token.slice(0, 8)}… attempt ${currentAttempts + 1}/${MAX_HOLLOW_ATTEMPTS})`,
      );
      requeued++;
    }
  }

  return { requeued, checked: candidates.length, abandoned };
}

// ---------------------------------------------------------------------------
// POST handler — process stuck + pending jobs
// ---------------------------------------------------------------------------

export async function handleProcessJobsPost(request: Request): Promise<Response> {
  const authError = checkAuth(request);
  if (authError) return authError;

  const { client: sb, keyType } = getSupabase();

  if (!sb) {
    console.error(`${LOG} No Supabase client — env vars missing`);
    return json({ ok: false, error: "Supabase credentials not configured", processed: 0 });
  }

  const stuckCutoff   = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const pendingCutoff = new Date(Date.now() - 30 * 1000).toISOString();

  const { data: stuckJobs, error: fetchError } = await sb
    .from("wallet_collection_jobs")
    .select("*")
    .or(
      `and(status.eq.processing,started_at.lt.${stuckCutoff}),` +
      `and(status.eq.pending,enqueued_at.lt.${pendingCutoff})`,
    )
    .order("enqueued_at", { ascending: true })
    .limit(5);

  if (fetchError) {
    console.error(`${LOG} fetch error: ${fetchError.message}`);
    return json({ ok: false, error: fetchError.message, processed: 0 });
  }

  const results: Array<{
    jobId: string;
    token: string;
    status: string;
    traders?: number;
    error?: string;
    stampError?: string;
  }> = [];

  if (!stuckJobs || stuckJobs.length === 0) {
    console.log(`${LOG} No stuck jobs found — running hollow-done scan`);
  } else {
    console.log(`${LOG} Found ${stuckJobs.length} stuck job(s) — processing (key: ${keyType})`);

    for (const job of stuckJobs) {
      const jobId = job.id as string;
      const token = job.token_address as string;

      // FIX v2: check stamp UPDATE error — previously silently discarded
      const { error: stampErr } = await sb
        .from("wallet_collection_jobs")
        .update({
          status:     "processing",
          started_at: new Date().toISOString(),
          attempts:   (job.attempts as number ?? 0) + 1,
        })
        .eq("id", jobId)
        .eq("status", job.status as string); // optimistic lock

      if (stampErr) {
        console.error(
          `${LOG} [${jobId}] STAMP FAILED (${stampErr.message}). ` +
          "Likely RLS rejection — ensure SUPABASE_SERVICE_ROLE_KEY is set. Skipping collect().",
        );
        results.push({ jobId, token, status: "stamp_failed", stampError: stampErr.message });
        continue;
      }

      try {
        console.log(`${LOG} [${jobId}] running collect() for ${token.slice(0, 8)}…`);

        const result = await collect({
          tokenAddress:   token,
          poolAddress:    (job.pool_address as string | null)  ?? null,
          marketCapUsd:   (job.market_cap_usd as number | null) ?? null,
          liquidityUsd:   (job.liquidity_usd  as number | null) ?? null,
          holderCount:    (job.holder_count   as number | null) ?? null,
          tokenCreatedAt: null,
          enqueuedAt:     job.enqueued_at as string,
          attempts:       (job.attempts as number ?? 0) + 1,
        });

        // ── FIX v3-4: budget-exhausted requeue (with attempt cap) ──────────
        const budgetExhausted = result.errors.some(
          (e) => e.includes("hourly_budget_exhausted"),
        );

        if (result.tradersCollected === 0 && budgetExhausted) {
          const errMsg = result.errors.find((e) => e.includes("hourly_budget_exhausted"))
            ?? "hourly_budget_exhausted";
          const currentAttempts = (job.attempts as number ?? 0) + 1; // already incremented by stamp
          const outcome = await requeueBudgetExhaustedJob(sb, jobId, currentAttempts, errMsg);
          results.push({ jobId, token, status: `budget_exhausted_${outcome}`, error: errMsg });
          continue;
        }
        // ── end FIX v3-4 ───────────────────────────────────────────────────

        await safeUpdateJob(sb, jobId, "done", {
          traders_collected: result.tradersCollected,
          buyers_collected:  result.buyersCollected,
          sellers_collected: result.sellersCollected,
          errors:            result.errors.length > 0 ? result.errors : null,
        });

        console.log(`${LOG} [${jobId}] done — traders=${result.tradersCollected}`);
        results.push({ jobId, token, status: "done", traders: result.tradersCollected });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${LOG} [${jobId}] failed: ${msg}`);

        await safeUpdateJob(sb, jobId, "failed", { last_error: msg }).catch((e: unknown) =>
          console.error(
            `${LOG} [${jobId}] status update failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );

        results.push({ jobId, token, status: "failed", error: msg });
      }
    }
  }

  // ── FIX v3-5: done-but-hollow scan ───────────────────────────────────────
  const hollowResult = await requeueHollowDoneJobs(sb);
  if (hollowResult.requeued > 0 || hollowResult.abandoned > 0) {
    console.log(
      `${LOG} hollow-scan: requeued=${hollowResult.requeued} ` +
      `abandoned=${hollowResult.abandoned} checked=${hollowResult.checked}`,
    );
  } else {
    console.log(`${LOG} hollow-scan: ${hollowResult.checked} checked, none hollow`);
  }
  // ── end FIX v3-5 ─────────────────────────────────────────────────────────

  return json({
    ok:        true,
    processed: results.length,
    keyType,
    results,
    hollowScan: hollowResult,
  });
}

// ---------------------------------------------------------------------------
// GET handler — status / usage info
// ---------------------------------------------------------------------------

export async function handleProcessJobsGet(request: Request): Promise<Response> {
  const authError = checkAuth(request);
  if (authError) return authError;

  const { client: sb, keyType } = getSupabase();
  if (!sb) {
    return json({ ok: false, error: "Supabase credentials not configured" });
  }

  const { data: pendingJobs, error } = await sb
    .from("wallet_collection_jobs")
    .select("id, token_address, status, started_at, enqueued_at, attempts")
    .in("status", ["pending", "processing"])
    .order("enqueued_at", { ascending: true })
    .limit(20);

  if (error) {
    return json({ ok: false, error: error.message });
  }

  return json({
    ok: true,
    keyType,
    message: "Use POST to process stuck jobs. Pending/processing jobs listed below.",
    pendingJobs: pendingJobs ?? [],
    tip:
      "If keyType is 'anon', set SUPABASE_SERVICE_ROLE_KEY in Railway → Variables. " +
      "Without it, all UPDATEs are rejected by RLS after migration 20260627000001.",
  });
}
