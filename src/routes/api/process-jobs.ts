// =============================================================================
// /api/process-jobs — Job recovery & stuck-job reprocessor
//
// Picks up wallet_collection_jobs stuck in "processing" for > 2 minutes (or
// "pending" for > 30 seconds) and reprocesses them.
//
// SECURITY FIX (audit SEC-03):
//   Both POST and GET now require x-cron-secret authentication.
//   The endpoint was previously completely unauthenticated.
//
// USAGE — two options:
//
// Option A: Railway Cron Job (recommended — automatic recovery every minute)
//   Go to Railway → your service → Settings → Cron Jobs → Add Cron Job
//   Schedule : * * * * *
//   Command  : curl -s -X POST https://YOUR-APP.railway.app/api/process-jobs \
//                   -H "x-cron-secret: YOUR_CRON_SECRET"
//
// Option B: Manual recovery (unstick jobs immediately)
//   curl -X POST https://YOUR-APP.railway.app/api/process-jobs \
//        -H "x-cron-secret: YOUR_CRON_SECRET"
// =============================================================================

import { createAPIFileRoute } from "@tanstack/react-start/api";
import { createClient } from "@supabase/supabase-js";
import { collect } from "@/lib/api/wallet-collection-worker";

const LOG = "[process-jobs]";

function getSupabase() {
  const url =
    process.env.SUPABASE_URL ??
    process.env.VITE_SUPABASE_URL ??
    (import.meta.env.VITE_SUPABASE_URL as string | undefined) ??
    "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_ANON_KEY ??
    "";
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Auth helper — same mechanism as /api/enrich-wallets.
// CRON_SECRET is required; missing env var locks down the endpoint entirely.
// ---------------------------------------------------------------------------
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
          "Contact the administrator to configure authentication.",
      },
      503,
    );
  }

  const incoming = request.headers.get("x-cron-secret");
  if (!incoming || incoming !== cronSecret) {
    console.warn(`${LOG} Unauthorized — bad or missing x-cron-secret`);
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  return null; // auth passed
}

// Same bulletproof updater as in trigger.functions.ts — handles missing columns
async function safeUpdateJob(
  sb: ReturnType<typeof createClient>,
  jobId: string,
  status: "done" | "failed",
  extra: Record<string, unknown> = {},
): Promise<void> {
  const completedAt = new Date().toISOString();

  // Try full update
  const { error: e1 } = await sb
    .from("wallet_collection_jobs")
    .update({ status, completed_at: completedAt, ...extra })
    .eq("id", jobId);

  if (!e1) return;

  console.error(`${LOG} [${jobId}] Full update failed (${e1.message}) — trying minimal`);

  // Fallback: just status + completed_at
  const minExtra: Record<string, unknown> = {};
  if (extra.last_error) minExtra.last_error = extra.last_error;

  const { error: e2 } = await sb
    .from("wallet_collection_jobs")
    .update({ status, completed_at: completedAt, ...minExtra })
    .eq("id", jobId);

  if (e2) {
    console.error(`${LOG} [${jobId}] Minimal update also failed: ${e2.message}`);
  }
}

export const APIRoute = createAPIFileRoute("/api/process-jobs")({
  // POST — process stuck jobs (requires auth)
  POST: async ({ request }) => {
    const authError = checkAuth(request);
    if (authError) return authError;

    const sb = getSupabase();

    if (!sb) {
      console.error(`${LOG} No Supabase client — env vars missing`);
      return json({ ok: false, error: "Supabase credentials not configured", processed: 0 });
    }

    // Pick up jobs stuck in "processing" > 2 min, or "pending" > 30 s
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
      return json({ ok: true, message: "No stuck jobs found", processed: 0 });
    }

    console.log(`${LOG} Found ${stuckJobs.length} stuck job(s) — processing`);

    const results: Array<{
      jobId: string;
      token: string;
      status: string;
      traders?: number;
      error?: string;
    }> = [];

    for (const job of stuckJobs) {
      const jobId = job.id as string;
      const token = job.token_address as string;

      try {
        // Stamp it as processing again with a fresh started_at
        await sb
          .from("wallet_collection_jobs")
          .update({
            status:     "processing",
            started_at: new Date().toISOString(),
            attempts:   (job.attempts as number ?? 0) + 1,
          })
          .eq("id", jobId);

        console.log(`${LOG} [${jobId}] running collect() for ${token}`);

        const result = await collect({
          tokenAddress:   token,
          poolAddress:    (job.pool_address as string | null) ?? null,
          marketCapUsd:   (job.market_cap_usd as number | null) ?? null,
          liquidityUsd:   (job.liquidity_usd as number | null) ?? null,
          holderCount:    (job.holder_count as number | null) ?? null,
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
          console.error(`${LOG} [${jobId}] status update failed: ${e instanceof Error ? e.message : String(e)}`),
        );

        results.push({ jobId, token, status: "failed", error: msg });
      }
    }

    return json({ ok: true, processed: results.length, results });
  },

  // GET — show pending/processing jobs (requires auth; no side effects)
  GET: async ({ request }) => {
    const authError = checkAuth(request);
    if (authError) return authError;

    const sb = getSupabase();
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
      message: "Use POST to process stuck jobs. Pending/processing jobs listed below.",
      pendingJobs: pendingJobs ?? [],
      tip:
        "Add a Railway Cron Job: schedule '* * * * *', " +
        "command 'curl -s -X POST https://YOUR-APP.railway.app/api/process-jobs " +
        "-H \"x-cron-secret: YOUR_CRON_SECRET\"'",
    });
  },
});
