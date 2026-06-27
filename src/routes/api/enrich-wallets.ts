// =============================================================================
// /api/enrich-wallets — Manual trigger for wallet tx-history enrichment
//
// POST body (all optional):
//   { tokenAddress?: string, walletAddresses?: string[], maxWallets?: number }
//
// GET — returns help / usage info.
//
// Usage examples:
//
//   # Enrich all UNKNOWN wallets for a specific token (up to 30 by default)
//   curl -s -X POST https://YOUR-APP.railway.app/api/enrich-wallets \
//        -H "content-type: application/json" \
//        -H "x-cron-secret: YOUR_CRON_SECRET" \
//        -d '{"tokenAddress":"8cDPjCoxhM4iMGqKbU3CPG8oyTSGtBPRrHwb2Csipump","maxWallets":50}'
//
//   # Enrich top-5 tokens with the most UNKNOWN wallets (auto-discovery mode)
//   curl -s -X POST https://YOUR-APP.railway.app/api/enrich-wallets \
//        -H "content-type: application/json" \
//        -H "x-cron-secret: YOUR_CRON_SECRET" \
//        -d '{}'
//
//   # Railway Cron Job (runs every 30 minutes):
//   curl -s -X POST https://YOUR-APP.railway.app/api/enrich-wallets \
//        -H "x-cron-secret: YOUR_CRON_SECRET" \
//        -d '{}'
// =============================================================================

import { createAPIFileRoute } from "@tanstack/react-start/api";
import { enrichWalletsForToken } from "@/lib/api/wallet-enricher";
import { fetchTokenPrice } from "@/lib/api/wallet-collection-worker";
import { createClient } from "@supabase/supabase-js";

const LOG = "[enrich-wallets]";

function getSupabase() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_ANON_KEY ??
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    "";
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export const APIRoute = createAPIFileRoute("/api/enrich-wallets")({
  POST: async ({ request }) => {
    const cronSecret     = process.env.CRON_SECRET;
    const incomingSecret = request.headers.get("x-cron-secret");

    if (cronSecret && (!incomingSecret || incomingSecret !== cronSecret)) {
      console.warn(`${LOG} Unauthorized — bad or missing x-cron-secret`);
      return json({ ok: false, error: "Unauthorized" }, 401);
    }

    let body: { tokenAddress?: string; walletAddresses?: string[]; maxWallets?: number } = {};
    try {
      body = await request.json() as typeof body;
    } catch {
      body = {};
    }

    const { tokenAddress, walletAddresses, maxWallets = 30 } = body;

    // ── Enrich a specific token ────────────────────────────────────────────
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

    // ── Auto-discover tokens with the most UNKNOWN wallets ─────────────────
    const sb = getSupabase();
    if (!sb) return json({ ok: false, error: "Supabase credentials not configured" }, 500);

    const { data: rows, error } = await sb
      .from("wallet_performance_history")
      .select("token_address")
      .eq("position_status", "UNKNOWN")
      .limit(500);

    if (error) return json({ ok: false, error: error.message }, 500);

    const tokenCounts = new Map<string, number>();
    for (const r of rows ?? []) {
      const ta = r.token_address as string;
      tokenCounts.set(ta, (tokenCounts.get(ta) ?? 0) + 1);
    }
    const topTokens = Array.from(tokenCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([ta]) => ta);

    if (topTokens.length === 0) {
      return json({ ok: true, message: "No UNKNOWN wallets found — all wallets are enriched!" });
    }

    console.log(`${LOG} Auto-enriching ${topTokens.length} tokens: ${topTokens.map((t) => t.slice(0, 8)).join(", ")}`);

    const results = [];
    for (const ta of topTokens) {
      const priceData = await fetchTokenPrice(ta);
      const r = await enrichWalletsForToken({
        tokenAddress:    ta,
        priceData,
        maxWallets:      Math.ceil(maxWallets / topTokens.length),
      });
      results.push(r);
    }

    return json({ ok: true, tokensProcessed: results.length, results });
  },

  GET: async () =>
    json({
      ok:      true,
      route:   "/api/enrich-wallets",
      methods: "POST (GET returns this message)",
      body: {
        tokenAddress:    "string   — optional — target a specific token",
        walletAddresses: "string[] — optional — restrict to specific wallets",
        maxWallets:      "number   — optional — cap per call (default 30)",
      },
      example: {
        targetToken:  { tokenAddress: "MINT_ADDRESS", maxWallets: 50 },
        autoDiscover: {},
      },
      purpose: "Reconstruct full tx history for each wallet and populate intelligence scores + P&L",
      tip: "Add a Railway Cron: POST /api/enrich-wallets every 30 minutes with x-cron-secret header",
    }),
});
