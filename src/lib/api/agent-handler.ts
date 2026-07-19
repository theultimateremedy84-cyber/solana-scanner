// =============================================================================
// agent-handler.ts  —  v2
//
// HTTP handlers for all agent API routes.
//
// New in v2:
//   GET  /api/agent/circuits    — list open circuit breakers
//   GET  /api/agent/fix-log     — recent fix audit log (last 100 entries)
//   POST /api/agent/circuits/:cat/reset  — manually reset a circuit
// =============================================================================

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { agentState } from "./agent-state";
import { runAgent, startAgentScheduler } from "./agent-runner";
import { closeCircuit, getOpenCircuits } from "./agent-circuit-breaker";

const LOG = "[agent-handler]";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── GET /api/agent/status ─────────────────────────────────────────────────────

export async function handleAgentStatus(_request: Request): Promise<Response> {
  return json(agentState.snapshot());
}

// ── GET /api/agent/issues ─────────────────────────────────────────────────────

export async function handleAgentIssues(_request: Request): Promise<Response> {
  return json({ issues: agentState.currentIssues() });
}

// ── POST /api/agent/run ───────────────────────────────────────────────────────

export async function handleAgentRun(_request: Request): Promise<Response> {
  try {
    const result = await runAgent("manual");
    return json({ ok: true, ...result });
  } catch (err) {
    const msg = String(err);
    if (msg.includes("already running")) return json({ ok: false, error: msg }, 409);
    console.error(LOG, "handleAgentRun error:", err);
    return json({ ok: false, error: msg }, 500);
  }
}

// ── GET /api/agent/reports ────────────────────────────────────────────────────

export async function handleAgentReports(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "50"), 200);

  const { data, error } = await supabaseAdmin
    .from("incident_reports")
    .select("id, created_at, triggered_by, issues_detected, fixes_applied, duration_ms, summary")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) return json({ ok: false, error: error.message }, 500);
  return json({ ok: true, reports: data ?? [] });
}

// ── GET /api/agent/reports/:id ────────────────────────────────────────────────

export async function handleAgentReportById(
  _request: Request,
  id: string,
): Promise<Response> {
  const { data, error } = await supabaseAdmin
    .from("incident_reports")
    .select("*")
    .eq("id", id)
    .single();

  if (error) return json({ ok: false, error: error.message }, 404);
  return json({ ok: true, report: data });
}

// ── GET /api/agent/circuits ───────────────────────────────────────────────────

export async function handleAgentCircuits(_request: Request): Promise<Response> {
  const { data, error } = await supabaseAdmin
    .from("agent_circuit_state")
    .select("category, opened_at, consecutive_failures, last_metric, reset_after, notes")
    .order("opened_at", { ascending: false });

  if (error) return json({ ok: false, error: error.message }, 500);

  const now = new Date();
  const active = (data ?? []).filter(
    row => new Date((row as Record<string, unknown>).reset_after as string) > now,
  );

  return json({ ok: true, openCircuits: active });
}

// ── POST /api/agent/circuits/:category/reset ──────────────────────────────────

export async function handleCircuitReset(
  _request: Request,
  category: string,
): Promise<Response> {
  try {
    await closeCircuit(category);
    const open = await getOpenCircuits();
    agentState.setOpenCircuits(open);
    console.log(LOG, `Circuit manually reset for '${category}'`);
    return json({ ok: true, message: `Circuit for '${category}' reset.` });
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
}

// ── GET /api/agent/fix-log ────────────────────────────────────────────────────

export async function handleAgentFixLog(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "100"), 500);
  const category = url.searchParams.get("category");

  let query = supabaseAdmin
    .from("agent_fix_log")
    .select("id, applied_at, category, action, success, metric_key, metric_before, metric_after, improved, circuit_opened, error_detail")
    .order("applied_at", { ascending: false })
    .limit(limit);

  if (category) {
    query = query.eq("category", category);
  }

  const { data, error } = await query;
  if (error) return json({ ok: false, error: error.message }, 500);
  return json({ ok: true, fixLog: data ?? [] });
}

// ── GET /api/agent/settings ───────────────────────────────────────────────────

export async function handleAgentSettingsGet(_request: Request): Promise<Response> {
  const { data, error } = await supabaseAdmin
    .from("agent_settings")
    .select(
      "helius_agent_api_key, monitoring_enabled, interval_minutes, auto_fix, " +
      "alert_email, smtp_host, smtp_port, smtp_user, smtp_from, " +
      "fix_cooldown_minutes, circuit_failure_threshold, circuit_window_minutes, " +
      "circuit_reset_hours, verify_fix_delay_seconds, updated_at",
    )
    .eq("id", "default")
    .single();

  if (error) return json({ ok: false, error: error.message }, 500);

  const d = (data ?? {}) as Record<string, unknown>;

  return json({
    ok: true,
    settings: {
      heliusAgentKeySet:         !!d.helius_agent_api_key,
      heliusAgentKeyPreview:     d.helius_agent_api_key
        ? `${String(d.helius_agent_api_key).slice(0, 6)}…`
        : null,
      monitoringEnabled:         d.monitoring_enabled         ?? true,
      intervalMinutes:           d.interval_minutes           ?? 5,
      autoFix:                   d.auto_fix                   ?? true,
      // Email
      alertEmail:                d.alert_email                ?? null,
      smtpHost:                  d.smtp_host                  ?? null,
      smtpPort:                  d.smtp_port                  ?? 587,
      smtpUser:                  d.smtp_user                  ?? null,
      smtpFrom:                  d.smtp_from                  ?? null,
      smtpPassSet:               !!d.smtp_pass,
      // v2 — Circuit breaker + cooldown config
      fixCooldownMinutes:        d.fix_cooldown_minutes        ?? 15,
      circuitFailureThreshold:   d.circuit_failure_threshold   ?? 3,
      circuitWindowMinutes:      d.circuit_window_minutes      ?? 90,
      circuitResetHours:         d.circuit_reset_hours         ?? 2,
      verifyFixDelaySeconds:     d.verify_fix_delay_seconds    ?? 30,
      updatedAt:                 d.updated_at                  ?? null,
    },
  });
}

// ── PUT /api/agent/settings ───────────────────────────────────────────────────

export async function handleAgentSettingsPut(request: Request): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  // Core
  if (body.heliusAgentApiKey   != null)  updates.helius_agent_api_key      = body.heliusAgentApiKey;
  if (typeof body.monitoringEnabled === "boolean") updates.monitoring_enabled = body.monitoringEnabled;
  if (typeof body.intervalMinutes   === "number")  updates.interval_minutes   = body.intervalMinutes;
  if (typeof body.autoFix           === "boolean") updates.auto_fix           = body.autoFix;

  // Email
  if (body.alertEmail !== undefined) updates.alert_email = body.alertEmail;
  if (body.smtpHost   !== undefined) updates.smtp_host   = body.smtpHost;
  if (body.smtpPort   !== undefined) updates.smtp_port   = body.smtpPort;
  if (body.smtpUser   !== undefined) updates.smtp_user   = body.smtpUser;
  if (body.smtpPass   != null)       updates.smtp_pass   = body.smtpPass;
  if (body.smtpFrom   !== undefined) updates.smtp_from   = body.smtpFrom;

  // v2 — Circuit breaker + cooldown
  if (typeof body.fixCooldownMinutes      === "number") updates.fix_cooldown_minutes      = body.fixCooldownMinutes;
  if (typeof body.circuitFailureThreshold === "number") updates.circuit_failure_threshold = body.circuitFailureThreshold;
  if (typeof body.circuitWindowMinutes    === "number") updates.circuit_window_minutes    = body.circuitWindowMinutes;
  if (typeof body.circuitResetHours       === "number") updates.circuit_reset_hours       = body.circuitResetHours;
  if (typeof body.verifyFixDelaySeconds   === "number") updates.verify_fix_delay_seconds  = body.verifyFixDelaySeconds;

  const { data, error } = await supabaseAdmin
    .from("agent_settings")
    .upsert({ id: "default", ...updates })
    .select()
    .single();

  if (error) return json({ ok: false, error: error.message }, 500);

  if (body.monitoringEnabled !== undefined || body.intervalMinutes !== undefined) {
    const d = (data ?? {}) as Record<string, unknown>;
    agentState.updateSchedule(
      d.monitoring_enabled as boolean,
      d.interval_minutes as number,
    );
    if (d.monitoring_enabled) {
      agentState.scheduleNext(() => runAgent("auto"), d.interval_minutes as number);
    }
  }

  console.log(LOG, "Settings updated:", Object.keys(updates).join(", "));
  return json({ ok: true });
}

export { startAgentScheduler };
