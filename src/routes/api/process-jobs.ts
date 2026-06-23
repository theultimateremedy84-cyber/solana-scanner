// =============================================================================
// /api/process-jobs — Job recovery endpoint
//
// Picks up wallet_collection_jobs stuck in "processing" for > 2 minutes (or
// "pending" for > 30 seconds) and reprocesses them synchronously.
//
// USAGE — two options:
//
// Option A: Railway Cron Job (recommended — automatic recovery every minute)
//   Go to Railway → your service → Settings → Cron Jobs → Add Cron Job
//   Schedule : * * * * *
//   Command  : curl -s -X POST https://YOUR-APP.railway.app/api/process-jobs
//
// Option B: Manual recovery (unstick jobs immediately)
//   curl -X POST https://YOUR-APP.railway.app/api/process-jobs
//   — or open in browser: https://YOUR-APP.railway.app/api/process-jobs
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
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.VITE_SUPABASE_ANON_KEY ??
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    "";
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export const APIRoute = createAPIFileRoute("/api/process-jobs")({
  // POST — process stuck jobs
  POST: async () => {
    const sb = getSupabase();

    if (!sb) {
      console.error(`${LOG} No Supabase client — env vars missing`);
      return new Response(
        JSON.stringify({ ok: false, error: "Supabase credentials not configured", processed: 0 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
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
      return new Response(
        JSON.stringify({ ok: false, error: fetchError.message, processed: 0 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (!stuckJobs || stuckJobs.length === 0) {
      console.log(`${LOG} No stuck jobs found`);
      return new Response(
        JSON.stringify({ ok: true, message: "No stuck jobs found", processed: 0 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
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

        await sb
          .from("wallet_collection_jobs")
          .update({
            status:            "done",
            traders_collected: result.tradersCollected,
            buyers_collected:  result.buyersCollected,
            sellers_collected: result.sellersCollected,
            errors:            result.errors.length > 0 ? result.errors : null,
            completed_at:      new Date().toISOString(),
          })
          .eq("id", jobId);

        console.log(`${LOG} [${jobId}] done — traders=${result.tradersCollected}`);
        results.push({ jobId, token, status: "done", traders: result.tradersCollected });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${LOG} [${jobId}] failed: ${msg}`);

        await sb
          .from("wallet_collection_jobs")
          .update({ status: "failed", last_error: msg, completed_at: new Date().toISOString() })
          .eq("id", jobId)
          .catch((e: unknown) =>
            console.error(`${LOG} [${jobId}] status update failed: ${e instanceof Error ? e.message : String(e)}`),
          );

        results.push({ jobId, token, status: "failed", error: msg });
      }
    }

    return new Response(
      JSON.stringify({ ok: true, processed: results.length, results }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  },

  // GET — show pending/processing jobs (no side effects, safe for browser)
  GET: async () => {
    const sb = getSupabase();
    if (!sb) {
      return new Response(
        JSON.stringify({ ok: false, error: "Supabase credentials not configured" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    const { data: pendingJobs, error } = await sb
      .from("wallet_collection_jobs")
      .select("id, token_address, status, started_at, enqueued_at, attempts")
      .in("status", ["pending", "processing"])
      .order("enqueued_at", { ascending: true })
      .limit(20);

    if (error) {
      return new Response(
        JSON.stringify({ ok: false, error: error.message }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        ok: true,
        message: "Use POST to process stuck jobs. Pending/processing jobs listed below.",
        pendingJobs: pendingJobs ?? [],
        tip: "Add a Railway Cron Job: schedule '* * * * *', command 'curl -s -X POST https://YOUR-APP.railway.app/api/process-jobs'",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  },
});
