// =============================================================================
// agent-fixer.ts  —  v2.1
//
// Enhanced autonomous fix engine.
//
// v2.1 changes vs v2:
//   • fixGhostEnrichment: treat AbortError/TimeoutError as "triggered" — the
//     full rescore of 52k+ wallets takes ~11 min; the 120s HTTP timeout fired
//     before completion, causing false failures and tripping the circuit breaker.
//     The background RescoreScheduler (every 20 min) always completes the work.
//   • fixEnrichmentBacklog: same timeout-as-triggered treatment — enrichment
//     via /api/enrich-wallets can take >120s when Helius is slow.
//   • fixRestartTokenDiscovery: detect when ENABLE_TOKEN_DISCOVERY is not "true"
//     (intentionally paused) and return a non-failure "paused" result instead of
//     hammering /api/discovery-control and opening the circuit breaker on a
//     service that was never started.
//
// v2 changes vs v1:
//   • 6 new fix handlers: stalled_pipeline, pipeline_stall, combined_failure,
//     alert_storm, scheduler_failures, price_feed_failure, websocket restart,
//     Helius budget throttle (pause_token_discovery)
//   • Fix chains: multi-step sequential repair (e.g. process-jobs →
//     enrich-wallets → rescore-wallets) for compound issues
//   • Cooldown: checks agent_fix_log in Supabase — won't re-apply the same
//     fix within the cooldown window (default 15 min), even after restart
//   • Circuit breaker integration: skips fixes for open circuits
//   • Post-fix verification: re-fetches the monitor metric ~30 s after
//     fixing and records whether it improved
//   • Structured result: every AppliedFix now includes metricBefore,
//     metricAfter, improved, circuitOpened, skippedReason
// =============================================================================

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { isCircuitOpen, recordFixAttempt, closeCircuit } from "./agent-circuit-breaker";
import { agentState } from "./agent-state";
import type { DetectedIssue, AppliedFix } from "./agent-state";

const LOG = "[agent-fixer]";

// ── Config (loaded once per run from agent_settings) ─────────────────────────

interface FixerConfig {
  cooldownMinutes: number;
  verifyDelaySeconds: number;
  circuitFailureThreshold: number;
  circuitWindowMinutes: number;
  circuitResetHours: number;
}

async function loadFixerConfig(): Promise<FixerConfig> {
  const { data } = await supabaseAdmin
    .from("agent_settings")
    .select("fix_cooldown_minutes, verify_fix_delay_seconds, circuit_failure_threshold, circuit_window_minutes, circuit_reset_hours")
    .eq("id", "default")
    .single();

  const d = (data ?? {}) as Record<string, unknown>;
  return {
    cooldownMinutes:         (d.fix_cooldown_minutes as number)        ?? 15,
    verifyDelaySeconds:      (d.verify_fix_delay_seconds as number)    ?? 30,
    circuitFailureThreshold: (d.circuit_failure_threshold as number)   ?? 3,
    circuitWindowMinutes:    (d.circuit_window_minutes as number)      ?? 90,
    circuitResetHours:       (d.circuit_reset_hours as number)         ?? 2,
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function baseUrl(): string {
  const port = process.env.PORT ?? "3000";
  return `http://localhost:${port}`;
}

function cronHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-cron-secret": process.env.CRON_SECRET ?? "",
  };
}

async function callEndpoint(
  method: "POST" | "GET",
  path: string,
  timeoutMs = 90_000,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: cronHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

// ── Timeout detection helper ──────────────────────────────────────────────────
// AbortSignal.timeout() throws a DOMException with name "TimeoutError".
// In some Node versions it surfaces as "AbortError". Detect both.
function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "TimeoutError" || err.name === "AbortError";
}

// ── Cooldown check (Supabase-backed, survives restarts) ───────────────────────

async function isOnCooldown(category: string, cooldownMinutes: number): Promise<boolean> {
  // Fast path: in-memory check
  if (agentState.isOnCooldown(category, cooldownMinutes)) return true;

  // Supabase check (authoritative across restarts)
  const since = new Date(Date.now() - cooldownMinutes * 60_000).toISOString();
  const { data } = await supabaseAdmin
    .from("agent_fix_log")
    .select("applied_at")
    .eq("category", category)
    .eq("success", true)
    .gte("applied_at", since)
    .limit(1);

  return (data ?? []).length > 0;
}

// ── Post-fix verification (re-fetch metric and check if it improved) ──────────

const MONITOR_URL =
  "https://solana-scanner-production-e838.up.railway.app/api/monitor-dashboard";

async function fetchMetricAfterFix(
  metricKey: string,
  delaySeconds: number,
): Promise<string | null> {
  await new Promise(r => setTimeout(r, delaySeconds * 1000));
  try {
    const res = await fetch(MONITOR_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as Record<string, unknown>;

    // Resolve dot-notation metric key (e.g. "collectionQueue.failed")
    const parts = metricKey.split(".");
    let val: unknown = data;
    for (const part of parts) {
      if (val && typeof val === "object") {
        val = (val as Record<string, unknown>)[part];
      } else {
        return null;
      }
    }
    return val != null ? String(val) : null;
  } catch {
    return null;
  }
}

function metricImproved(before: string, after: string, metricKey: string): boolean {
  // For most metrics, lower is better
  const lowerIsBetter = [
    "collectionQueue.failed",
    "collectionQueue.pending",
    "enrichment.hollowPairsPending",
    "enrichment.ghostEnrichments",
    "alerts.critical24h",
    "scheduler.totalFailed",
    "tokenDiscovery.totalReconnects",
  ];
  // For some, higher is better
  const higherIsBetter = [
    "collectionQueue.completedLast24h",
    "buySellData.buyVolSolLast24h",
    "tokenDiscovery.wsAlive",
  ];

  const bNum = parseFloat(before);
  const aNum = parseFloat(after);

  if (isNaN(bNum) || isNaN(aNum)) {
    // Boolean metrics
    if (before === "false" && after === "true") return true;
    if (before === "true" && after === "false") return false;
    return false;
  }

  if (lowerIsBetter.includes(metricKey)) return aNum < bNum;
  if (higherIsBetter.includes(metricKey)) return aNum > bNum;
  return aNum < bNum; // default: lower is better
}

// ── Individual fix handlers ───────────────────────────────────────────────────

async function fixFailedJobs(issue: DetectedIssue): Promise<Omit<AppliedFix, "improved" | "metricAfter" | "circuitOpened">> {
  console.log(LOG, `Calling /api/process-jobs — ${issue.value} failed jobs`);
  try {
    const { ok, status, body } = await callEndpoint("POST", "/api/process-jobs");
    if (!ok) throw new Error(`HTTP ${status}: ${JSON.stringify(body)}`);
    return {
      issueId: issue.id,
      action: "requeue_failed_jobs",
      description: `✅ /api/process-jobs called. ${issue.value} failed jobs requeued for retry.`,
      githubCommitUrl: null,
      success: true,
      error: null,
      metricBefore: issue.value,
      skippedReason: null,
    };
  } catch (err) {
    return {
      issueId: issue.id,
      action: "requeue_failed_jobs",
      description: `❌ /api/process-jobs failed`,
      githubCommitUrl: null,
      success: false,
      error: String(err),
      metricBefore: issue.value,
      skippedReason: null,
    };
  }
}

async function fixEnrichmentBacklog(issue: DetectedIssue): Promise<Omit<AppliedFix, "improved" | "metricAfter" | "circuitOpened">> {
  console.log(LOG, `Calling /api/enrich-wallets — ${issue.value} hollow pairs`);
  try {
    const { ok, status, body } = await callEndpoint("POST", "/api/enrich-wallets", 120_000);
    if (!ok) throw new Error(`HTTP ${status}: ${JSON.stringify(body)}`);
    return {
      issueId: issue.id,
      action: "trigger_enrichment",
      description: `✅ /api/enrich-wallets called. Helius full-history enrichment triggered for ${issue.value} hollow pairs.`,
      githubCommitUrl: null,
      success: true,
      error: null,
      metricBefore: issue.value,
      skippedReason: null,
    };
  } catch (err) {
    // If the HTTP call timed out, enrichment IS running in the background.
    // The EnrichUnenrichedScheduler processes hollow pairs continuously every
    // 1 minute regardless of this API call. Treat timeout as "triggered" so
    // the circuit breaker doesn't open on a healthy background process.
    if (isTimeoutError(err)) {
      console.warn(LOG, `trigger_enrichment HTTP call timed out — enrichment is running in background via EnrichUnenrichedScheduler`);
      return {
        issueId: issue.id,
        action: "trigger_enrichment",
        description: `⏱ /api/enrich-wallets triggered (response timed out after 120s, but enrichment IS running). The EnrichUnenrichedScheduler processes hollow pairs continuously every minute. Hollow pair count will decrease gradually.`,
        githubCommitUrl: null,
        success: true,
        error: null,
        metricBefore: issue.value,
        skippedReason: null,
      };
    }
    return {
      issueId: issue.id,
      action: "trigger_enrichment",
      description: `❌ /api/enrich-wallets failed`,
      githubCommitUrl: null,
      success: false,
      error: String(err),
      metricBefore: issue.value,
      skippedReason: null,
    };
  }
}

async function fixGhostEnrichment(issue: DetectedIssue): Promise<Omit<AppliedFix, "improved" | "metricAfter" | "circuitOpened">> {
  console.log(LOG, `Calling /api/rescore-wallets — ${issue.value} ghost rate`);
  try {
    // The full rescore of 52k+ wallets takes ~11 minutes. Our HTTP timeout is
    // 120s. If the call times out it means the rescore IS running — the
    // background RescoreScheduler (every 20 min) will also complete it.
    // Treat TimeoutError as "triggered" so the circuit breaker stays closed.
    const { ok, status, body } = await callEndpoint("POST", "/api/rescore-wallets", 120_000);
    if (!ok) throw new Error(`HTTP ${status}: ${JSON.stringify(body)}`);
    return {
      issueId: issue.id,
      action: "rescore_wallets",
      description: `✅ /api/rescore-wallets called. Wallet rescoring initiated (${issue.value} ghost rate).`,
      githubCommitUrl: null,
      success: true,
      error: null,
      metricBefore: issue.value,
      skippedReason: null,
    };
  } catch (err) {
    // Timeout = rescore started but takes ~11 min to complete 52k wallets.
    // The RescoreScheduler runs every 20 min in the background regardless.
    // Record as "triggered" so the circuit breaker doesn't open falsely.
    if (isTimeoutError(err)) {
      console.warn(LOG, `rescore_wallets HTTP call timed out after 120s — rescore IS running in background (~11 min for 52k wallets). RescoreScheduler also runs every 20 min.`);
      return {
        issueId: issue.id,
        action: "rescore_wallets",
        description: `⏱ /api/rescore-wallets triggered (response timed out — rescore takes ~11 min for 52k+ wallets, which exceeds the 120s HTTP timeout). The background RescoreScheduler will complete it within 20 min. Ghost rate will update on the next agent poll.`,
        githubCommitUrl: null,
        success: true,
        error: null,
        metricBefore: issue.value,
        skippedReason: null,
      };
    }
    return {
      issueId: issue.id,
      action: "rescore_wallets",
      description: `❌ /api/rescore-wallets failed`,
      githubCommitUrl: null,
      success: false,
      error: String(err),
      metricBefore: issue.value,
      skippedReason: null,
    };
  }
}

async function fixPriceFeed(issue: DetectedIssue): Promise<Omit<AppliedFix, "improved" | "metricAfter" | "circuitOpened">> {
  console.log(LOG, `Calling /api/price-refresh — SOL price feed may be stale`);
  try {
    const { ok, status, body } = await callEndpoint("POST", "/api/price-refresh");
    if (!ok) throw new Error(`HTTP ${status}: ${JSON.stringify(body)}`);
    return {
      issueId: issue.id,
      action: "refresh_price_feed",
      description: `✅ /api/price-refresh called. SOL price feed refreshed — buy volume should recalculate within minutes.`,
      githubCommitUrl: null,
      success: true,
      error: null,
      metricBefore: issue.value,
      skippedReason: null,
    };
  } catch (err) {
    return {
      issueId: issue.id,
      action: "refresh_price_feed",
      description: `❌ /api/price-refresh failed`,
      githubCommitUrl: null,
      success: false,
      error: String(err),
      metricBefore: issue.value,
      skippedReason: null,
    };
  }
}

async function fixPauseTokenDiscovery(issue: DetectedIssue): Promise<Omit<AppliedFix, "improved" | "metricAfter" | "circuitOpened">> {
  // Helius budget exhaustion: pause token discovery to stop burning CUs.
  // The endpoint /api/discovery-status?action=pause is called if it exists.
  // Falls back to logging a clear action item if the endpoint is not wired.
  console.log(LOG, `Helius budget critical — attempting to pause token discovery`);
  try {
    const res = await fetch(`${baseUrl()}/api/discovery-control`, {
      method: "POST",
      headers: { ...cronHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ action: "pause" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      return {
        issueId: issue.id,
        action: "pause_token_discovery",
        description: `✅ Token discovery paused via /api/discovery-control. Helius CU consumption reduced.`,
        githubCommitUrl: null,
        success: true,
        error: null,
        metricBefore: issue.value,
        skippedReason: null,
      };
    }
    // Endpoint not yet wired — record a structured action item
    throw new Error(`HTTP ${res.status} — /api/discovery-control not yet wired. Set ENABLE_TOKEN_DISCOVERY=false in Railway to pause manually.`);
  } catch (err) {
    return {
      issueId: issue.id,
      action: "pause_token_discovery",
      description: `⚠️ Could not auto-pause token discovery. Manual action required: set ENABLE_TOKEN_DISCOVERY=false in Railway Variables to stop Helius CU consumption.`,
      githubCommitUrl: null,
      success: false,
      error: String(err),
      metricBefore: issue.value,
      skippedReason: null,
    };
  }
}

async function fixRestartTokenDiscovery(issue: DetectedIssue): Promise<Omit<AppliedFix, "improved" | "metricAfter" | "circuitOpened">> {
  // ── Guard: discovery intentionally paused ───────────────────────────────────
  // server.ts only calls startTokenDiscovery() when ENABLE_TOKEN_DISCOVERY === "true".
  // If that env var is absent or set to anything else, the WebSocket is never
  // opened — so calling /api/discovery-control?action=restart will always fail
  // and the circuit breaker will open after 3 attempts. Detect this state and
  // return an informational non-failure result instead so the circuit stays closed
  // and the agent doesn't spam restart attempts against a paused service.
  if (process.env.ENABLE_TOKEN_DISCOVERY !== "true") {
    console.log(
      LOG,
      `Token discovery is intentionally paused ` +
      `(ENABLE_TOKEN_DISCOVERY="${process.env.ENABLE_TOKEN_DISCOVERY ?? "unset"}") — ` +
      `skipping restart attempt. Set ENABLE_TOKEN_DISCOVERY=true in Railway Variables to resume.`,
    );
    return {
      issueId: issue.id,
      action: "restart_token_discovery",
      description:
        `ℹ️ Token discovery is intentionally paused — ENABLE_TOKEN_DISCOVERY is not set to "true" in Railway Variables. ` +
        `No restart attempted (it would fail regardless). ` +
        `The WebSocket will show as "down" until you set ENABLE_TOKEN_DISCOVERY=true and redeploy. ` +
        `This is expected while letting the enrichment backlog drain.`,
      githubCommitUrl: null,
      success: true,   // not a failure — intentional paused state
      error: null,
      metricBefore: issue.value,
      skippedReason: null,
    };
  }

  // ── Normal path: discovery should be running, attempt a restart ────────────
  console.log(LOG, `WebSocket down — calling /api/discovery-control restart`);
  try {
    const res = await fetch(`${baseUrl()}/api/discovery-control`, {
      method: "POST",
      headers: { ...cronHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ action: "restart" }),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) {
      return {
        issueId: issue.id,
        action: "restart_token_discovery",
        description: `✅ Token discovery restart triggered via /api/discovery-control. WebSocket reconnect in progress.`,
        githubCommitUrl: null,
        success: true,
        error: null,
        metricBefore: issue.value,
        skippedReason: null,
      };
    }
    throw new Error(`HTTP ${res.status} — /api/discovery-control not yet wired. The service will auto-reconnect; check Railway logs if WS stays down > 10 min.`);
  } catch (err) {
    return {
      issueId: issue.id,
      action: "restart_token_discovery",
      description: `⚠️ WebSocket restart not available via API. Relying on built-in auto-reconnect. Monitor Railway logs for reconnect confirmation.`,
      githubCommitUrl: null,
      success: false,
      error: String(err),
      metricBefore: issue.value,
      skippedReason: null,
    };
  }
}

// ── Fix chain executor ────────────────────────────────────────────────────────

/**
 * Execute a fix chain (ordered list of actions) for a single issue.
 * Each action in the chain is run sequentially; if one fails the rest are skipped.
 */
async function executeFixChain(
  issue: DetectedIssue,
  chain: string[],
): Promise<Omit<AppliedFix, "improved" | "metricAfter" | "circuitOpened">[]> {
  const results: Omit<AppliedFix, "improved" | "metricAfter" | "circuitOpened">[] = [];

  for (const action of chain) {
    let result: Omit<AppliedFix, "improved" | "metricAfter" | "circuitOpened">;

    switch (action) {
      case "requeue_failed_jobs":
        result = await fixFailedJobs(issue);
        break;
      case "trigger_enrichment":
        result = await fixEnrichmentBacklog(issue);
        break;
      case "rescore_wallets":
        result = await fixGhostEnrichment(issue);
        break;
      case "refresh_price_feed":
        result = await fixPriceFeed(issue);
        break;
      case "pause_token_discovery":
        result = await fixPauseTokenDiscovery(issue);
        break;
      case "restart_token_discovery":
        result = await fixRestartTokenDiscovery(issue);
        break;
      default:
        result = {
          issueId: issue.id,
          action,
          description: `No handler registered for action '${action}'.`,
          githubCommitUrl: null,
          success: false,
          error: "Unhandled action",
          metricBefore: issue.value,
          skippedReason: null,
        };
    }

    results.push(result);
    // If a step in the chain failed, stop — no point continuing
    if (!result.success) {
      console.warn(LOG, `Fix chain aborted at action '${action}' (step failed)`);
      break;
    }
    // Brief gap between chain steps
    if (chain.indexOf(action) < chain.length - 1) {
      await new Promise(r => setTimeout(r, 3_000));
    }
  }

  return results;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function applyFixes(issues: DetectedIssue[]): Promise<AppliedFix[]> {
  const fixable = issues.filter(i => i.fixable);
  if (fixable.length === 0) {
    console.log(LOG, "No fixable issues — nothing to do");
    return [];
  }

  const config = await loadFixerConfig();
  const circuitConfig = {
    failureThreshold: config.circuitFailureThreshold,
    windowMinutes:    config.circuitWindowMinutes,
    resetHours:       config.circuitResetHours,
  };

  console.log(LOG, `Processing ${fixable.length} fixable issue(s)...`);
  const allResults: AppliedFix[] = [];

  // De-duplicate fix chains: if two issues share the same actions, run once
  const actionsSeen = new Set<string>();

  for (const issue of fixable) {
    const chain = issue.fixChain ?? [defaultActionForCategory(issue.category)];

    // ── Circuit breaker check ───────────────────────────────────────────────
    if (await isCircuitOpen(issue.category)) {
      console.warn(LOG, `Circuit OPEN for '${issue.category}' — skipping`);
      allResults.push({
        issueId: issue.id,
        action: "circuit_open",
        description:
          `⚡ Circuit breaker is OPEN for category '${issue.category}'. ` +
          `This fix has failed repeatedly without improvement and is suspended ` +
          `to avoid hammering a broken endpoint. It will auto-reset in ≤2 h.`,
        githubCommitUrl: null,
        success: false,
        error: null,
        metricBefore: issue.value,
        metricAfter: null,
        improved: null,
        circuitOpened: false,
        skippedReason: "circuit_open",
      });
      continue;
    }

    // ── Cooldown check ──────────────────────────────────────────────────────
    if (await isOnCooldown(issue.category, config.cooldownMinutes)) {
      console.log(LOG, `'${issue.category}' is on cooldown (${config.cooldownMinutes} min) — skipping`);
      allResults.push({
        issueId: issue.id,
        action: "cooldown",
        description:
          `⏳ Fix for '${issue.category}' skipped — within ${config.cooldownMinutes}-minute cooldown window. ` +
          `The previous fix attempt was too recent; waiting before retrying.`,
        githubCommitUrl: null,
        success: false,
        error: null,
        metricBefore: issue.value,
        metricAfter: null,
        improved: null,
        circuitOpened: false,
        skippedReason: "cooldown",
      });
      continue;
    }

    // ── De-duplicate actions ────────────────────────────────────────────────
    const chainKey = chain.join("+");
    if (actionsSeen.has(chainKey)) {
      console.log(LOG, `Fix chain '${chainKey}' already applied this run — skipping duplicate`);
      continue;
    }
    actionsSeen.add(chainKey);

    // ── Execute the fix chain ───────────────────────────────────────────────
    const chainResults = await executeFixChain(issue, chain);
    const primaryResult = chainResults[chainResults.length - 1]; // last step = verdict
    const overallSuccess = chainResults.every(r => r.success);

    agentState.markFixApplied(issue.category);

    // ── Post-fix verification ───────────────────────────────────────────────
    let metricAfter: string | null = null;
    let improved: boolean | null = null;

    if (overallSuccess && issue.metric) {
      console.log(LOG, `Waiting ${config.verifyDelaySeconds}s to verify fix for '${issue.category}'...`);
      metricAfter = await fetchMetricAfterFix(issue.metric, config.verifyDelaySeconds);

      if (metricAfter !== null && issue.value !== null) {
        improved = metricImproved(issue.value, metricAfter, issue.metric);
        console.log(
          LOG,
          `Verification: ${issue.metric} ${issue.value} → ${metricAfter} | improved=${improved}`,
        );
        agentState.addVerification({
          category:  issue.category,
          metricKey: issue.metric,
          before:    issue.value,
          after:     metricAfter,
          improved,
          checkedAt: new Date().toISOString(),
        });
        // If metric improved, close any existing circuit
        if (improved) {
          await closeCircuit(issue.category);
        }
      }
    }

    // ── Record in circuit breaker ───────────────────────────────────────────
    const { circuitOpened } = await recordFixAttempt(
      issue.category,
      chain.join("→"),
      overallSuccess,
      issue.metric ?? null,
      issue.value ?? null,
      metricAfter,
      improved,
      circuitConfig,
    );

    // Attach verification results to the primary fix result
    const finalResult: AppliedFix = {
      ...primaryResult,
      metricAfter,
      improved,
      circuitOpened,
      skippedReason: null,
    };

    // If it was a multi-step chain, annotate the description to include all steps
    if (chainResults.length > 1) {
      const steps = chainResults.map((r, i) => `Step ${i + 1} (${r.action}): ${r.success ? "✅" : "❌"}`).join(" | ");
      finalResult.description = `${finalResult.description}\n\nChain: ${steps}`;
    }

    allResults.push(finalResult);

    // Pause between different issues
    if (fixable.indexOf(issue) < fixable.length - 1) {
      await new Promise(r => setTimeout(r, 2_000));
    }
  }

  const succeeded = allResults.filter(r => r.success).length;
  const skipped   = allResults.filter(r => r.skippedReason).length;
  console.log(LOG, `Fixes complete — ${succeeded}/${fixable.length} succeeded, ${skipped} skipped`);
  return allResults;
}

// ── Fallback action resolver ──────────────────────────────────────────────────

function defaultActionForCategory(category: string): string {
  const map: Record<string, string> = {
    failed_jobs:        "requeue_failed_jobs",
    stalled_pipeline:   "requeue_failed_jobs",
    pipeline_stall:     "requeue_failed_jobs",
    enrichment_backlog: "trigger_enrichment",
    data_integrity:     "rescore_wallets",
    alert_storm:        "rescore_wallets",
    scheduler_failures: "requeue_failed_jobs",
    price_feed_failure: "refresh_price_feed",
    websocket_down:     "restart_token_discovery",
    websocket_instability: "restart_token_discovery",
    helius_budget:      "pause_token_discovery",
    combined_failure:   "requeue_failed_jobs",
  };
  return map[category] ?? "no_fix_available";
}
