import "./lib/error-capture";

// ---------------------------------------------------------------------------
// FIX (2026-07-11, healthcheck-hang incident follow-up): there was no
// process-level safety net — an uncaught exception or unhandled promise
// rejection anywhere in the process (including background schedulers running
// outside a request context, where error-capture.ts's listener only records
// the error for the SSR error page but never stops the runtime from acting
// on its default "unhandled" behavior) could take the whole server down.
// These handlers make that class of failure loud in logs instead of fatal.
// They do NOT protect against OOM kills or other OS-level termination.
// ---------------------------------------------------------------------------
process.on("uncaughtException", (err) => {
  console.error("[server] ‼ FATAL-AVOIDED uncaughtException (process kept alive):", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[server] ‼ FATAL-AVOIDED unhandledRejection (process kept alive):", reason);
});

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
// Direct handlers — no @tanstack/react-start/api import, safe to bundle in SSR
import { handlePriceRefreshPost, handlePriceRefreshGet } from "./lib/api/price-refresh-handler";
import { handleEnrichWalletsPost, handleEnrichWalletsGet } from "./lib/api/enrich-handler";
import { handleProcessJobsPost, handleProcessJobsGet } from "./lib/api/process-jobs-handler";
import { startProcessJobsScheduler } from "./lib/api/process-jobs-scheduler";
import { handleDiscoveryStatusGet } from "./lib/api/discovery-status-handler";
import { handleFundingClustersGet } from "./lib/api/funding-clusters-handler";
import { startPriceRefreshScheduler } from "./lib/api/price-refresh-scheduler";
import { startPostLaunchWatcher } from "./lib/postLaunchWatcher";
import { startTokenDiscovery } from "./lib/api/token-discovery";
// PATCH FIX: wire /api/rescore-wallets into the server interceptor so it is
// reachable on Railway (TanStack APIRoute exports are not registered by the
// node-server Nitro preset used in production).
import {
  handleRescoreWalletsPost,
  handleRescoreWalletsGet,
} from "./lib/api/rescore-handler";
// PATCH FIX (audit-6 staleness gap): replaces the old one-shot
// startRescoreOnBoot() with a recurring scheduler so win_rate/average_roi
// never go stale again after the first 10s post-boot rescore.
import { startRescoreScheduler } from "./lib/api/rescore-scheduler";
import { startEnrichUnenrichedScheduler } from "./lib/api/enrich-unenriched-scheduler";
// AUDIT FIX (finding #4): server-validated write path for scan_history —
// replaces the old direct anon-key insert from the browser.
import { handleScanHistoryPost, handleScanHistoryGet } from "./lib/api/scan-history-handler";
// AUDIT FIX (finding #2): daily retention prune for helius_cu_log — table had
// unbounded growth and no index, so even COUNT(*) was timing out.
import { startHeliusCuLogRetentionScheduler } from "./lib/api/helius-cu-log-retention-scheduler";
// MONETIZATION FIX (plan Tasks A10 + A12): graduation tracker — polls
// DexScreener every 30 min for pipeline-discovered tokens and sets
// scan_history.graduated_at when a Raydium pair is found. Enables developer
// graduation-rate scoring. Requires migration 20260716000001 to be applied.
import { startGraduationTracker } from "./lib/api/graduation-tracker";
// DATA QUALITY (2026-07-16): rescore discovery tokens after 24h when RugCheck
// has real trading history to analyse. Requires migration 20260716000012.
import { startDiscoveryRescoreScheduler } from "./lib/api/discovery-rescore-scheduler";
// DATA QUALITY (2026-07-16): daily immutable snapshots of all wallet scores,
// developer reputations, and token risk scores. INSERT-only moat dataset.
// Requires migrations 20260716000010 + 20260716000011.
import { startIntelligenceSnapshotScheduler } from "./lib/api/intelligence-snapshot-scheduler";
// Pipeline Control dashboard — read-only aggregate of every backlog +
// Helius credit consumption metric, polled by the header's "Pipeline
// Control" panel.
import { handleBacklogStatusGet } from "./lib/api/backlog-status-handler";
// 22-section pipeline monitoring dashboard — comprehensive metrics for every
// table and scheduler in the Solana scanner system.
import { handleMonitorDashboardGet } from "./lib/api/monitor-dashboard-handler";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

// ---------------------------------------------------------------------------
// Startup env-var audit — emitted once on boot so Railway logs immediately
// show what is set and what is missing. Never logs values.
// ---------------------------------------------------------------------------
(function auditEnvVars() {
  const required: Record<string, string | undefined> = {
    HELIUS_API_KEY:            process.env.HELIUS_API_KEY,
    SUPABASE_URL:              process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    CRON_SECRET:               process.env.CRON_SECRET,
  };

  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  const present = Object.entries(required)
    .filter(([, v]) => !!v)
    .map(([k]) => k);

  if (missing.length > 0) {
    console.error(
      `[server] ‼ MISSING required env vars: ${missing.join(", ")} — ` +
      "set them in Railway → Variables. Affected features will be disabled.",
    );
    // Extra clarity for the most impactful missing variable
    if (missing.includes("SUPABASE_SERVICE_ROLE_KEY")) {
      console.error(
        "[server] ‼ SUPABASE_SERVICE_ROLE_KEY is missing. " +
        "After migration 20260627000001, all wallet_collection_jobs UPDATEs " +
        "require service_role. Without it, the job scheduler cannot stamp jobs " +
        "as 'processing' — all jobs will stay at pending/attempts=0 forever.",
      );
    }
  }
  console.log(
    `[server] Env vars present: ${present.join(", ") || "(none)"}`,
  );
})();

// ---------------------------------------------------------------------------
// FIX (silent-worker-startup-failure): every scheduler start below is now
// wrapped in try/catch with a visible, labeled console.error. Previously a
// throw from any one of these (e.g. a bad env var read, a bug introduced in
// a scheduler's synchronous setup code) would abort this entire module's
// evaluation. Because these calls run at import time, an uncaught throw here
// prevents every scheduler AFTER the one that threw from ever running, while
// Railway's healthcheck (`/api/discovery-status`) still returns 200 once the
// HTTP server comes up — the failure was easy to miss in a wall of boot logs.
// runScheduler() isolates each one so a single bad scheduler can't take the
// rest down, and stamps a loud, greppable error line into Railway logs.
// ---------------------------------------------------------------------------
function runScheduler(label: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error(`[server] FATAL: "${label}" failed to start:`, err);
  }
}

// Start the automatic price-refresh scheduler (every 15 minutes)
runScheduler("PriceRefreshScheduler", startPriceRefreshScheduler);

// Start the in-process wallet_collection_jobs scheduler (every 60 seconds).
//
// PATCH v2: The scheduler now releases the running lock BEFORE calling collect(),
// so subsequent ticks are never blocked by slow Helius API calls. Each tick
// stamps up to BATCH_SIZE (10) jobs as "processing" and fires collect() as
// background promises, capped at MAX_CONCURRENT (3) simultaneous calls.
//
// The Railway cron (cron-trigger.mjs) is kept as belt-and-suspenders but is
// NOT the primary execution path. Jobs are processed by this scheduler
// regardless of whether the cron fires.
runScheduler("ProcessJobsScheduler", startProcessJobsScheduler);

// P1-D: Start the PostLaunchWatcher — Helius WebSocket monitor for authority
// transitions, metadata hijacking, and LP removal on tracked tokens.
// Runs as a persistent background process alongside the price-refresh scheduler.
// Failures are caught and logged so they never crash the HTTP server.
startPostLaunchWatcher().catch((err: unknown) => {
  console.error("[server] FATAL: \"PostLaunchWatcher\" failed to start:", err);
});

// P2-A: Start autonomous token discovery — subscribes to Pump.fun via Helius
// WebSocket and auto-enqueues collection jobs for new token launches that pass
// the liquidity filter (0.5 SOL minimum bonding curve reserve). Jobs are
// picked up by the in-process scheduler within 60 seconds.
//
// M-2 FIX: Discovery was intentionally paused via ENABLE_TOKEN_DISCOVERY env var
// to let the Helius enrichment backlog drain. No new tokens have been collected
// since the pause was enabled. Set ENABLE_TOKEN_DISCOVERY=true in Railway →
// Variables to resume. The pause is surfaced in /api/discovery-status diagnosis[].
if (process.env.ENABLE_TOKEN_DISCOVERY === "true") {
  startTokenDiscovery().catch((err: unknown) => {
    console.error("[server] FATAL: \"TokenDiscovery\" failed to start:", err);
  });
} else {
  console.warn(
    "[server] ⚠️  TokenDiscovery is PAUSED — ENABLE_TOKEN_DISCOVERY is not 'true'. " +
    "No new tokens will be scanned until this variable is set in Railway → Variables. " +
    "See /api/discovery-status for current enrichment backlog depth before re-enabling.",
  );
}

// PATCH FIX (scoring-patch v1 + audit-6 staleness fix): Runs a rescore 10 s
// after boot (so all wallets are classified with the corrected 0-100 score
// scale without requiring a manual POST to /api/rescore-wallets), then keeps
// re-running automatically every 20 minutes for the lifetime of the process
// so win_rate/average_roi/intelligence_score never drift out of sync with
// enrichment happening in the background. Never blocks the HTTP server.
runScheduler("RescoreScheduler", startRescoreScheduler);

// P3-D: Start the unenriched-wallet enrichment scheduler — finds wallet × token
// pairs that have NEVER been through the Helius full-history enricher (the
// "hollow" wallets responsible for the 62% data-completeness gap) and enriches
// them in rolling 30-minute batches.  Runs after a 30-second warmup delay so
// the other schedulers are up first.  Triggers a lightweight rescore after each
// batch so win_rate/average_roi appear immediately on the leaderboard.
runScheduler("EnrichUnenrichedScheduler", startEnrichUnenrichedScheduler);

// AUDIT FIX (finding #2): daily prune of helius_cu_log — the table had no
// retention and no index, so even COUNT(*) queries were timing out.
runScheduler("HeliusCuLogRetentionScheduler", startHeliusCuLogRetentionScheduler);

// MONETIZATION FIX (plan Tasks A10 + A12): polls DexScreener every 30 min
// for pipeline-discovered tokens and marks those that graduated to Raydium.
// Feeds developerGraduationRate (A10) and developer fingerprinting (A12).
// NOTE: requires migration 20260716000001 to be applied first (adds
// scan_history.graduated_at). Silently no-ops if the column is missing.
runScheduler("GraduationTracker", startGraduationTracker);

// DATA QUALITY (2026-07-16): rescore discovery tokens 24h after launch so
// RugCheck can detect wash trading, honeypot signals, and concentration games.
// At T=0 all pump.fun tokens legitimately score LOW — no trading history exists.
// After 24h RugCheck returns meaningful risk signals. Batch: 50 tokens / 30 min.
runScheduler("DiscoveryRescoreScheduler", startDiscoveryRescoreScheduler);

// DATA QUALITY (2026-07-16): immutable daily snapshot of all wallet scores,
// developer reputations, and token risk profiles. Runs once at midnight UTC.
// After 12-18 months this becomes the moat data asset — history no competitor
// can recreate. Requires migrations 20260716000010 + 20260716000011.
runScheduler("SnapshotScheduler", startIntelligenceSnapshotScheduler);

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!body.includes('"unhandled":true') || !body.includes('"message":"HTTPError"')) {
    return response;
  }

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// ---------------------------------------------------------------------------
// API route interceptor
//
// @lovable.dev/vite-tanstack-config v2.3.2 does not register APIRoute exports
// as server-side handlers when using the node-server Nitro preset on Railway.
// We intercept these paths here, before delegating to TanStack Start, using
// plain handler functions that have no @tanstack/react-start/api dependency.
// ---------------------------------------------------------------------------
function handleApiRoute(request: Request, pathname: string): Promise<Response> | Response | null {
  if (pathname === "/api/price-refresh") {
    if (request.method === "POST") return handlePriceRefreshPost(request);
    if (request.method === "GET")  return handlePriceRefreshGet();
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { "Content-Type": "application/json" } },
    );
  }
  if (pathname === "/api/enrich-wallets") {
    if (request.method === "POST") return handleEnrichWalletsPost(request);
    if (request.method === "GET")  return handleEnrichWalletsGet();
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { "Content-Type": "application/json" } },
    );
  }
  // process-jobs — intercepted here because createAPIFileRoute is not
  // registered by @lovable.dev/vite-tanstack-config on the node-server preset.
  if (pathname === "/api/process-jobs") {
    if (request.method === "POST") return handleProcessJobsPost(request);
    if (request.method === "GET")  return handleProcessJobsGet(request);
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { "Content-Type": "application/json" } },
    );
  }
  // Runtime health check — no auth required, includes scheduler live state
  if (pathname === "/api/discovery-status" && request.method === "GET") {
    return handleDiscoveryStatusGet();
  }
  // Signal 1 — common funding source clusters (Chapter 8 prerequisite /
  // whale fund-distribution tracing). Read-only, no auth required.
  if (pathname === "/api/funding-clusters" && request.method === "GET") {
    return handleFundingClustersGet(request);
  }
  // Plain liveness probe for Railway healthchecks / uptime monitors.
  // Intentionally has zero dependencies (no DB, no external calls) so it
  // reflects only "is the process up and serving requests", not downstream
  // health — that's what /api/discovery-status is for.
  if (pathname === "/healthz" && request.method === "GET") {
    return new Response(
      JSON.stringify({ ok: true, service: "solana-scanner", timestamp: new Date().toISOString() }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
  // PATCH FIX: rescore-wallets was previously only defined as a TanStack
  // APIRoute (src/routes/api/rescore-wallets.ts) and was never reachable on
  // the Railway node-server preset. Wired here as a direct handler.
  if (pathname === "/api/rescore-wallets") {
    if (request.method === "POST") return handleRescoreWalletsPost(request);
    if (request.method === "GET")  return handleRescoreWalletsGet();
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { "Content-Type": "application/json" } },
    );
  }
  // AUDIT FIX (finding #4): scan_history writes now go through server-side
  // validation instead of an open anon-key INSERT from the browser.
  if (pathname === "/api/scan-history") {
    if (request.method === "POST") return handleScanHistoryPost(request);
    if (request.method === "GET")  return handleScanHistoryGet();
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { "Content-Type": "application/json" } },
    );
  }
  // Pipeline Control dashboard — read-only, no auth required (same policy
  // as /api/discovery-status and /api/funding-clusters).
  if (pathname === "/api/backlog-status" && request.method === "GET") {
    return handleBacklogStatusGet();
  }
  // 22-section pipeline monitoring dashboard — all metrics for every table
  // and scheduler in the Solana scanner system. Read-only, no auth required.
  if (pathname === "/api/monitor-dashboard" && request.method === "GET") {
    return handleMonitorDashboardGet();
  }
  return null;
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      const { pathname } = new URL(request.url);

      const apiResponse = handleApiRoute(request, pathname);
      if (apiResponse !== null) return apiResponse;

      const handler  = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
