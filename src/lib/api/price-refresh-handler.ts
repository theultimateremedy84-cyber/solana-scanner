// =============================================================================
// price-refresh-handler.ts
//
// Pure server-side handler for POST /api/price-refresh.
// Intentionally has NO @tanstack/react-start imports so it can be safely
// bundled by Nitro as part of the server entry (src/server.ts).
//
// The original price-refresh.ts (createAPIFileRoute) is kept in place for
// local dev / Lovable platform, but on Railway the route is handled here
// because @lovable.dev/vite-tanstack-config does not register APIRoute
// exports as server-side handlers in the node-server Nitro preset.
// =============================================================================

import { refreshOpenPositionPrices } from "./wallet-price-refresh";

const LOG = "[price-refresh]";

export async function handlePriceRefreshPost(request: Request): Promise<Response> {
  const cronSecret     = process.env.CRON_SECRET;
  const incomingSecret = request.headers.get("x-cron-secret");

  if (!cronSecret) {
    console.warn(`${LOG} CRON_SECRET env var is not set — all requests will be rejected`);
    return new Response(
      JSON.stringify({ ok: false, error: "CRON_SECRET not configured on server" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  if (!incomingSecret || incomingSecret !== cronSecret) {
    console.warn(`${LOG} Unauthorized request — bad or missing x-cron-secret`);
    return new Response(
      JSON.stringify({ ok: false, error: "Unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  console.log(`${LOG} Authenticated — starting price refresh`);

  try {
    const result = await refreshOpenPositionPrices({ maxTokens: 50, delayMs: 200 });

    console.log(
      `${LOG} Done — tokens=${result.tokensProcessed} ` +
      `wallets=${result.walletsUpdated} snapshots=${result.snapshotsInserted} ` +
      `peaks=${result.peaksUpdated} errors=${result.errors.length} ` +
      `duration=${result.durationMs}ms`,
    );

    return new Response(
      JSON.stringify({
        ok:     true,
        status: "ok",
        result: {
          tokensProcessed:   result.tokensProcessed,
          snapshotsInserted: result.snapshotsInserted,
          walletsUpdated:    result.walletsUpdated,
          peaksUpdated:      result.peaksUpdated,
          errors:            result.errors,
          durationMs:        result.durationMs,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${LOG} Unhandled error: ${message}`);
    return new Response(
      JSON.stringify({ ok: false, error: message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}

export function handlePriceRefreshGet(): Response {
  return new Response(
    JSON.stringify({
      ok:      true,
      route:   "/api/price-refresh",
      method:  "POST only (GET returns this help message)",
      auth:    "Header: x-cron-secret: <CRON_SECRET>",
      purpose: "Refresh DexScreener prices for all open-position tokens and insert token_price_history snapshots",
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
