import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
// Direct handler — no @tanstack/react-start/api import, safe to bundle in SSR
import { handlePriceRefreshPost, handlePriceRefreshGet } from "./lib/api/price-refresh-handler";
import { handleEnrichWalletsPost, handleEnrichWalletsGet } from "./lib/api/enrich-handler";
import { startPriceRefreshScheduler } from "./lib/api/price-refresh-scheduler";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

// Start the automatic price-refresh scheduler (every 15 minutes)
startPriceRefreshScheduler();

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
