// =============================================================================
// Rescore Handler — thin wrapper for server.ts API interceptor
//
// Mirrors the pattern of enrich-handler.ts / process-jobs-handler.ts so the
// /api/rescore-wallets route is intercepted before TanStack Start (which does
// not register APIRoute exports on the node-server Nitro preset on Railway).
//
// PATCH NOTES (scoring-patch v1 — wiring fix):
//   BUG-FIX: /api/rescore-wallets was defined as a TanStack APIRoute but was
//            never added to server.ts handleApiRoute(), so it was unreachable
//            on Railway production. This handler exposes the same logic as the
//            original route file but as plain exported functions that server.ts
//            can import and call directly.
// =============================================================================

import { rescoreAllWallets } from "./wallet-rescoring";

const LOG = "[RescoreHandler]";

export async function handleRescoreWalletsPost(request: Request): Promise<Response> {
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
    if (body.delayMs != null) delayMs = body.delayMs;
  } catch { /* body is optional */ }

  console.log(`${LOG} POST /api/rescore-wallets — batchSize=${batchSize} delayMs=${delayMs}`);
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

export function handleRescoreWalletsGet(): Response {
  return json({
    ok:      true,
    route:   "/api/rescore-wallets",
    method:  "POST (this GET returns a help message)",
    auth:    "Header: x-cron-secret: <CRON_SECRET>  (optional — only enforced when CRON_SECRET env var is set)",
    body:    {
      batchSize: "number — wallets per batch (default 200)",
      delayMs:   "number — pause between batches in ms (default 0)",
    },
    purpose: "Re-classify all wallets from existing DB data — no Helius API required. " +
             "Safe to run repeatedly; scores only improve, never degrade.",
  });
}

// ---------------------------------------------------------------------------
// Startup rescore — fires once on boot, non-blocking
// ---------------------------------------------------------------------------

let _rescoreFired = false;

/**
 * Trigger a one-time rescore on server startup so that wallets are always
 * up to date with the latest scoring logic after a deploy, without requiring
 * a manual POST to /api/rescore-wallets.
 *
 * Runs asynchronously — never blocks the HTTP server from accepting requests.
 * Guarded by _rescoreFired so it only runs once per process lifetime.
 */
export function startRescoreOnBoot(): void {
  if (_rescoreFired) return;
  _rescoreFired = true;

  // Delay 10 s to let schedulers and DB connections warm up first
  setTimeout(() => {
    console.log(`${LOG} ═══ Boot rescore starting (scoring-patch v1 backfill)`);
    rescoreAllWallets({ batchSize: 200, delayMs: 0 })
      .then((result) => {
        console.log(
          `${LOG} ═══ Boot rescore done — wallets=${result.totalWallets} ` +
          `classified=${result.classified} batches=${result.batches} ` +
          `errors=${result.errors.length} duration=${result.durationMs}ms`,
        );
        if (result.errors.length > 0) {
          console.error(`${LOG} Boot rescore errors:`, result.errors.slice(0, 5));
        }
      })
      .catch((err: unknown) => {
        console.error(`${LOG} Boot rescore failed:`, err);
      });
  }, 10_000);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
