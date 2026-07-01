// =============================================================================
// POST /api/rescore-wallets
//
// HTTP endpoint that triggers a full wallet rescore from existing DB data.
// No Helius API call required — reads wallet_raw_tx_metrics and updates
// the wallets table classification columns.
//
// Authentication: optional CRON_SECRET header (same pattern as enrich-wallets).
//
// Usage:
//   curl -X POST https://<your-domain>/api/rescore-wallets \
//     -H "x-cron-secret: <CRON_SECRET>" \
//     -H "Content-Type: application/json" \
//     -d '{"batchSize": 200}'
//
// Also callable as a Railway cron job:
//   Schedule: 0 3 * * *   (daily at 3 AM UTC)
//   Command:  curl -s -X POST $APP_URL/api/rescore-wallets \
//               -H "x-cron-secret: $CRON_SECRET"
// =============================================================================

import { rescoreAllWallets } from "../../lib/api/wallet-rescoring";

export async function POST(request: Request): Promise<Response> {
  const cronSecret     = process.env.CRON_SECRET;
  const incomingSecret = request.headers.get("x-cron-secret");

  if (cronSecret && (!incomingSecret || incomingSecret !== cronSecret)) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  let batchSize = 200;
  let delayMs   = 0;
  try {
    const body = await request.json() as { batchSize?: number; delayMs?: number };
    if (body.batchSize) batchSize = body.batchSize;
    if (body.delayMs   != null) delayMs = body.delayMs;
  } catch { /* body is optional */ }

  const result = await rescoreAllWallets({ batchSize, delayMs });

  return json({
    ok:           result.errors.length === 0,
    totalWallets: result.totalWallets,
    classified:   result.classified,
    batches:      result.batches,
    errors:       result.errors,
    durationMs:   result.durationMs,
  });
}

export async function GET(): Promise<Response> {
  return json({
    ok:      true,
    route:   "/api/rescore-wallets",
    method:  "POST (GET returns this help message)",
    auth:    "Header: x-cron-secret: <CRON_SECRET>  (optional — only enforced when CRON_SECRET is set)",
    body:    {
      batchSize: "number — wallets per batch (default 200)",
      delayMs:   "number — pause between batches in ms (default 0)",
    },
    purpose: "Re-classify all wallets from existing DB data — no Helius required. " +
             "Run once after deploying scoring-patch to backfill 835 wallets.",
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
