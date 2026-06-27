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
import { createClient } from "@supabase/supabase-js";

const LOG = "[enrich-handler]";

function getSupabase() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? "";
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function handleEnrichWalletsPost(request: Request): Promise<Response> {
  const cronSecret     = process.env.CRON_SECRET;
  const incomingSecret = request.headers.get("x-cron-secret");

  // Require auth only when CRON_SECRET is configured
  if (cronSecret && (!incomingSecret || incomingSecret !== cronSecret)) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  let body: { tokenAddress?: string; walletAddresses?: string[]; maxWallets?: number } = {};
  try {
    body = await request.json() as typeof body;
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

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
  const sb = getSupabase();
  if (!sb) return json({ ok: false, error: "Supabase credentials not configured" }, 500);

  // Find tokens that still have UNKNOWN wallets, prioritised by UNKNOWN count
  const { data: rows, error } = await sb
    .from("wallet_performance_history")
    .select("token_address")
    .eq("position_status", "UNKNOWN")
    .limit(500);

  if (error) return json({ ok: false, error: error.message }, 500);

  // Count UNKNOWN per token
  const tokenCounts = new Map<string, number>();
  for (const r of rows ?? []) {
    const ta = r.token_address as string;
    tokenCounts.set(ta, (tokenCounts.get(ta) ?? 0) + 1);
  }
  const topTokens = Array.from(tokenCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)  // process up to 5 tokens per call
    .map(([ta]) => ta);

  if (topTokens.length === 0) {
    return json({ ok: true, message: "No UNKNOWN wallets found — nothing to enrich" });
  }

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
