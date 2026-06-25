import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

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
// Direct API route fallback
//
// @lovable.dev/vite-tanstack-config sometimes fails to register API routes
// that were added after the initial build cache was created. This function
// handles those routes directly, which also forces Nitro to include the
// route modules in the server bundle (Nitro statically analyses all imports).
// ---------------------------------------------------------------------------
async function tryDirectApiHandler(request: Request): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const method = request.method as "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

  if (pathname === "/api/price-refresh") {
    // Importing here guarantees Nitro bundles this module even if route
    // discovery in @lovable.dev/vite-tanstack-config missed it.
    const { APIRoute } = await import("./routes/api/price-refresh");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (APIRoute as any)[method];
    if (!handler) {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json" },
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return handler({ request } as any) as Promise<Response>;
  }

  return null;
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);

      // If TanStack Start returned 404 for an API path, try the direct fallback.
      // If the route was correctly discovered by TanStack Start this never fires.
      if (response.status === 404) {
        const fallback = await tryDirectApiHandler(request);
        if (fallback) return fallback;
      }

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
