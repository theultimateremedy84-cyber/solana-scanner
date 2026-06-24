// =============================================================================
// /api/wallet-test — Live collection test endpoint
//
// Visit in browser: https://your-app.railway.app/api/wallet-test?token=<MINT>
//
// Uses a known active Raydium meme coin by default if no token param given.
// Shows every step — env vars, Supabase connection, RPC calls, DB writes.
// Remove this file once collection is confirmed working.
// =============================================================================

import { createAPIFileRoute } from "@tanstack/react-start/api";
import { createClient } from "@supabase/supabase-js";
import { collect } from "@/lib/api/wallet-collection-worker";

// A known meme coin that has real on-chain holders (BONK)
const DEFAULT_TEST_TOKEN = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

function getSupabaseStatus() {
  const url  = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key  =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_ANON_KEY ??
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.VITE_SUPABASE_ANON_KEY ??
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    "";

  return {
    url:   url  ? `${url.slice(0, 40)}…` : "MISSING ✗",
    key:   key  ? `${key.slice(0, 8)}…`  : "MISSING ✗",
    keyType:
      process.env.SUPABASE_SERVICE_ROLE_KEY ? "service_role ✓" :
      process.env.SUPABASE_ANON_KEY         ? "anon ✓" :
      process.env.SUPABASE_PUBLISHABLE_KEY  ? "publishable ✓" :
      "NONE — fix: add SUPABASE_URL + SUPABASE_ANON_KEY in Railway env",
    helius: process.env.HELIUS_API_KEY
      ? `SET (${process.env.HELIUS_API_KEY.slice(0, 8)}…) ✓`
      : "MISSING (holder collection still works without it)",
    urlOk:  !!url,
    keyOk:  !!key,
    sbClient: (!!url && !!key)
      ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
      : null,
  };
}

async function checkTable(sb: ReturnType<typeof createClient> | null, name: string) {
  if (!sb) return { exists: false, rows: null, error: "No Supabase client" };
  try {
    const { count, error } = await sb.from(name).select("*", { count: "exact", head: true });
    if (error) return { exists: false, rows: null, error: error.message };
    return { exists: true, rows: count ?? 0, error: null };
  } catch (e) {
    return { exists: false, rows: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export const APIRoute = createAPIFileRoute("/api/wallet-test")({
  GET: async ({ request }) => {
    const url    = new URL(request.url);
    const token  = url.searchParams.get("token") ?? DEFAULT_TEST_TOKEN;
    const dryRun = url.searchParams.get("dry") === "1"; // ?dry=1 skips actual collect

    const logs: string[] = [];
    const log = (msg: string) => { console.log("[wallet-test] " + msg); logs.push(msg); };

    log(`=== Wallet Collection Test ===`);
    log(`Token: ${token}`);
    log(`Time:  ${new Date().toISOString()}`);
    log(``);

    // ── Env vars ──────────────────────────────────────────────────────────────
    const sb = getSupabaseStatus();
    log(`── Env vars ──`);
    log(`SUPABASE_URL            : ${sb.url}`);
    log(`Active key type         : ${sb.keyType}`);
    log(`HELIUS_API_KEY          : ${sb.helius}`);
    log(``);

    if (!sb.urlOk || !sb.keyOk) {
      log(`FATAL: Supabase not configured. Add SUPABASE_URL + SUPABASE_ANON_KEY`);
      log(`in Railway → your service → Variables.`);
      return new Response(logs.join("\n"), {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    // ── Table existence ────────────────────────────────────────────────────────
    log(`── Tables ──`);
    const [w, a, p, j] = await Promise.all([
      checkTable(sb.sbClient, "wallets"),
      checkTable(sb.sbClient, "wallet_token_activity"),
      checkTable(sb.sbClient, "wallet_performance_history"),
      checkTable(sb.sbClient, "wallet_collection_jobs"),
    ]);
    log(`wallets                 : ${w.exists ? `EXISTS (${w.rows} rows)` : `MISSING — ${w.error}`}`);
    log(`wallet_token_activity   : ${a.exists ? `EXISTS (${a.rows} rows)` : `MISSING — ${a.error}`}`);
    log(`wallet_performance_hist : ${p.exists ? `EXISTS (${p.rows} rows)` : `MISSING — ${p.error}`}`);
    log(`wallet_collection_jobs  : ${j.exists ? `EXISTS (${j.rows} rows)` : `MISSING — ${j.error}`}`);
    log(``);

    if (!w.exists || !a.exists || !p.exists || !j.exists) {
      log(`FATAL: One or more tables missing.`);
      log(`Paste supabase/APPLY-IN-SQL-EDITOR.sql into Supabase SQL Editor and run it.`);
      return new Response(logs.join("\n"), {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (dryRun) {
      log(`DRY RUN requested (?dry=1) — skipping collect().`);
      log(`All checks passed. Remove ?dry=1 to run a live collection.`);
      return new Response(logs.join("\n"), {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    // ── Live collection ────────────────────────────────────────────────────────
    log(`── Running collect() ──`);
    log(`(check Railway logs for detailed step-by-step output)`);
    const t0 = Date.now();

    const result = await collect({
      tokenAddress:   token,
      poolAddress:    null,   // holder-only mode (no pool required)
      marketCapUsd:   null,
      liquidityUsd:   null,
      holderCount:    null,
      tokenCreatedAt: null,
      enqueuedAt:     new Date().toISOString(),
      attempts:       1,
    });

    const elapsed = Date.now() - t0;
    log(``);
    log(`── Result ──`);
    log(`elapsed             : ${elapsed}ms`);
    log(`tradersCollected    : ${result.tradersCollected}`);
    log(`buyersCollected     : ${result.buyersCollected}`);
    log(`sellersCollected    : ${result.sellersCollected}`);
    log(`errors (${result.errors.length})         : ${result.errors.length === 0 ? "none ✓" : result.errors.join(" | ")}`);
    log(``);

    // ── Re-check row counts ────────────────────────────────────────────────────
    log(`── Row counts after collection ──`);
    const [w2, a2, p2, j2] = await Promise.all([
      checkTable(sb.sbClient, "wallets"),
      checkTable(sb.sbClient, "wallet_token_activity"),
      checkTable(sb.sbClient, "wallet_performance_history"),
      checkTable(sb.sbClient, "wallet_collection_jobs"),
    ]);
    log(`wallets                 : ${w2.rows} rows`);
    log(`wallet_token_activity   : ${a2.rows} rows`);
    log(`wallet_performance_hist : ${p2.rows} rows`);
    log(`wallet_collection_jobs  : ${j2.rows} rows  (not updated by test — direct collect() only)`);
    log(``);

    if (result.tradersCollected === 0) {
      log(`⚠  0 traders collected. Possible reasons:`);
      log(`   • Token has no on-chain holder accounts yet (very new token)`);
      log(`   • Helius RPC rate-limited — wait 30s and retry`);
      log(`   • Try a different token: ?token=DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 (BONK)`);
    } else {
      log(`✓ Collection succeeded. Check Supabase tables — rows should be visible now.`);
    }

    return new Response(logs.join("\n"), {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
});
