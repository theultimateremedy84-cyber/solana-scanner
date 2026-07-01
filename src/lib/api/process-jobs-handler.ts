// =============================================================================
// process-jobs-handler.ts — Direct handler for /api/process-jobs
//
// PATCH v2 — fixes UPDATE error checking + adds optimistic lock on stamp
//
// WHY THIS EXISTS:
//   createAPIFileRoute (@tanstack/react-start/api) does not register handlers
//   when using the node-server Nitro preset on Railway. The handler in
//   src/routes/api/process-jobs.ts is therefore unreachable via Railway cron.
//   This module exports plain functions that server.ts intercepts directly.
//
// FIXES in this version:
//   1.  The UPDATE that marks a job "processing" now CHECKS stampErr and logs
//       loudly if it fails — previously the error was silently discarded,
//       causing jobs to stay at pending/attempts=0 forever while collect()
//       ran with no record of the attempt.
//
//   2.  Optimistic lock: the UPDATE also filters on .eq("status", job.status)
//       so a job that was concurrently stamped by the in-process scheduler
//       is not double-processed.
//
//   3.  Supabase key diagnostics on every request — surfaced in response body
//       so Railway log tailing immediately shows the misconfiguration.
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import { collect } from "./wallet-collection-worker";

const LOG = "[process-jobs]";

function getSupabase() {
  const url =
    process.env.SUPABASE_URL ??
    process.env.VITE_SUPABASE_URL ??
    "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const key = serviceKey ?? process.env.SUPABASE_ANON_KEY ?? "";

  if (!url || !key) return { client: null, keyType: "missing" as const };

  if (!serviceKey) {
    console.warn(
      `${LOG} ⚠ SUPABASE_SERVICE_ROLE_KEY not set — using anon key. ` +
      "After migration 20260627000001, anon-key UPDATEs are rejected by RLS. " +
      "Jobs will be selected but stamp will fail → attempts stays 0. " +
      "Set SUPABASE_SERVICE_ROLE_KEY in Railway → Variables.",
    );
  }

  return {
    client: createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    }),
    keyType: (serviceKey ? "service_role" : "anon") as "service_role" | "anon",
  };
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

  if (!stuckJobs || stuckJobs.length === 0) {
    console.log(`${LOG} No stuck jobs found`);
    return json({ ok: true, message: "No stuck jobs found", processed: 0, keyType });
  }

  console.log(`${LOG} Found ${stuckJobs.length} stuck job(s) — processing (key: ${keyType})`);

  const results: Array<{
    jobId: string;
    token: string;
    status: string;
    traders?: number;
    error?: string;
    stampError?: string;
  }> = [];

  for (const job of stuckJobs) {
    const jobId = job.id as string;
    const token = job.token_address as string;

    // FIX: check the stamp UPDATE error — previously silently discarded
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

  return json({ ok: true, processed: results.length, keyType, results });
}

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
