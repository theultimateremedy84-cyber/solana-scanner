// =============================================================================
// agent-runner.ts  —  v2
//
// Enhanced autonomous agent loop:
//   1. Supabase health check (fail fast if DB is unreachable)
//   2. Fetch live stats from /api/monitor-dashboard (localhost, CRON_SECRET auth)
//   3. Detect issues using enhanced threshold rules (v2 detector)
//   4. Apply fixes: cooldown + circuit breaker + multi-step chains + verification
//   5. Send email alerts (Helius 800k, criticals, fix failures, circuit openings)
//   6. Persist full incident report to Supabase
//
// NOTE: /api/monitor-dashboard is protected by CRON_SECRET. This runner calls
// it via localhost (same process) and attaches the secret automatically.
// The external Railway URL is NOT used — calling localhost is faster, avoids
// network round-trips, and works even if the public URL changes.
// =============================================================================

import { randomUUID } from "crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { agentState } from "./agent-state";
import { detectIssues, buildSummary } from "./agent-issue-detector";
import { applyFixes } from "./agent-fixer";
import { getOpenCircuits } from "./agent-circuit-breaker";
import {
  sendHeliusBudgetAlert,
  sendCriticalIssueAlert,
  sendFixFailureAlert,
  sendCircuitOpenAlert,
} from "./agent-email";

const LOG = "[agent-runner]";

// ── Settings loader ───────────────────────────────────────────────────────────

interface AgentSettings {
  helius_agent_api_key: string | null;
  monitoring_enabled: boolean;
  interval_minutes: number;
  auto_fix: boolean;
}

async function loadSettings(): Promise<AgentSettings> {
  const { data, error } = await supabaseAdmin
    .from("agent_settings")
    .select("helius_agent_api_key, monitoring_enabled, interval_minutes, auto_fix")
    .eq("id", "default")
    .single();

  if (error || !data) {
    console.warn(LOG, "Could not load settings, using defaults:", error?.message);
    return {
      helius_agent_api_key: process.env.HELIUS_AGENT_API_KEY ?? null,
      monitoring_enabled: true,
      interval_minutes: 5,
      auto_fix: true,
    };
  }

  const d = data as Record<string, unknown>;
  return {
    helius_agent_api_key:
      (d.helius_agent_api_key as string | null) ?? process.env.HELIUS_AGENT_API_KEY ?? null,
    monitoring_enabled: (d.monitoring_enabled as boolean) ?? true,
    interval_minutes:   (d.interval_minutes as number)   ?? 5,
    auto_fix:           (d.auto_fix as boolean)           ?? true,
  };
}

// ── Supabase health check ─────────────────────────────────────────────────────

async function checkSupabaseHealth(): Promise<boolean> {
  try {
    const { error } = await supabaseAdmin
      .from("agent_settings")
      .select("id")
      .eq("id", "default")
      .single();
    return !error;
  } catch {
    return false;
  }
}

// ── Monitor stats fetcher ─────────────────────────────────────────────────────
//
// Calls /api/monitor-dashboard on localhost so the request stays in-process
// (no external network hop). Attaches CRON_SECRET because the route is
// protected by requireCronSecret() in server.ts.
// ---------------------------------------------------------------------------

async function fetchMonitorStats(): Promise<Record<string, unknown>> {
  const port   = process.env.PORT ?? "3000";
  const secret = process.env.CRON_SECRET ?? "";
  const url    = `http://localhost:${port}/api/monitor-dashboard`;

  const res = await fetch(url, {
    headers: {
      Accept:           "application/json",
      "x-cron-secret": secret,
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    throw new Error(
      `Monitor fetch failed: ${res.status} ${res.statusText}. ` +
      (res.status === 401
        ? "Check that CRON_SECRET env var is set in Railway Variables."
        : ""),
    );
  }

  return res.json() as Promise<Record<string, unknown>>;
}

// ── Main run ──────────────────────────────────────────────────────────────────

export async function runAgent(triggeredBy: "auto" | "manual" = "auto"): Promise<{
  reportId: string;
  issuesDetected: number;
  fixesApplied: number;
  fixesSkipped: number;
  openCircuits: string[];
  durationMs: number;
  summary: string;
}> {
  if (agentState.isRunning()) throw new Error("Agent is already running");

  const startMs = Date.now();
  agentState.setStatus("running");

  try {
    // ── 0. Supabase health check ──────────────────────────────────────────────
    const dbHealthy = await checkSupabaseHealth();
    if (!dbHealthy) {
      console.error(LOG, "Supabase is unreachable — aborting run to avoid silent failures");
      agentState.setStatus("error");
      agentState.setLastError("Supabase health check failed");
      throw new Error("Supabase health check failed");
    }

    // ── 1. Load settings ──────────────────────────────────────────────────────
    const settings = await loadSettings();
    console.log(LOG, `Run starting — triggeredBy=${triggeredBy} auto_fix=${settings.auto_fix}`);

    // ── 2. Fetch live pipeline metrics ────────────────────────────────────────
    const raw = await fetchMonitorStats();

    // ── 3. Detect issues ──────────────────────────────────────────────────────
    const { issues, heliusNeedsEmailAlert, heliusMonthlyUsed } = detectIssues(
      raw as Parameters<typeof detectIssues>[0],
    );
    agentState.setCurrentIssues(issues);
    console.log(LOG, `Issues detected: ${issues.length} (${issues.filter(i => i.fixable).length} fixable)`);

    // ── 4. Apply fixes ────────────────────────────────────────────────────────
    let fixes: Awaited<ReturnType<typeof applyFixes>> = [];
    if (settings.auto_fix) {
      fixes = await applyFixes(issues);
    } else {
      console.log(LOG, "auto_fix disabled — skipping. Enable in /agent Settings.");
    }

    const fixesApplied          = fixes.filter(f => f.success).length;
    const fixesSkipped          = fixes.filter(f => !!f.skippedReason).length;
    const newlyOpenedCircuits   = fixes.filter(f => f.circuitOpened).map(f => f.issueId);

    // ── 5. Update open circuit state in memory ────────────────────────────────
    const openCircuits = await getOpenCircuits();
    agentState.setOpenCircuits(openCircuits);

    // ── 6. Email alerts (parallel) ────────────────────────────────────────────
    const emailJobs: Promise<void>[] = [];

    if (heliusNeedsEmailAlert) {
      emailJobs.push(sendHeliusBudgetAlert(heliusMonthlyUsed));
    }

    const criticals = issues.filter(i => i.severity === "critical");
    if (criticals.length > 0) {
      emailJobs.push(sendCriticalIssueAlert(issues));
    }

    const failedFixes = fixes.filter(f => !f.success && !f.skippedReason);
    if (failedFixes.length > 0) {
      emailJobs.push(sendFixFailureAlert(fixes));
    }

    if (newlyOpenedCircuits.length > 0) {
      emailJobs.push(sendCircuitOpenAlert(newlyOpenedCircuits, issues));
    }

    if (emailJobs.length > 0) {
      await Promise.allSettled(emailJobs);
    }

    // ── 7. Build summary and persist ──────────────────────────────────────────
    const summary    = buildSummary(issues, fixesApplied, fixesSkipped);
    const durationMs = Date.now() - startMs;
    const reportId   = randomUUID();

    const { error: insertErr } = await supabaseAdmin.from("incident_reports").insert({
      id:              reportId,
      triggered_by:    triggeredBy,
      issues_detected: issues.length,
      fixes_applied:   fixesApplied,
      duration_ms:     durationMs,
      summary,
      issues:          issues as unknown as Record<string, unknown>[],
      fixes:           fixes  as unknown as Record<string, unknown>[],
      snapshot_stats:  raw    as Record<string, unknown>,
    });

    if (insertErr) {
      console.error(LOG, "Failed to persist incident report:", insertErr.message);
    }

    agentState.recordRun(fixesApplied, fixesSkipped);
    agentState.setStatus("idle");

    console.log(
      LOG,
      `Run complete — id=${reportId} issues=${issues.length} fixed=${fixesApplied} ` +
      `skipped=${fixesSkipped} circuits_open=${openCircuits.length} ms=${durationMs}`,
    );

    return { reportId, issuesDetected: issues.length, fixesApplied, fixesSkipped, openCircuits, durationMs, summary };

  } catch (err) {
    agentState.setStatus("error");
    agentState.setLastError(String(err));
    console.error(LOG, "Run failed:", err);
    throw err;
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

export async function startAgentScheduler(): Promise<void> {
  const settings = await loadSettings();
  agentState.updateSchedule(settings.monitoring_enabled, settings.interval_minutes);

  if (settings.monitoring_enabled) {
    console.log(
      LOG,
      `Scheduler started — interval=${settings.interval_minutes}m auto_fix=${settings.auto_fix}`,
    );
    agentState.scheduleNext(() => runAgent("auto"), settings.interval_minutes);
  } else {
    console.log(LOG, "Monitoring disabled in settings — scheduler not started");
  }
}
