// =============================================================================
// /api/wallet-debug — Diagnostic endpoint
//
// Visit this URL to see exactly what is working and what is broken.
// Returns JSON with env var status, Supabase connectivity, table existence.
//
// Usage: https://your-app.railway.app/api/wallet-debug
// (Remove this file from production once everything is confirmed working.)
// =============================================================================

import { createAPIFileRoute } from "@tanstack/react-start/api";
import { createClient } from "@supabase/supabase-js";

async function tableExists(sb: ReturnType<typeof createClient>, tableName: string): Promise<{ exists: boolean; rowCount: number | null; error: string | null }> {
  try {
    const { count, error } = await sb
      .from(tableName)
      .select("*", { count: "exact", head: true });

    if (error) {
      return { exists: false, rowCount: null, error: error.message };
    }
    return { exists: true, rowCount: count ?? 0, error: null };
  } catch (err) {
    return { exists: false, rowCount: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export const APIRoute = createAPIFileRoute("/api/wallet-debug")({
  GET: async () => {
    const url =
      process.env.SUPABASE_URL ??
      process.env.VITE_SUPABASE_URL ??
      "";

    const keyServiceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const keyAnon        = process.env.SUPABASE_ANON_KEY;
    const keyPublishable = process.env.SUPABASE_PUBLISHABLE_KEY;
    const heliusKey      = process.env.HELIUS_API_KEY;

    const key = keyServiceRole ?? keyAnon ?? keyPublishable ?? "";

    const envReport = {
      SUPABASE_URL:              url ? `${url.slice(0, 35)}…` : "MISSING ✗",
      SUPABASE_SERVICE_ROLE_KEY: keyServiceRole ? "SET ✓" : "MISSING",
      SUPABASE_ANON_KEY:         keyAnon        ? "SET ✓" : "MISSING",
      SUPABASE_PUBLISHABLE_KEY:  keyPublishable ? "SET ✓" : "MISSING",
      HELIUS_API_KEY:            heliusKey      ? "SET ✓" : "MISSING ✗ (Step 3 holder collection still works)",
      activeKeyType:             keyServiceRole ? "service_role" : keyAnon ? "anon" : keyPublishable ? "publishable" : "NONE ✗",
    };

    if (!url || !key) {
      return new Response(
        JSON.stringify({
          status:   "BROKEN",
          problem:  "Supabase credentials not set. Add SUPABASE_URL and SUPABASE_ANON_KEY (or SERVICE_ROLE_KEY) in Railway environment variables.",
          env:      envReport,
          tables:   null,
        }, null, 2),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    const sb = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const [wallets, activity, performance, jobs] = await Promise.all([
      tableExists(sb, "wallets"),
      tableExists(sb, "wallet_token_activity"),
      tableExists(sb, "wallet_performance_history"),
      tableExists(sb, "wallet_collection_jobs"),
    ]);

    const allTablesExist =
      wallets.exists && activity.exists && performance.exists && jobs.exists;

    const missingTables = [
      !wallets.exists      && "wallets",
      !activity.exists     && "wallet_token_activity",
      !performance.exists  && "wallet_performance_history",
      !jobs.exists         && "wallet_collection_jobs",
    ].filter(Boolean);

    const status = !allTablesExist
      ? "TABLES_MISSING"
      : "OK";

    const problem = !allTablesExist
      ? `Tables not found in Supabase: ${missingTables.join(", ")}. Paste supabase/APPLY-IN-SQL-EDITOR.sql into Supabase Dashboard → SQL Editor and run it.`
      : null;

    return new Response(
      JSON.stringify({
        status,
        problem,
        env: envReport,
        tables: {
          wallets:                      wallets,
          wallet_token_activity:        activity,
          wallet_performance_history:   performance,
          wallet_collection_jobs:       jobs,
        },
        nextStep: !allTablesExist
          ? "Run supabase/APPLY-IN-SQL-EDITOR.sql in the Supabase Dashboard SQL Editor."
          : "Tables exist. Run a token scan and check Railway logs for [WalletTrigger] and [WalletWorker] lines.",
      }, null, 2),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  },
});
