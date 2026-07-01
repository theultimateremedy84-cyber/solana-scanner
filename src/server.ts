import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
// Direct handlers — no @tanstack/react-start/api import, safe to bundle in SSR
import { handlePriceRefreshPost, handlePriceRefreshGet } from "./lib/api/price-refresh-handler";
import { handleEnrichWalletsPost, handleEnrichWalletsGet } from "./lib/api/enrich-handler";
import { handleProcessJobsPost, handleProcessJobsGet } from "./lib/api/process-jobs-handler";
import { startProcessJobsScheduler } from "./lib/api/process-jobs-scheduler";
import { handleDiscoveryStatusGet } from "./lib/api/discovery-status-handler";
import { startPriceRefreshScheduler } from "./lib/api/price-refresh-scheduler";
import { startPostLaunchWatcher } from "./lib/postLaunchWatcher";
import { startTokenDiscovery } from "./lib/api/token-discovery";

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

// Start the automatic price-refresh scheduler (every 15 minutes)
startPriceRefreshScheduler();

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
startProcessJobsScheduler();

// P1-D: Start the PostLaunchWatcher — Helius WebSocket monitor for authority
// transitions, metadata hijacking, and LP removal on tracked tokens.
// Runs as a persistent background process alongside the price-refresh scheduler.
// Failures are caught and logged so they never crash the HTTP server.
startPostLaunchWatcher().catch((err: unknown) => {
  console.error("[PostLaunchWatcher] Failed to start:", err);
});

// P2-A: Start autonomous token discovery — subscribes to Pump.fun via Helius
// WebSocket and auto-enqueues collection jobs for new token launches that pass
// the liquidity filter (0.5 SOL minimum bonding curve reserve). Jobs are
// picked up by the in-process scheduler within 60 seconds.
startTokenDiscovery().catch((err: unknown) => {
  console.error("[TokenDiscovery] Failed to start:", err);
});

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
