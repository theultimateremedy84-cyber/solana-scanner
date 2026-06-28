// =============================================================================
// discovery-status-handler.ts — GET /api/discovery-status
//
// Returns the runtime state of the P2-A autonomous token discovery system
// without requiring any credentials. Useful for diagnosing Railway deployments.
//
// Response includes:
//   - env var presence (true/false — never values)
//   - TokenDiscovery singleton stats (running, subscriptionId, tokensEnqueued)
//   - Current UTC time and process uptime
// =============================================================================

import { TokenDiscovery } from "./token-discovery";

export function handleDiscoveryStatusGet(): Response {
  const stats = TokenDiscovery.getInstance().getStats();

  const env = {
    HELIUS_API_KEY:           !!process.env.HELIUS_API_KEY,
    SUPABASE_URL:             !!(process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL),
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

  return new Response(
    JSON.stringify(
      {
        ok:         true,
        serverTime: new Date().toISOString(),
        uptimeSeconds: Math.floor(process.uptime()),
        discovery: {
          running:        stats.running,
          subscriptionId: stats.subscriptionId,
          tokensEnqueued: stats.tokensEnqueued,
          wsAlive:        stats.wsAlive,
          lastMessageAt:  stats.lastMessageAt,
        },
        env,
        diagnosis: diagnosis.length > 0 ? diagnosis : ["All checks passed"],
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
