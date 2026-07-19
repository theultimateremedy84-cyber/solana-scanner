// =============================================================================
// agent-email.ts  —  v4
//
// SMTP email notifications for the autonomous agent.
//
// v4 changes (deploy-fix):
//   • Added missing exports sendHeliusBudgetAlert + sendCriticalIssueAlert
//     that agent-runner.ts imports. Their absence caused the Rollup "not
//     exported" build error on Railway.
//   • Fixed sendFixFailureAlert signature: now accepts the full fixes array
//     (AppliedFix[]) and filters for failures internally, matching the call
//     site: sendFixFailureAlert(fixes) in agent-runner.ts.
//
// v3 changes:
//   • Removed `nodemailer` npm dependency — replaced with smtp-native.ts,
//     a zero-dependency SMTP client using Node's built-in net/tls modules.
//
// v2 adds:
//   • sendCircuitOpenAlert — fires when a circuit breaker opens.
// =============================================================================

import { sendMail } from "./smtp-native";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { DetectedIssue, AppliedFix } from "./agent-state";

const LOG = "[agent-email]";

// ── Settings loader ───────────────────────────────────────────────────────────

interface EmailConfig {
  alert_email: string | null;
  smtp_host:   string | null;
  smtp_port:   number;
  smtp_user:   string | null;
  smtp_pass:   string | null;
  smtp_from:   string | null;
}

async function loadEmailConfig(): Promise<EmailConfig> {
  const { data } = await supabaseAdmin
    .from("agent_settings")
    .select("alert_email, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from")
    .eq("id", "default")
    .single();

  return {
    alert_email: (data as Record<string, unknown> | null)?.alert_email as string | null ?? null,
    smtp_host:   (data as Record<string, unknown> | null)?.smtp_host   as string | null ?? null,
    smtp_port:   ((data as Record<string, unknown> | null)?.smtp_port  as number | null) ?? 587,
    smtp_user:   (data as Record<string, unknown> | null)?.smtp_user   as string | null ?? null,
    smtp_pass:   (data as Record<string, unknown> | null)?.smtp_pass   as string | null ?? null,
    smtp_from:   (data as Record<string, unknown> | null)?.smtp_from   as string | null ?? null,
  };
}

function isConfigured(cfg: EmailConfig): boolean {
  return !!(cfg.alert_email && cfg.smtp_host && cfg.smtp_user && cfg.smtp_pass);
}

// ── Core send ─────────────────────────────────────────────────────────────────

async function send(cfg: EmailConfig, subject: string, html: string): Promise<void> {
  if (!isConfigured(cfg)) {
    console.warn(LOG, "Email not configured — skipping. Set SMTP in /agent Settings.");
    return;
  }

  await sendMail(
    {
      host: cfg.smtp_host!,
      port: cfg.smtp_port,
      user: cfg.smtp_user!,
      pass: cfg.smtp_pass!,
    },
    {
      from:    `"Solana Scanner Agent" <${cfg.smtp_from ?? cfg.smtp_user}>`,
      to:      cfg.alert_email!,
      subject,
      html,
    },
  );

  console.log(LOG, `✉️  Sent: "${subject}" → ${cfg.alert_email}`);
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

function wrap(title: string, accentColor: string, body: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:40px 20px">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#1e293b;border-radius:12px;overflow:hidden;max-width:600px">
        <tr><td style="background:${accentColor};padding:24px 32px">
          <p style="margin:0;color:#fff;font-size:11px;letter-spacing:2px;text-transform:uppercase;opacity:.8">Solana Scanner · Autonomous Agent</p>
          <h1 style="margin:8px 0 0;color:#fff;font-size:22px;font-weight:700">${title}</h1>
        </td></tr>
        <tr><td style="padding:32px;color:#cbd5e1;font-size:15px;line-height:1.6">
          ${body}
        </td></tr>
        <tr><td style="padding:16px 32px;border-top:1px solid #334155">
          <p style="margin:0;color:#64748b;font-size:12px">
            Solana Scanner — Autonomous Agent
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function issueRow(i: DetectedIssue): string {
  const severityColor = i.severity === "critical" ? "#ef4444" : i.severity === "warning" ? "#f59e0b" : "#3b82f6";
  return `
    <div style="background:#0f172a;border-left:4px solid ${severityColor};border-radius:4px;padding:14px 18px;margin:12px 0">
      <p style="margin:0 0 4px;color:${severityColor};font-weight:700;font-size:13px;text-transform:uppercase">${i.severity} · ${i.category.replace(/_/g, " ")}</p>
      <p style="margin:0 0 6px;color:#e2e8f0;font-size:14px;font-weight:600">${i.title}</p>
      <p style="margin:0;color:#94a3b8;font-size:13px">${i.description}</p>
      ${i.value ? `<p style="margin:6px 0 0;color:#64748b;font-size:12px">Metric: <strong style="color:#cbd5e1">${i.metric ?? ""} = ${i.value}</strong></p>` : ""}
    </div>
  `;
}

function fixRow(f: AppliedFix, ok: boolean): string {
  const color = ok ? "#22c55e" : "#f87171";
  return `
    <div style="background:#0f172a;border-left:4px solid ${color};border-radius:4px;padding:12px 18px;margin:8px 0">
      <p style="margin:0 0 4px;color:${color};font-weight:700;font-size:13px">${ok ? "✓" : "✗"} ${f.action}</p>
      <p style="margin:0;color:#94a3b8;font-size:12px">${f.description}</p>
      ${f.error ? `<p style="margin:4px 0 0;color:#f87171;font-size:12px">Error: ${f.error}</p>` : ""}
    </div>
  `;
}

// ── Public senders ────────────────────────────────────────────────────────────

/**
 * Fires when Helius monthly CU usage crosses the 800k alert threshold.
 * heliusMonthlyUsed is the raw CU count.
 */
export async function sendHeliusBudgetAlert(heliusMonthlyUsed: number): Promise<void> {
  try {
    const cfg = await loadEmailConfig();
    if (!isConfigured(cfg)) return;

    const used = heliusMonthlyUsed.toLocaleString();
    const pct  = ((heliusMonthlyUsed / 1_000_000) * 100).toFixed(1);

    const subject = `🔥 Helius Budget Alert — ${used} CUs used this month (${pct}% of 1M)`;

    const body = `
      <p>Your Helius API monthly compute-unit usage has crossed the <strong style="color:#f97316">800,000 CU alert threshold</strong>:</p>

      <div style="background:#0f172a;border-left:4px solid #f97316;border-radius:4px;padding:20px 24px;margin:20px 0">
        <p style="margin:0 0 8px;color:#fdba74;font-size:28px;font-weight:700">${used} <span style="font-size:16px;color:#94a3b8">/ 1,000,000 CUs</span></p>
        <div style="background:#1e293b;border-radius:4px;height:10px;margin:8px 0">
          <div style="background:#f97316;border-radius:4px;height:10px;width:${Math.min(parseFloat(pct), 100)}%"></div>
        </div>
        <p style="margin:8px 0 0;color:#94a3b8;font-size:13px">${pct}% of monthly allowance consumed</p>
      </div>

      <p style="color:#94a3b8;font-size:13px">
        <strong>What to do:</strong> Check which operations are consuming the most CUs in the Helius dashboard.
        Enrichment jobs and wallet-activity fetches are the primary consumers.
        Consider reducing <code>ENRICHER_CONCURRENCY</code> if you're running low before month-end.
      </p>
    `;

    await send(cfg, subject, wrap("🔥 Helius Budget Alert", "#c2410c", body));
  } catch (err) {
    console.error(LOG, "sendHeliusBudgetAlert failed:", err);
  }
}

/**
 * Fires when one or more critical-severity issues are detected.
 * Sends all detected issues (not just criticals) so the operator has full
 * context — criticals are highlighted at the top.
 */
export async function sendCriticalIssueAlert(issues: DetectedIssue[]): Promise<void> {
  try {
    if (issues.length === 0) return;
    const cfg = await loadEmailConfig();
    if (!isConfigured(cfg)) return;

    const criticals = issues.filter(i => i.severity === "critical");
    const others    = issues.filter(i => i.severity !== "critical");

    const subject = `🚨 Critical Alert — ${criticals.length} critical issue${criticals.length > 1 ? "s" : ""} detected`;

    const body = `
      <p><strong style="color:#ef4444">${criticals.length} critical issue${criticals.length > 1 ? "s" : ""}</strong> detected that require immediate attention:</p>
      ${criticals.map(issueRow).join("")}
      ${others.length > 0 ? `
        <p style="margin-top:24px;color:#94a3b8;font-size:13px"><strong>${others.length} additional issue${others.length > 1 ? "s" : ""}:</strong></p>
        ${others.map(issueRow).join("")}
      ` : ""}
      <p style="margin-top:20px;color:#94a3b8;font-size:13px">
        The agent will attempt auto-fixes where possible. Check Railway logs if the issues persist.
      </p>
    `;

    await send(cfg, subject, wrap("🚨 Critical Issues Detected", "#7f1d1d", body));
  } catch (err) {
    console.error(LOG, "sendCriticalIssueAlert failed:", err);
  }
}

/**
 * General issue alert (non-critical batch).
 */
export async function sendIssueAlert(issues: DetectedIssue[]): Promise<void> {
  try {
    if (issues.length === 0) return;
    const cfg = await loadEmailConfig();
    if (!isConfigured(cfg)) return;

    const subject = `⚠️ Solana Scanner Agent — ${issues.length} issue${issues.length > 1 ? "s" : ""} detected`;
    const body = `
      <p>${issues.length} pipeline issue${issues.length > 1 ? "s were" : " was"} detected — <strong>auto-fix is being attempted</strong>:</p>
      ${issues.map(issueRow).join("")}
      <p style="margin-top:20px;color:#94a3b8;font-size:13px">
        You will receive another email if fixes succeed or require human intervention.
      </p>
    `;

    await send(cfg, subject, wrap("⚠️ Issues Detected", "#1d4ed8", body));
  } catch (err) {
    console.error(LOG, "sendIssueAlert failed:", err);
  }
}

export async function sendFixSuccessAlert(fixes: AppliedFix[]): Promise<void> {
  try {
    const successful = fixes.filter(f => f.success);
    if (successful.length === 0) return;
    const cfg = await loadEmailConfig();
    if (!isConfigured(cfg)) return;

    const subject = `✅ Solana Scanner Agent — ${successful.length} fix${successful.length > 1 ? "es" : ""} applied`;
    const body = `
      <p>${successful.length} issue${successful.length > 1 ? "s were" : " was"} automatically fixed:</p>
      ${successful.map(f => fixRow(f, true)).join("")}
      <p style="margin-top:20px;color:#94a3b8;font-size:13px">
        All fixes completed successfully. The pipeline should resume normal operation within 1–2 minutes.
      </p>
    `;

    await send(cfg, subject, wrap("✅ Fixes Applied", "#166534", body));
  } catch (err) {
    console.error(LOG, "sendFixSuccessAlert failed:", err);
  }
}

/**
 * Fires when fix attempts did not resolve the issues.
 * Accepts the full fixes array and filters for failures internally.
 */
export async function sendFixFailureAlert(fixes: AppliedFix[]): Promise<void> {
  try {
    const failed = fixes.filter(f => !f.success && !f.skippedReason);
    if (failed.length === 0) return;
    const cfg = await loadEmailConfig();
    if (!isConfigured(cfg)) return;

    const subject = `❌ Solana Scanner Agent — ${failed.length} fix${failed.length > 1 ? "es" : ""} failed`;
    const body = `
      <p><strong style="color:#f87171">${failed.length} fix attempt${failed.length > 1 ? "s" : ""} did not resolve the issue</strong>. Human review may be required:</p>
      ${failed.map(f => fixRow(f, false)).join("")}
      <p style="margin-top:20px;color:#94a3b8;font-size:13px">
        The agent will continue monitoring and retry automatically. If the issue persists, check Railway logs.
      </p>
    `;

    await send(cfg, subject, wrap("❌ Fix Failures — Action Needed", "#92400e", body));
  } catch (err) {
    console.error(LOG, "sendFixFailureAlert failed:", err);
  }
}

/**
 * Fires when a circuit breaker opens for one or more categories.
 * The agent has suspended auto-fix for those categories. Human review required.
 */
export async function sendCircuitOpenAlert(
  openedCategories: string[],
  issues: DetectedIssue[],
): Promise<void> {
  try {
    if (openedCategories.length === 0) return;
    const cfg = await loadEmailConfig();
    if (!isConfigured(cfg)) return;

    const subject = `⚡ Circuit Breaker Opened — ${openedCategories.length} categor${openedCategories.length > 1 ? "ies" : "y"} suspended`;

    const catRows = openedCategories.map(cat => {
      const related = issues.find(i => i.category === cat);
      return `
        <div style="background:#0f172a;border-left:4px solid #a78bfa;border-radius:4px;padding:14px 18px;margin:12px 0">
          <p style="margin:0 0 4px;color:#c4b5fd;font-weight:700;font-size:14px">${cat.replace(/_/g, " ").toUpperCase()}</p>
          ${related ? `<p style="margin:0;color:#94a3b8;font-size:13px">${related.description}</p>` : ""}
          <p style="margin:6px 0 0;color:#7c3aed;font-size:12px">Auto-fix suspended for ≤2 h. Will auto-reset when metric improves.</p>
        </div>
      `;
    }).join("");

    const body = `
      <p>The circuit breaker has <strong style="color:#a78bfa">opened for ${openedCategories.length} categor${openedCategories.length > 1 ? "ies" : "y"}</strong> because repeated auto-fix attempts did not improve the metric:</p>
      ${catRows}
      <p style="margin-top:20px;color:#94a3b8;font-size:13px">
        <strong>What this means:</strong> The agent tried to fix these issues multiple times but the metric did not improve. Further attempts are suspended for up to 2 hours to avoid a fix loop.
      </p>
      <p style="color:#f87171;font-size:13px">
        <strong>Action required:</strong> Check Railway logs for root-cause errors. The circuit will auto-reset after ≤2 h or immediately when the metric improves.
      </p>
    `;

    await send(cfg, subject, wrap("⚡ Circuit Breaker Opened", "#5b21b6", body));
  } catch (err) {
    console.error(LOG, "sendCircuitOpenAlert failed:", err);
  }
}
