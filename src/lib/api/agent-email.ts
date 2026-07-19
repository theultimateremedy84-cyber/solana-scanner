// =============================================================================
// agent-email.ts  —  v3
//
// SMTP email notifications for the autonomous agent.
//
// v3 changes:
//   • Removed `nodemailer` npm dependency entirely.
//     The bun.lock was generated inside Replit using internal proxy URLs
//     (http://package-firewall.replit.local/…) that do not resolve on
//     Railway's build servers, causing "FailedToOpenSocket / ConnectionRefused"
//     errors during `bun install --frozen-lockfile`.
//   • Replaced with `smtp-native.ts` — a zero-dependency SMTP client built on
//     Node's built-in `net` and `tls` modules (which Bun supports natively).
//     Supports port 465 (implicit TLS), 587 (STARTTLS), and AUTH LOGIN.
//
// v2 adds:
//   • sendCircuitOpenAlert — fires when a circuit breaker opens for a category,
//     meaning a fix has been attempted N times without improvement and the agent
//     has suspended further attempts. Human review required.
//
// All other senders unchanged from v1.
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
          <p style="margin:0;color:#64748b;font-size:12px">
            Solana Scanner — Autonomous Agent • ${new Date().toUTCString()}
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();
}

function issueRow(i: DetectedIssue): string {
  const badge = (v: number | null, label: string) =>
    v !== null
      ? `<span style="background:#0f172a;border-radius:4px;padding:2px 8px;font-size:12px;color:#94a3b8;margin-right:8px">${label}: <strong style="color:#e2e8f0">${v}</strong></span>`
      : "";
  return `
    <div style="background:#0f172a;border-left:4px solid #3b82f6;border-radius:4px;padding:14px 18px;margin:12px 0">
      <p style="margin:0 0 6px;color:#93c5fd;font-weight:700;font-size:14px">${i.category.replace(/_/g, " ").toUpperCase()}</p>
      <p style="margin:0 0 8px;color:#cbd5e1;font-size:13px">${i.description}</p>
      ${badge(i.current_value, "current")}
      ${badge(i.threshold,    "threshold")}
    </div>
  `;
}

function fixRow(f: AppliedFix, ok: boolean): string {
  const color = ok ? "#22c55e" : "#f87171";
  return `
    <div style="background:#0f172a;border-left:4px solid ${color};border-radius:4px;padding:12px 18px;margin:8px 0">
      <p style="margin:0 0 4px;color:${color};font-weight:700;font-size:13px">${ok ? "✓" : "✗"} ${f.category.replace(/_/g, " ")}</p>
      <p style="margin:0;color:#94a3b8;font-size:12px">${f.action_taken}</p>
    </div>
  `;
}

// ── Public senders ────────────────────────────────────────────────────────────

export async function sendIssueAlert(issues: DetectedIssue[]): Promise<void> {
  try {
    const cfg = await loadEmailConfig();
    if (!isConfigured(cfg)) return;

    const subject = `⚠️ Solana Scanner Agent — ${issues.length} issue${issues.length > 1 ? "s" : ""} detected`;
    const body = `
      <p>${issues.length} pipeline issue${issues.length > 1 ? "s were" : " was"} detected and <strong>auto-fix is being attempted</strong>:</p>
      ${issues.map(issueRow).join("")}
      <p style="margin-top:20px;color:#94a3b8;font-size:13px">
        The agent will attempt to fix these automatically. You will receive another email if fixes succeed or if they require human intervention.
      </p>
    `;

    await send(cfg, subject, wrap("⚠️ Issues Detected", "#1d4ed8", body));
  } catch (err) {
    console.error(LOG, "sendIssueAlert failed:", err);
  }
}

export async function sendFixSuccessAlert(
  fixes: AppliedFix[],
  issues: DetectedIssue[],
): Promise<void> {
  try {
    const cfg = await loadEmailConfig();
    if (!isConfigured(cfg)) return;

    const subject = `✅ Solana Scanner Agent — ${fixes.length} fix${fixes.length > 1 ? "es" : ""} applied`;
    const body = `
      <p>${fixes.length} issue${fixes.length > 1 ? "s were" : " was"} automatically fixed:</p>
      ${fixes.map(f => fixRow(f, true)).join("")}
      <p style="margin-top:20px;color:#94a3b8;font-size:13px">
        All fixes completed successfully. The pipeline should resume normal operation within 1–2 minutes.
      </p>
    `;

    await send(cfg, subject, wrap("✅ Fixes Applied", "#166534", body));
  } catch (err) {
    console.error(LOG, "sendFixSuccessAlert failed:", err);
  }
}

export async function sendFixFailureAlert(
  failed: AppliedFix[],
  issues: DetectedIssue[],
): Promise<void> {
  try {
    const cfg = await loadEmailConfig();
    if (!isConfigured(cfg)) return;

    const subject = `❌ Solana Scanner Agent — ${failed.length} fix${failed.length > 1 ? "es" : ""} failed`;
    const body = `
      <p><strong style="color:#f87171">${failed.length} fix attempt${failed.length > 1 ? "s" : ""} did not resolve the issue</strong>. Human review may be required:</p>
      ${failed.map(f => fixRow(f, false)).join("")}
      <p style="margin-top:20px;color:#94a3b8;font-size:13px">
        The agent will continue monitoring and retry automatically. If the issue persists, log in to Railway and check the service logs.
      </p>
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
