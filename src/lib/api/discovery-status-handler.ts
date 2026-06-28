// =============================================================================
// discovery-status-handler.ts — GET /api/discovery-status
//
// Returns the runtime state of the P2-A autonomous token discovery system
// without requiring any credentials. Useful for diagnosing Railway deployments.
//
// Response includes:
//   - env var presence (true/false — never values)
//   - TokenDiscovery singleton stats (running, subscriptionId, tokensEnqueued)
//   - Pipeline stage counters — pinpoints exactly which step is dropping tokens:
//       1_messagesReceived  → 2_createEventsFound → 3_mintsExtracted
//       → 4_dexScreenerHit → 5_liquidityPassed   → 6_tokensEnqueued
//   - Current UTC time and process uptime
// =============================================================================

import { TokenDiscovery } from "./token-discovery";

export function handleDiscoveryStatusGet(): Response {
  const stats = TokenDiscovery.getInstance().getStats();
  const p = stats.pipeline;

  const env = {
    HELIUS_API_KEY:            !!process.env.HELIUS_API_KEY,
    SUPABASE_URL:              !!(process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL),
    SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_ANON_KEY:         !!process.env.SUPABASE_ANON_KEY,
    CRON_SECRET:               !!process.env.CRON_SECRET,
  };

  const diagnosis: string[] = [];

  if (!env.HELIUS_API_KEY) {
    diagnosis.push("CRITICAL: HELIUS_API_KEY is not set — TokenDiscovery WebSocket cannot start");
  }
  if (!env.SUPABASE_URL) {
    diagnosis.push("CRITICAL: SUPABASE_URL (or VITE_SUPABASE_URL) is not set — cannot write jobs");
  }
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    diagnosis.push(
      "WARNING: SUPABASE_SERVICE_ROLE_KEY is not set — RLS may block job inserts. " +
      "Falling back to SUPABASE_ANON_KEY.",
    );
  }
  if (!env.CRON_SECRET) {
    diagnosis.push("WARNING: CRON_SECRET is not set — /api/process-jobs rejects all requests");
  }
  if (!stats.running) {
    diagnosis.push("TokenDiscovery is NOT running — check HELIUS_API_KEY");
  }
  if (stats.running && stats.subscriptionId === null) {
    diagnosis.push(
      "TokenDiscovery is running but WebSocket subscription is not confirmed — " +
      "WS may still be connecting or Helius rejected the subscription",
    );
  }

  // Pipeline bottleneck diagnosis
  if (p.messagesReceived > 0 && p.createEventsFound === 0) {
    diagnosis.push(
      `PIPELINE BLOCKED at step 2: ${p.messagesReceived} Pump.fun messages received but ` +
      `0 passed the "Instruction: Create" pre-filter — ` +
      `Pump.fun log format may have changed`,
    );
  } else if (p.createEventsFound > 0 && p.mintsExtracted === 0) {
    diagnosis.push(
      `PIPELINE BLOCKED at step 3: ${p.createEventsFound} Create events found but ` +
      `extractMint() returned null for all of them — ` +
      `transaction account structure may have changed`,
    );
  } else if (p.mintsExtracted > 0 && p.dexScreenerHit === 0) {
    diagnosis.push(
      `PIPELINE BLOCKED at step 4: ${p.mintsExtracted} mints detected but 0 returned ` +
      `market data from Pump.fun API or DexScreener after 5s — tokens may not yet have trades`,
    );
  } else if (p.dexScreenerHit > 0 && p.liquidityPassed === 0) {
    diagnosis.push(
      `PIPELINE BLOCKED at step 5: ${p.dexScreenerHit} tokens had market data ` +
      `but all below $5,000 market cap floor — consider lowering MIN_MARKET_CAP_USD`,
    );
  }

  if (diagnosis.length === 0) {
    diagnosis.push("All checks passed");
  }

  return new Response(
    JSON.stringify(
      {
        ok:            true,
        serverTime:    new Date().toISOString(),
        uptimeSeconds: Math.floor(process.uptime()),
        discovery: {
          running:        stats.running,
          subscriptionId: stats.subscriptionId,
          tokensEnqueued: stats.tokensEnqueued,
          wsAlive:        stats.wsAlive,
          lastMessageAt:  stats.lastMessageAt,
        },
        pipeline: {
          "1_messagesReceived":  p.messagesReceived,
          "2_createEventsFound": p.createEventsFound,
          "3_mintsExtracted":    p.mintsExtracted,
          "4_marketDataFetched": p.dexScreenerHit,
          "5_marketCapPassed":   p.liquidityPassed,
          "6_tokensEnqueued":    p.tokensEnqueued,
          filters: {
            minMarketCapUsd:    5000,
            priceCheckDelayMs:  5000,
            dataSource:         "pumpfun-api (fallback: dexscreener)",
          },
        },
        env,
        diagnosis,
      },
      null,
      2,
    ),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}
