// =============================================================================
// agent-email.ts  —  v2
//
// SMTP email notifications for the autonomous agent.
//
// v2 adds:
//   • sendCircuitOpenAlert — fires when a circuit breaker opens for a category,
//     meaning a fix has been attempted N times without improvement and the agent
//     has suspended further attempts. Human review required.
//
// All other senders unchanged from v1.
// =============================================================================

import nodemailer from "nodemailer";
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

  const transporter = nodemailer.createTransport({
    host:   cfg.smtp_host!,
    port:   cfg.smtp_port,
    secure: cfg.smtp_port === 465,
    auth:   { user: cfg.smtp_user!, pass: cfg.smtp_pass! },
  });

  await transporter.sendMail({
    from:    `"Solana Scanner Agent" <${cfg.smtp_from ?? cfg.smtp_user}>`,
    to:      cfg.alert_email!,
    subject,
    html,
  });

  console.log(LOG, `✉️  Sent: "${subject}" → ${cfg.alert_email}`);
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

function wrap(title: string, accentColor: string, body: string): string {
  return `
<!DOCTYPE html>
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
          <p style="margin:0;color:#475569;font-size:12px">
            Solana Scanner Autonomous Agent &nbsp;·&nbsp; ${new Date().toUTCString()}
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function row(label: string, value: string, accent = "#1e293b"): string {
  return `<tr>
    <td style="padding:10px 14px;background:${accent};color:#94a3b8;font-size:13px;font-weight:600;width:180px;vertical-align:top">${label}</td>
    <td style="padding:10px 14px;background:#0f172a;color:#e2e8f0;font-size:13px">${value}</td>
  </tr>`;
}

// ── Public senders ────────────────────────────────────────────────────────────

export async function sendHeliusBudgetAlert(
  monthlyUsed: number,
  threshold = 800_000,
): Promise<void> {
  try {
    const cfg = await loadEmailConfig();
    if (!isConfigured(cfg)) return;

    const pct     = ((monthlyUsed / threshold) * 100).toFixed(1);
    const subject = `⚠️ Helius Budget Alert — ${monthlyUsed.toLocaleString()} CU used (${pct}% of ${threshold.toLocaleString()})`;

    const body = `
      <p>Your pipeline has consumed <strong style="color:#f59e0b">${monthlyUsed.toLocaleString()} compute units</strong> this month.</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:8px;overflow:hidden;margin:20px 0">
        ${row("Monthly Used",    `${monthlyUsed.toLocaleString()} CU`)}
        ${row("Alert Threshold", `${threshold.toLocaleString()} CU`)}
        ${row("Usage %",         `${pct}%`)}
      </table>
      <p style="color:#f59e0b">⚠️ If usage continues at this rate you risk Helius rate limits or overage charges. The agent will attempt to auto-pause token discovery at 95% daily usage.</p>
    `;

    await send(cfg, subject, wrap("Helius Budget Warning", "#b45309", body));
  } catch (err) {
    console.error(LOG, "sendHeliusBudgetAlert failed:", err);
  }
}

export async function sendCriticalIssueAlert(issues: DetectedIssue[]): Promise<void> {
  try {
    const criticals = issues.filter(i => i.severity === "critical");
    if (criticals.length === 0) return;

    const cfg = await loadEmailConfig();
    if (!isConfigured(cfg)) return;

    const subject = `🚨 ${criticals.length} Critical Pipeline Issue${criticals.length > 1 ? "s" : ""} Detected`;

    const issueRows = criticals.map(i => `
      <div style="background:#0f172a;border-left:4px solid #dc2626;border-radius:4px;padding:14px 18px;margin:12px 0">
        <p style="margin:0 0 6px;color:#f87171;font-weight:700;font-size:14px">${i.title}</p>
        <p style="margin:0;color:#94a3b8;font-size:13px">${i.description}</p>
        ${i.metric ? `<p style="margin:6px 0 0;color:#64748b;font-size:12px">Metric: <code style="color:#7dd3fc">${i.metric}</code> = <strong>${i.value}</strong></p>` : ""}
        <p style="margin:6px 0 0;font-size:12px;color:${i.fixable ? "#4ade80" : "#f87171"}">${i.fixable ? "✅ Auto-fix queued" : "⚠️ Requires manual review"}</p>
      </div>
    `).join("");

    const body = `
      <p>The autonomous agent detected <strong style="color:#f87171">${criticals.length} critical issue${criticals.length > 1 ? "s" : ""}</strong>:</p>
      ${issueRows}
      <p style="margin-top:24px">Non-fixable issues require your attention. Check the <strong>/agent</strong> dashboard for the full incident report.</p>
    `;

    await send(cfg, subject, wrap("🚨 Critical Issues Detected", "#991b1b", body));
  } catch (err) {
    console.error(LOG, "sendCriticalIssueAlert failed:", err);
  }
}

export async function sendFixFailureAlert(failures: AppliedFix[]): Promise<void> {
  try {
    const failed = failures.filter(f => !f.success && !f.skippedReason);
    if (failed.length === 0) return;

    const cfg = await loadEmailConfig();
    if (!isConfigured(cfg)) return;

    const subject = `❌ ${failed.length} Automated Fix${failed.length > 1 ? "es" : ""} Failed — Manual Action Required`;

    const fixRows = failed.map(f => `
      <div style="background:#0f172a;border-left:4px solid #f59e0b;border-radius:4px;padding:14px 18px;margin:12px 0">
        <p style="margin:0 0 6px;color:#fbbf24;font-weight:700;font-size:14px">${f.action.replace(/_/g, " ").toUpperCase()}</p>
        <p style="margin:0;color:#94a3b8;font-size:13px">${f.description}</p>
        ${f.metricBefore ? `<p style="margin:4px 0 0;color:#64748b;font-size:12px">Metric before: <strong>${f.metricBefore}</strong>${f.metricAfter ? ` → after: <strong>${f.metricAfter}</strong>` : ""}</p>` : ""}
        ${f.error ? `<p style="margin:6px 0 0;color:#f87171;font-size:12px">Error: ${f.error}</p>` : ""}
      </div>
    `).join("");

    const body = `
      <p>The agent attempted to fix detected issues but <strong style="color:#fbbf24">${failed.length} fix${failed.length > 1 ? "es" : ""} failed</strong>:</p>
      ${fixRows}
      <p style="margin-top:24px">Check Railway logs for detail. If failures persist, the circuit breaker will suspend further attempts after ${3} tries.</p>
    `;

    await send(cfg, subject, wrap("Fix Failures — Action Needed", "#92400e", body));
  } catch (err) {
    console.error(LOG, "sendFixFailureAlert failed:", err);
  }
}

/**
 * NEW in v2: fires when a circuit breaker opens for one or more categories.
 * This means the agent has tried N times without improvement and has given up
 * auto-fixing that category. Human review is essential.
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
        <strong>What this means:</strong> The agent tried to fix these issues multiple times within the lookback window, but the metric did not improve after each attempt. To avoid hammering a broken endpoint in a loop, further auto-fix attempts for these categories are suspended for up to 2 hours.
      </p>
      <p style="color:#f87171;font-size:13px">
        <strong>Action required:</strong> Log in, check Railway logs for root-cause errors, and investigate why the fix endpoint is not resolving the issue. The circuit will auto-reset after ≤2 h or immediately when the metric improves.
      </p>
    `;

    await send(cfg, subject, wrap("⚡ Circuit Breaker Opened", "#5b21b6", body));
  } catch (err) {
    console.error(LOG, "sendCircuitOpenAlert failed:", err);
  }
}
