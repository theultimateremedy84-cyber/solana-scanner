import { createAPIFileRoute } from "@tanstack/react-start/api";
import { refreshOpenPositionPrices } from "~/lib/workers/refreshOpenPositionPrices";

export const APIRoute = createAPIFileRoute("/api/price-refresh")({
  POST: async ({ request }) => {
    const cronSecret = process.env.CRON_SECRET;
    const incomingSecret = request.headers.get("x-cron-secret");

    if (!incomingSecret || incomingSecret !== cronSecret) {
      return new Response(
        JSON.stringify({ ok: false, error: "Unauthorized" }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    try {
      const result = await refreshOpenPositionPrices({
        maxTokens: 50,
        delayMs: 200,
      });

      return new Response(
        JSON.stringify({
          ok: true,
          status: "ok",
          result: {
            tokensProcessed: result.tokensProcessed,
            snapshotsInserted: result.snapshotsInserted,
            walletsUpdated: result.walletsUpdated,
            errors: result.errors,
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return new Response(
        JSON.stringify({ ok: false, error: message }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
  },
});
