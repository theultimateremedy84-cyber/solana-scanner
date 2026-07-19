// =============================================================================
// resolve-alert-handler.ts
//
// P2 audit fix: the alerts table had no resolution workflow — open alerts
// accumulated forever because there was no way to mark them resolved.
//
// Endpoints:
//   POST /api/resolve-alert
//     Body: { alertId: string, resolvedBy?: string }
//     Auth: x-cron-secret header (same pattern as every other mutating endpoint)
//     Marks the given alert as resolved by setting resolved_at = now().
//
//   POST /api/resolve-alerts (bulk)
//     Body: { alertIds: string[], resolvedBy?: string }
//     Auth: x-cron-secret header
//     Marks up to 100 alerts resolved in one call.
//
//   GET /api/resolve-alert
//     Returns open alert counts by severity (no auth required — read-only aggregate).
// =============================================================================

import { supabaseAdmin } from "@/integrations/supabase/client.server";

const LOG = "[ResolveAlertHandler]";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// GET /api/resolve-alert — open alert summary (no auth, read-only)
// ---------------------------------------------------------------------------
export async function handleResolveAlertGet(): Promise<Response> {
  try {
    const sb = supabaseAdmin;

    const [criticalRes, warnRes, totalOpenRes] = await Promise.all([
      sb
        .from("alerts")
        .select("id", { count: "exact", head: true })
        .eq("severity", "critical")
        .is("resolved_at", null),
      sb
        .from("alerts")
        .select("id", { count: "exact", head: true })
        .eq("severity", "warn")
        .is("resolved_at", null),
      sb
        .from("alerts")
        .select("id", { count: "exact", head: true })
        .is("resolved_at", null),
    ]);

    return json({
      ok: true,
      openAlerts: {
        total:    totalOpenRes.count  ?? 0,
        critical: criticalRes.count  ?? 0,
        warn:     warnRes.count      ?? 0,
      },
      usage: {
        single: "POST /api/resolve-alert  body: { alertId, resolvedBy? }",
        bulk:   "POST /api/resolve-alert  body: { alertIds: string[], resolvedBy? }",
        auth:   "Header: x-cron-secret: <CRON_SECRET>",
      },
    });
  } catch (err) {
    console.error(LOG, "GET error:", err);
    return json({ ok: false, error: "Internal error" }, 500);
  }
}

// ---------------------------------------------------------------------------
// POST /api/resolve-alert — mark one or many alerts resolved
// ---------------------------------------------------------------------------
export async function handleResolveAlertPost(request: Request): Promise<Response> {
  // Auth: require CRON_SECRET
  const cronSecret     = process.env.CRON_SECRET;
  const incomingSecret = request.headers.get("x-cron-secret");

  if (!cronSecret) {
    console.error(
      `${LOG} CRON_SECRET env var is not set — all POST requests rejected.`,
    );
    return json({ ok: false, error: "Service misconfigured: CRON_SECRET not set" }, 503);
  }
  if (!incomingSecret || incomingSecret !== cronSecret) {
    console.warn(`${LOG} Unauthorized — bad or missing x-cron-secret`);
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  // Parse body
  let body: { alertId?: string; alertIds?: string[]; resolvedBy?: string } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const { alertId, alertIds, resolvedBy = "api" } = body;

  // Build the list of IDs to resolve
  const ids: string[] = [];
  if (alertId) ids.push(alertId);
  if (Array.isArray(alertIds)) ids.push(...alertIds);

  if (ids.length === 0) {
    return json({ ok: false, error: "Provide alertId (string) or alertIds (string[])" }, 400);
  }

  // Cap bulk resolves at 100 per call to prevent runaway updates
  const capped = ids.slice(0, 100);
  if (capped.length < ids.length) {
    console.warn(
      `${LOG} Bulk resolve capped at 100 (received ${ids.length}). ` +
      "Make multiple calls to resolve more.",
    );
  }

  const sb = supabaseAdmin;
  const resolvedAt = new Date().toISOString();

  const { data, error } = await sb
    .from("alerts")
    .update({ resolved_at: resolvedAt, resolved_by: resolvedBy })
    .in("id", capped)
    .is("resolved_at", null)   // idempotent: skip already-resolved alerts
    .select("id");

  if (error) {
    console.error(LOG, "resolve error:", error.message);
    return json({ ok: false, error: error.message }, 500);
  }

  const resolvedCount = data?.length ?? 0;
  console.log(
    `${LOG} Resolved ${resolvedCount}/${capped.length} alerts ` +
    `(resolved_by=${resolvedBy}, resolved_at=${resolvedAt})`,
  );

  return json({
    ok: true,
    resolved:  resolvedCount,
    requested: capped.length,
    resolvedAt,
    resolvedBy,
    // Surface any IDs that were already resolved (not updated)
    notFound: capped.filter((id) => !data?.find((r) => r.id === id)),
  });
}
