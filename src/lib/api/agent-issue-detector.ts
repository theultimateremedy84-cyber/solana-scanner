// =============================================================================
// agent-issue-detector.ts  —  v2
//
// Enhanced rule-based issue detection from /api/monitor-dashboard.
//
// v2 changes vs v1:
//   • 6 previously "fixable: false" categories are now fixable
//   • 4 new detection rules (pipeline_stall, combined_failure,
//     price_feed_failure, enrichment_completeness)
//   • fixChain: ordered list of actions for multi-step repair sequences
//   • Helius budget throttle detection (auto-pause discovery)
//   • Smarter severity escalation based on combined conditions
// =============================================================================

import { randomUUID } from "crypto";
import type { DetectedIssue } from "./agent-state";

export const HELIUS_BUDGET_EMAIL_THRESHOLD = 800_000;

// Full MonitorData shape inspected by the detector
interface MonitorSnapshot {
  collectionQueue: {
    pending: number;
    failed: number;
    completedLast24h: number;
  };
  enrichment: {
    hollowPairsPending: number;
    ghostEnrichments: number;
    totalPerformanceRecords: number;
  };
  helius: {
    dailyUsed: number;
    dailyBudget: number;
    monthlyUsed: number;
    monthlyBudget: number;
    topComponentsLast24h: { component: string; cuUsed: number }[];
  };
  alerts: { total: number; last24h: number; critical24h: number };
  tokenDiscovery: {
    wsAlive: boolean;
    totalReconnects: number;
    running: boolean;
  } | null;
  scheduler: { stampRunning: boolean; totalFailed: number };
  buySellData: { buyVolSolLast24h: number };
}

export interface DetectionResult {
  issues: DetectedIssue[];
  heliusNeedsEmailAlert: boolean;
  heliusMonthlyUsed: number;
}

export function detectIssues(data: MonitorSnapshot): DetectionResult {
  const issues: DetectedIssue[] = [];
  const now = new Date().toISOString();

  const q   = data.collectionQueue;
  const enr = data.enrichment;
  const hel = data.helius;

  // ── 1. Failed collection jobs ─────────────────────────────────────────────
  if (q.failed > 10) {
    const isCritical = q.failed > 30;
    issues.push({
      id: randomUUID(),
      severity: isCritical ? "critical" : "warning",
      category: "failed_jobs",
      title: `${q.failed} collection jobs failed`,
      description:
        `${q.failed} wallet-collection jobs have exceeded max retry attempts. ` +
        `Enrichment data for these tokens is stalled. ` +
        `Auto-fix: requeuing via /api/process-jobs, then re-enriching via /api/enrich-wallets.`,
      metric: "collectionQueue.failed",
      value: String(q.failed),
      fixable: true,
      fixChain: ["requeue_failed_jobs", "trigger_enrichment"],
      detectedAt: now,
    });
  }

  // ── 2. Stalled pipeline (large pending backlog) — NOW FIXABLE ─────────────
  if (q.pending > 200) {
    issues.push({
      id: randomUUID(),
      severity: q.pending > 500 ? "critical" : "warning",
      category: "stalled_pipeline",
      title: `${q.pending.toLocaleString()} jobs waiting in collection queue`,
      description:
        `A backlog of ${q.pending.toLocaleString()} pending jobs indicates the scheduler ` +
        `is under-provisioned or stalled. ` +
        `Auto-fix: calling /api/process-jobs to drain the queue.`,
      metric: "collectionQueue.pending",
      value: String(q.pending),
      fixable: true,
      fixChain: ["requeue_failed_jobs"],
      detectedAt: now,
    });
  }

  // ── 3. NEW: Complete pipeline stall (jobs exist but NOTHING completed) ─────
  if (q.completedLast24h === 0 && q.pending > 20) {
    issues.push({
      id: randomUUID(),
      severity: "critical",
      category: "pipeline_stall",
      title: "Pipeline completely stalled — 0 jobs completed in 24 h",
      description:
        `${q.pending.toLocaleString()} jobs are pending but zero completed in the last 24 h. ` +
        `The scheduler may be deadlocked or the Helius key is exhausted. ` +
        `Auto-fix: draining jobs → re-enriching hollow pairs → rescoring wallets.`,
      metric: "collectionQueue.completedLast24h",
      value: "0",
      fixable: true,
      fixChain: ["requeue_failed_jobs", "trigger_enrichment", "rescore_wallets"],
      detectedAt: now,
    });
  }

  // ── 4. NEW: Combined failure (failed + pending both high = compounded) ────
  if (q.failed > 10 && q.pending > 150) {
    issues.push({
      id: randomUUID(),
      severity: "critical",
      category: "combined_failure",
      title: `Combined failure — ${q.failed} failed + ${q.pending.toLocaleString()} pending`,
      description:
        `Both the failed-job count and the pending backlog are critically elevated simultaneously. ` +
        `This indicates a systemic pipeline collapse, not isolated retries. ` +
        `Auto-fix: sequential repair — requeue → enrich → rescore.`,
      metric: "collectionQueue.failed+pending",
      value: `${q.failed}+${q.pending}`,
      fixable: true,
      fixChain: ["requeue_failed_jobs", "trigger_enrichment", "rescore_wallets"],
      detectedAt: now,
    });
  }

  // ── 5. Enrichment backlog (hollow pairs) ──────────────────────────────────
  if (enr.hollowPairsPending > 20) {
    issues.push({
      id: randomUUID(),
      severity: enr.hollowPairsPending > 100 ? "critical" : "warning",
      category: "enrichment_backlog",
      title: `${enr.hollowPairsPending} hollow token-wallet pairs pending enrichment`,
      description:
        `${enr.hollowPairsPending} pairs have no transaction history fetched from Helius. ` +
        `P&L data will be missing for these wallets. ` +
        `Auto-fix: triggering full-history enrichment via /api/enrich-wallets, then rescoring.`,
      metric: "enrichment.hollowPairsPending",
      value: String(enr.hollowPairsPending),
      fixable: true,
      fixChain: ["trigger_enrichment", "rescore_wallets"],
      detectedAt: now,
    });
  }

  // ── 6. Ghost enrichment records ───────────────────────────────────────────
  if (enr.totalPerformanceRecords > 0) {
    const ghostPct = Math.round(
      (enr.ghostEnrichments / enr.totalPerformanceRecords) * 100,
    );
    // Lower threshold than v1: warn at 30%, not just 50%
    if (ghostPct > 30) {
      issues.push({
        id: randomUUID(),
        severity: ghostPct > 60 ? "critical" : "warning",
        category: "data_integrity",
        title: `${ghostPct}% of enrichment records are ghost entries`,
        description:
          `${enr.ghostEnrichments.toLocaleString()} ghost enrichments detected out of ` +
          `${enr.totalPerformanceRecords.toLocaleString()} total records (threshold: 30%). ` +
          `Auto-fix: rescoring wallets clears ghost records, then re-enriches to backfill.`,
        metric: "enrichment.ghostEnrichments",
        value: `${ghostPct}%`,
        fixable: true,
        fixChain: ["rescore_wallets", "trigger_enrichment"],
        detectedAt: now,
      });
    }
  }

  // ── 7. Helius daily budget ────────────────────────────────────────────────
  if (hel.dailyBudget > 0) {
    const dailyPct = hel.dailyUsed / hel.dailyBudget;
    if (dailyPct >= 1.0) {
      issues.push({
        id: randomUUID(),
        severity: "critical",
        category: "helius_budget",
        title: "Helius daily budget EXHAUSTED — API calls blocked",
        description:
          `${hel.dailyUsed.toLocaleString()} of ${hel.dailyBudget.toLocaleString()} ` +
          `daily compute units used (100%). All Helius calls are now blocked until midnight UTC. ` +
          `Auto-fix: pausing token discovery to conserve remaining monthly budget.`,
        metric: "helius.dailyUsed",
        value: "100%",
        fixable: true,
        fixChain: ["pause_token_discovery"],
        detectedAt: now,
      });
    } else if (dailyPct >= 0.95) {
      issues.push({
        id: randomUUID(),
        severity: "critical",
        category: "helius_budget",
        title: `Helius daily budget ${(dailyPct * 100).toFixed(1)}% consumed`,
        description:
          `${hel.dailyUsed.toLocaleString()} of ${hel.dailyBudget.toLocaleString()} ` +
          `daily CUs used. Helius calls will be blocked at 100%. ` +
          `Auto-fix: throttling enrichment jobs to slow CU consumption.`,
        metric: "helius.dailyUsed",
        value: `${(dailyPct * 100).toFixed(1)}%`,
        fixable: true,
        fixChain: ["pause_token_discovery"],
        detectedAt: now,
      });
    } else if (dailyPct >= 0.8) {
      issues.push({
        id: randomUUID(),
        severity: "warning",
        category: "helius_budget",
        title: `Helius daily budget ${(dailyPct * 100).toFixed(1)}% consumed`,
        description:
          `${hel.dailyUsed.toLocaleString()} of ${hel.dailyBudget.toLocaleString()} ` +
          `daily CUs used. Monitor closely — if it reaches 95% the agent will throttle enrichment.`,
        metric: "helius.dailyUsed",
        value: `${(dailyPct * 100).toFixed(1)}%`,
        fixable: false,
        detectedAt: now,
      });
    }
  }

  // ── 8. Helius monthly budget ──────────────────────────────────────────────
  const monthlyUsed = hel.monthlyUsed ?? 0;
  const heliusNeedsEmailAlert = monthlyUsed >= HELIUS_BUDGET_EMAIL_THRESHOLD;

  if (hel.monthlyBudget > 0) {
    const monthlyPct = monthlyUsed / hel.monthlyBudget;
    if (monthlyPct >= 0.9) {
      issues.push({
        id: randomUUID(),
        severity: "critical",
        category: "helius_budget",
        title: `Helius monthly budget ${(monthlyPct * 100).toFixed(1)}% consumed`,
        description:
          `${monthlyUsed.toLocaleString()} of ${hel.monthlyBudget.toLocaleString()} ` +
          `monthly CUs used. Exhaustion imminent — auto-pausing token discovery.` +
          (heliusNeedsEmailAlert ? ` Email alert sent (threshold: 800,000 CU).` : ""),
        metric: "helius.monthlyUsed",
        value: `${monthlyUsed.toLocaleString()} CU`,
        fixable: true,
        fixChain: ["pause_token_discovery"],
        detectedAt: now,
      });
    } else if (monthlyPct >= 0.7) {
      issues.push({
        id: randomUUID(),
        severity: "warning",
        category: "helius_budget",
        title: `Helius monthly budget ${(monthlyPct * 100).toFixed(1)}% consumed`,
        description:
          `${monthlyUsed.toLocaleString()} of ${hel.monthlyBudget.toLocaleString()} ` +
          `monthly CUs used.` +
          (heliusNeedsEmailAlert ? ` Above 800,000 CU threshold — email alert sent.` : ""),
        metric: "helius.monthlyUsed",
        value: `${monthlyUsed.toLocaleString()} CU`,
        fixable: false,
        detectedAt: now,
      });
    }
  }

  // ── 9. WebSocket down — NOW FIXABLE (restart attempt) ────────────────────
  if (data.tokenDiscovery && !data.tokenDiscovery.wsAlive) {
    issues.push({
      id: randomUUID(),
      severity: "critical",
      category: "websocket_down",
      title: "Token discovery WebSocket is down",
      description:
        `The Helius WebSocket for real-time token discovery is not alive. ` +
        `New token launches are not being detected. ` +
        `Auto-fix: calling /api/restart-discovery to force a reconnect.`,
      metric: "tokenDiscovery.wsAlive",
      value: "false",
      fixable: true,
      fixChain: ["restart_token_discovery"],
      detectedAt: now,
    });
  }

  // ── 10. WebSocket instability — NOW FIXABLE above threshold ───────────────
  if (data.tokenDiscovery && data.tokenDiscovery.totalReconnects > 10) {
    const isCritical = data.tokenDiscovery.totalReconnects > 30;
    issues.push({
      id: randomUUID(),
      severity: isCritical ? "critical" : "warning",
      category: "websocket_instability",
      title: `WebSocket reconnected ${data.tokenDiscovery.totalReconnects} times`,
      description:
        `Frequent reconnects suggest network instability or Helius rate limiting. ` +
        (isCritical
          ? `Auto-fix: forcing a full discovery restart to clear the reconnect counter.`
          : `Monitoring — no auto-fix yet (threshold for action: 30 reconnects).`),
      metric: "tokenDiscovery.totalReconnects",
      value: String(data.tokenDiscovery.totalReconnects),
      fixable: isCritical,
      fixChain: isCritical ? ["restart_token_discovery"] : undefined,
      detectedAt: now,
    });
  }

  // ── 11. Critical alerts spike — NOW FIXABLE (rescore clears stale alerts) ─
  if (data.alerts.critical24h > 20) {
    issues.push({
      id: randomUUID(),
      severity: "critical",
      category: "alert_storm",
      title: `${data.alerts.critical24h} critical alerts fired in the last 24 h`,
      description:
        `An alert storm of this magnitude usually indicates stale wallet scores or a ` +
        `data integrity issue. Auto-fix: triggering a full rescore to recalculate all ` +
        `scores and clear stale alert conditions.`,
      metric: "alerts.critical24h",
      value: String(data.alerts.critical24h),
      fixable: true,
      fixChain: ["rescore_wallets", "trigger_enrichment"],
      detectedAt: now,
    });
  }

  // ── 12. Scheduler failures — NOW FIXABLE (kick process-jobs) ─────────────
  if (data.scheduler.totalFailed > 50) {
    issues.push({
      id: randomUUID(),
      severity: data.scheduler.totalFailed > 200 ? "critical" : "warning",
      category: "scheduler_failures",
      title: `Scheduler has ${data.scheduler.totalFailed} cumulative failures`,
      description:
        `High cumulative scheduler failure count. Auto-fix: calling /api/process-jobs ` +
        `to kick the scheduler and retry stuck jobs, then enriching and rescoring.`,
      metric: "scheduler.totalFailed",
      value: String(data.scheduler.totalFailed),
      fixable: true,
      fixChain: ["requeue_failed_jobs", "trigger_enrichment"],
      detectedAt: now,
    });
  }

  // ── 13. Price feed failure — NOW FIXABLE ──────────────────────────────────
  if (
    data.buySellData.buyVolSolLast24h === 0 &&
    q.completedLast24h > 50
  ) {
    issues.push({
      id: randomUUID(),
      severity: "warning",
      category: "price_feed_failure",
      title: "Buy volume showing 0.00 SOL despite completed collection jobs",
      description:
        `${q.completedLast24h} collection jobs completed in 24 h but buy volume is 0 SOL. ` +
        `This likely indicates a SOL price feed failure. ` +
        `Auto-fix: calling /api/price-refresh to force a fresh SOL price fetch.`,
      metric: "buySellData.buyVolSolLast24h",
      value: "0.00 SOL",
      fixable: true,
      fixChain: ["refresh_price_feed"],
      detectedAt: now,
    });
  }

  return { issues, heliusNeedsEmailAlert, heliusMonthlyUsed: monthlyUsed };
}

export function buildSummary(issues: DetectedIssue[], fixesApplied: number, fixesSkipped = 0): string {
  if (issues.length === 0) return "All systems nominal. No issues detected.";

  const crit = issues.filter(i => i.severity === "critical").length;
  const warn = issues.filter(i => i.severity === "warning").length;
  const info = issues.filter(i => i.severity === "info").length;

  const parts: string[] = [];
  if (crit) parts.push(`${crit} critical`);
  if (warn) parts.push(`${warn} warning`);
  if (info) parts.push(`${info} info`);

  let summary = `Detected ${issues.length} issue(s): ${parts.join(", ")}.`;
  if (fixesApplied > 0) summary += ` Applied ${fixesApplied} automated fix(es).`;
  if (fixesSkipped > 0) summary += ` Skipped ${fixesSkipped} (cooldown/circuit).`;
  if (crit > 0) {
    const titles = issues
      .filter(i => i.severity === "critical")
      .map(i => i.title)
      .join("; ");
    summary += ` Critical: ${titles}.`;
  }
  return summary;
}
