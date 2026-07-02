// =============================================================================
// /api/process-jobs — Job recovery & stuck-job reprocessor  (route file)
//
// PATCH v2 — adds stamp-error checking and optimistic lock
//
// NOTE: On the Railway node-server Nitro preset, createAPIFileRoute handlers
// are NOT registered automatically. The actual production handler is
// src/lib/api/process-jobs-handler.ts, intercepted by server.ts.
// This file is kept for local development compatibility only.
//
// SECURITY: Both POST and GET require x-cron-secret authentication.
//
// USAGE:
//   Option A (primary):  in-process scheduler — no external call needed
//   Option B (fallback): Railway Cron → curl POST /api/process-jobs
//   Option C (manual):   curl -X POST … -H "x-cron-secret: $CRON_SECRET"
// =============================================================================

import { createAPIFileRoute } from "@tanstack/react-start/api";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { collect } from "@/lib/api/wallet-collection-worker";

const LOG = "[process-jobs]";

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
    console.error(`${LOG} CRON_SECRET env var is not set — all requests rejected.`);
    return json(
      { ok: false, error: "Service misconfigured: CRON_SECRET is not set." },
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
  POST: async ({ request }) => {
    const authError = checkAuth(request);
    if (authError) return authError;

    const { client: sb, keyType } = getSupabase();

    if (!sb) {
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
      return json({ ok: false, error: fetchError.message, processed: 0 });
    }

    if (!stuckJobs || stuckJobs.length === 0) {
      return json({ ok: true, message: "No stuck jobs found", processed: 0, keyType });
    }

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

      // FIX: check stamp error + optimistic lock
      const { error: stampErr } = await sb
        .from("wallet_collection_jobs")
        .update({
          status:     "processing",
          started_at: new Date().toISOString(),
          attempts:   (job.attempts as number ?? 0) + 1,
        })
        .eq("id", jobId)
        .eq("status", job.status as string);

      if (stampErr) {
        console.error(
          `${LOG} [${jobId}] STAMP FAILED: ${stampErr.message} ` +
          "(keyType=" + keyType + "). Skipping collect().",
        );
        results.push({ jobId, token, status: "stamp_failed", stampError: stampErr.message });
        continue;
      }

      try {
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

        results.push({ jobId, token, status: "done", traders: result.tradersCollected });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await safeUpdateJob(sb, jobId, "failed", { last_error: msg }).catch(() => {});
        results.push({ jobId, token, status: "failed", error: msg });
      }
    }

    return json({ ok: true, processed: results.length, keyType, results });
  },

  GET: async ({ request }) => {
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
      message: "Use POST to process stuck jobs.",
      pendingJobs: pendingJobs ?? [],
    });
  },
});
