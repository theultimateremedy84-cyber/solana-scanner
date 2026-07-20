// =============================================================================
// enrich-handler.ts
//
// Pure server-side handler for POST/GET /api/enrich-wallets.
// Has NO @tanstack/react-start imports so it is safely bundled by Nitro
// as part of src/server.ts — identical pattern to price-refresh-handler.ts.
//
// The TanStack APIRoute in src/routes/api/enrich-wallets.ts handles
// local dev; on Railway this interceptor runs instead.
// =============================================================================

import { enrichWalletsForToken } from "./wallet-enricher";
import { fetchTokenPrice } from "./wallet-collection-worker";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const LOG = "[enrich-handler]";

export async function handleEnrichWalletsPost(request: Request): Promise<Response> {
  const cronSecret     = process.env.CRON_SECRET;
  const incomingSecret = request.headers.get("x-cron-secret");

  // SECURITY: always require CRON_SECRET — refuse all requests when not configured
  // rather than silently allowing them through (matches the TanStack APIRoute behaviour).
  if (!cronSecret) {
    console.error(
      `${LOG} CRON_SECRET env var is not set. ` +
      "All requests will be rejected until it is configured. " +
      "Set it in Railway → Variables: CRON_SECRET=$(openssl rand -hex 32)",
    );
    return json(
      {
        ok: false,
        error:
          "Service misconfigured: CRON_SECRET is not set. " +
          "Contact the administrator to configure authentication.",
      },
      503,
    );
  }
  if (!incomingSecret || incomingSecret !== cronSecret) {
    console.warn(`${LOG} Unauthorized — bad or missing x-cron-secret`);
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  // FIX (2026-07-20): body is optional — agent-fixer.ts callEndpoint() sends POST
  // with no body (only cronHeaders). Returning 400 on missing body caused every
  // agent-triggered enrichment to fail with success=false. Now mirrors the pattern
  // in rescore-handler.ts: silently use defaults when body is absent or unparseable.
  let body: { tokenAddress?: string; walletAddresses?: string[]; maxWallets?: number } = {};
  try {
    body = await request.json() as typeof body;
  } catch { /* body is optional — use defaults */ }

  const { tokenAddress, walletAddresses, maxWallets = 30 } = body;

  // ── If tokenAddress provided, enrich that token ─────────────────────────
  if (tokenAddress) {
    console.log(`${LOG} Enriching token=${tokenAddress} maxWallets=${maxWallets}`);
    const priceData = await fetchTokenPrice(tokenAddress);
    const result = await enrichWalletsForToken({
      tokenAddress,
      walletAddresses: walletAddresses ?? [],
      priceData,
      maxWallets,
    });
    return json({ ok: true, result });
  }

  // ── No tokenAddress — enrich next batch of stale wallets across all tokens ─
  const sb = supabaseAdmin;

  // FIX (Issue 6 — enrichment activity filter):
  //   Old code queried wallet_performance_history WHERE position_status='UNKNOWN'
  //   with no activity filter, causing ~90% of enriched wallets to be dust/airdrop
  //   holders with 0 buy transactions (0.064 SOL avg invested). This wastes
  //   Helius CUs on wallets that will never yield trading intelligence.
  //
  //   Fix: use the find_hollow_pairs() Postgres function which performs an
  //   anti-join between wallet_performance_history and wallet_raw_tx_metrics
  //   WHERE data_source='helius_full_history'. This correctly excludes:
  //     (a) wallets already enriched (tombstoned with has_evidence=false), and
  //     (b) wallets already enriched with real evidence (no re-enrichment needed).
  //   Only genuine hollow pairs — wallets with WPH records but NO Helius history
  //   at all — are returned, making every API call count.
  const { data: hollowPairs, error } = await sb
    .rpc("find_hollow_pairs", { p_limit: 500 }) as {
      data: Array<{ wallet_address: string; token_address: string }> | null;
      error: { message: string } | null;
    };

  if (error) return json({ ok: false, error: error.message }, 500);

  // Count hollow wallets per token — same priority logic as before
  const tokenCounts = new Map<string, number>();
  for (const r of hollowPairs ?? []) {
    const ta = r.token_address as string;
    tokenCounts.set(ta, (tokenCounts.get(ta) ?? 0) + 1);
  }
  const topTokens = Array.from(tokenCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)  // process up to 5 tokens per call
    .map(([ta]) => ta);

  if (topTokens.length === 0) {
    return json({ ok: true, message: "No unenriched hollow pairs found — nothing to enrich" });
  }

  const results = [];
  for (const ta of topTokens) {
    // FIX (2026-07-20): enrichWalletsForToken can throw when Helius returns
    // budget-exceeded or network errors. An unhandled throw here propagates to
    // the server's fetch handler and produces an HTTP 500 response. The
    // agent-fixer's callEndpoint() sees ok=false → throws → records success=false
    // → the circuit breaker opens after 3 attempts, permanently blocking the
    // enrichment fix chain even though the background EnrichUnenrichedScheduler
    // is running fine.
    // Fix: catch per-token errors so the loop continues and the endpoint always
    // returns HTTP 200. Individual token failures are surfaced in the results
    // array so they remain visible in the agent fix log.
    try {
      const priceData = await fetchTokenPrice(ta);
      const r = await enrichWalletsForToken({
        tokenAddress:    ta,
        priceData,
        maxWallets:      Math.ceil(maxWallets / topTokens.length),
      });
      results.push(r);
    } catch (enrichErr) {
      console.error(`${LOG} enrichWalletsForToken failed for token=${ta}:`, enrichErr);
      results.push({ tokenAddress: ta, skipped: true, error: String(enrichErr) });
    }
  }

  return json({ ok: true, tokensProcessed: results.length, results });
}

export function handleEnrichWalletsGet(): Response {
  return json({
    ok:      true,
    route:   "/api/enrich-wallets",
    method:  "POST (GET returns this help message)",
    auth:    "Header: x-cron-secret: <CRON_SECRET>  (optional — only enforced when CRON_SECRET is set)",
    body: {
      tokenAddress:    "string  — optional — enrich a specific token",
      walletAddresses: "string[] — optional — restrict to specific wallets",
      maxWallets:      "number  — optional — wallets to process per call (default 30)",
    },
    purpose: "Reconstruct complete tx history for wallets and update classification + P&L",
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
