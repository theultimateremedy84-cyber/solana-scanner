// =============================================================================
// Wallet Collection Trigger  (v6 — env-var fix)
//
// Calls collect() DIRECTLY inside the handler. No queue, no singleton, no timer.
// Tries every Supabase key the project might have set in Railway.
// =============================================================================

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { collect } from "./wallet-collection-worker";

const LOG = "[WalletTrigger]";

// ---------------------------------------------------------------------------
// Supabase — mirrors scan.functions.ts key priority
// ---------------------------------------------------------------------------

function getSupabase() {
  const url =
    process.env.SUPABASE_URL ??
    process.env.VITE_SUPABASE_URL ??
    "";

  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_ANON_KEY ??           // ← matches scan.functions.ts
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.VITE_SUPABASE_ANON_KEY ??
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    "";

  if (!url || !key) {
    console.error(
      `${LOG} ✗ No Supabase credentials found.\n` +
      `  SUPABASE_URL=${process.env.SUPABASE_URL ? "SET" : "MISSING"}  ` +
      `SERVICE_ROLE_KEY=${process.env.SUPABASE_SERVICE_ROLE_KEY ? "SET" : "MISSING"}  ` +
      `ANON_KEY=${process.env.SUPABASE_ANON_KEY ? "SET" : "MISSING"}`,
    );
    return null;
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const solanaAddress = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "Invalid Solana address");

// ---------------------------------------------------------------------------
// enqueueWalletCollection — collects wallet data inline after a scan
// ---------------------------------------------------------------------------

export const enqueueWalletCollection = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      tokenAddress:   solanaAddress,
      poolAddress:    z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).optional().nullable(),
      marketCapUsd:   z.number().positive().optional().nullable(),
      liquidityUsd:   z.number().positive().optional().nullable(),
      holderCount:    z.number().int().positive().optional().nullable(),
      tokenCreatedAt: z.number().int().optional().nullable(),
    }),
  )
  .handler(async ({ data }) => {
    const startMs = Date.now();
    console.log(
      `${LOG} ▶ START token=${data.tokenAddress} pool=${data.poolAddress ?? "none"} ` +
      `mcap=${data.marketCapUsd ?? "?"} liq=${data.liquidityUsd ?? "?"} holders=${data.holderCount ?? "?"}`,
    );

    const sb = getSupabase();
    let jobId: string | null = null;

    // ------------------------------------------------------------------
    // 1. Insert job record (status = pending)
    // ------------------------------------------------------------------
    if (sb) {
      try {
        const { data: row, error } = await sb
          .from("wallet_collection_jobs")
          .insert({
            token_address: data.tokenAddress,
            pool_address:  data.poolAddress ?? null,
            status:        "pending",
            attempts:      0,
            market_cap_usd: data.marketCapUsd ?? null,
            liquidity_usd:  data.liquidityUsd ?? null,
            holder_count:   data.holderCount ?? null,
            enqueued_at:    new Date().toISOString(),
          })
          .select("id")
          .single();

        if (error) {
          // Surface the error clearly — most likely means the table doesn't exist yet
          console.error(
            `${LOG} wallet_collection_jobs INSERT failed: ${error.message}\n` +
            `  → If you see "relation does not exist", paste supabase/APPLY-IN-SQL-EDITOR.sql into Supabase SQL Editor.`,
          );
        } else {
          jobId = (row as { id: string } | null)?.id ?? null;
          console.log(`${LOG} wallet_collection_jobs row created id=${jobId}`);
        }
      } catch (err) {
        console.error(`${LOG} wallet_collection_jobs INSERT exception:`, err);
      }
    } else {
      console.error(`${LOG} No Supabase client — check SUPABASE_URL / SUPABASE_ANON_KEY env vars in Railway.`);
    }

    // ------------------------------------------------------------------
    // 2. Mark as processing
    // ------------------------------------------------------------------
    if (sb && jobId) {
      await sb
        .from("wallet_collection_jobs")
        .update({ status: "processing", started_at: new Date().toISOString(), attempts: 1 })
        .eq("id", jobId);
    }

    // ------------------------------------------------------------------
    // 3. Run collection
    // ------------------------------------------------------------------
    let collectionOk = false;
    let tradersCollected = 0;
    let lastError: string | null = null;

    try {
      const result = await collect({
        tokenAddress:   data.tokenAddress,
        poolAddress:    data.poolAddress ?? null,
        marketCapUsd:   data.marketCapUsd ?? null,
        liquidityUsd:   data.liquidityUsd ?? null,
        holderCount:    data.holderCount ?? null,
        tokenCreatedAt: data.tokenCreatedAt ?? null,
        enqueuedAt:     new Date().toISOString(),
        attempts:       1,
      });

      tradersCollected = result.tradersCollected;
      collectionOk     = true;
      const elapsed    = Date.now() - startMs;

      console.log(
        `${LOG} ✓ DONE token=${data.tokenAddress} ` +
        `traders=${result.tradersCollected} buyers=${result.buyersCollected} ` +
        `sellers=${result.sellersCollected} elapsed=${elapsed}ms errors=${result.errors.length}`,
      );

      if (sb && jobId) {
        await sb
          .from("wallet_collection_jobs")
          .update({
            status:            "done",
            traders_collected: result.tradersCollected,
            buyers_collected:  result.buyersCollected,
            sellers_collected: result.sellersCollected,
            skipped_dust:      result.skippedDust,
            errors:            result.errors.length > 0 ? result.errors : null,
            completed_at:      new Date().toISOString(),
          })
          .eq("id", jobId);
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.error(`${LOG} ✗ collect() threw for ${data.tokenAddress}: ${lastError}`, err);

      if (sb && jobId) {
        await sb
          .from("wallet_collection_jobs")
          .update({ status: "failed", last_error: lastError, completed_at: new Date().toISOString() })
          .eq("id", jobId);
      }
    }

    return {
      success:          collectionOk,
      tradersCollected,
      jobId,
      tokenAddress:     data.tokenAddress,
      ...(lastError ? { error: lastError } : {}),
    };
  });

// ---------------------------------------------------------------------------
// getQueueStatus — reads wallet_collection_jobs for monitoring
// ---------------------------------------------------------------------------

export const getQueueStatus = createServerFn({ method: "GET" })
  .inputValidator(z.object({}))
  .handler(async () => {
    const sb = getSupabase();
    if (!sb) return { jobs: [], total: 0, error: "Supabase not configured" };

    const { data, error } = await sb
      .from("wallet_collection_jobs")
      .select("*")
      .order("enqueued_at", { ascending: false })
      .limit(20);

    if (error) return { jobs: [], total: 0, error: error.message };
    return { jobs: data ?? [], total: data?.length ?? 0 };
  });
