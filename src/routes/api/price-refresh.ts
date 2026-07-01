// =============================================================================
// /api/price-refresh — Refresh open-position token prices + P&L snapshots
//
// Called by a Railway Cron Job every N minutes to:
//   1. Fetch current prices from DexScreener for all tokens with open positions
//   2. Insert snapshots into token_price_history
//   3. Recalculate unrealized P&L and peak values in wallet_performance_history
//
// USAGE — Railway Cron Job (recommended):
//   Schedule : */5 * * * *   (every 5 minutes)
//   Command  : curl -s -X POST \
//                -H "x-cron-secret: $CRON_SECRET" \
//                https://solana-scanner-production-e838.up.railway.app/api/price-refresh
//
// Manual test (omit -H flag to check auth is working — expect 401):
//   curl -X POST https://solana-scanner-production-e838.up.railway.app/api/price-refresh
// =============================================================================

import { createAPIFileRoute } from "@tanstack/react-start/api";
import { refreshOpenPositionPrices } from "@/lib/api/wallet-price-refresh";

const LOG = "[price-refresh]";

export const APIRoute = createAPIFileRoute("/api/price-refresh")({
  // POST — authenticate via x-cron-secret header, then run refresh
  POST: async ({ request }) => {
    const cronSecret    = process.env.CRON_SECRET;
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
      const result = await refreshOpenPositionPrices({
        maxTokens: 150,
        delayMs:   200,
      });

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
  },

  // GET — show status / usage instructions (no side effects, safe for browser)
  GET: async () => {
    return new Response(
      JSON.stringify({
        ok:      true,
        route:   "/api/price-refresh",
        method:  "POST only (GET returns this help message)",
        auth:    "Header: x-cron-secret: <CRON_SECRET>",
        purpose: "Refresh DexScreener prices for all open-position tokens and insert token_price_history snapshots",
        tip:     "Set up a Railway Cron Job: schedule '*/5 * * * *', command 'curl -s -X POST -H \"x-cron-secret: $CRON_SECRET\" https://solana-scanner-production-e838.up.railway.app/api/price-refresh'",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  },
});
