// =============================================================================
// Wallet Collection Trigger — server function  (v2 — Railway fix)
//
// Architecture:
//   The handler inserts the job row, marks it processing, then IMMEDIATELY
//   returns the HTTP response. collect() runs in the background on the Node.js
//   event loop — fully decoupled from the HTTP request lifecycle.
//
// Railway fix (v2):
//   - URL lookup checks process.env FIRST (runtime-safe). import.meta.env is
//     last resort because it is baked at Vite build time and may be empty if
//     VITE_SUPABASE_URL wasn't available during the Railway RAILPACK build.
//   - Status update (done/failed) uses a fresh Supabase client created AFTER
//     collect() finishes, not before. This avoids credential timing issues.
//   - Status is ALWAYS updated regardless of whether collect() succeeded.
//     Previously, if the background client returned null, the job was silently
//     left stuck in "processing" forever.
// =============================================================================

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { collect } from "./wallet-collection-worker";

const LOG = "[WalletTrigger]";

// ---------------------------------------------------------------------------
// Supabase — always resolved at call time from process.env (runtime-safe)
// ---------------------------------------------------------------------------

function getSupabaseUrl(): string {
  return (
    process.env.SUPABASE_URL ??
    process.env.VITE_SUPABASE_URL ??
    (import.meta.env.VITE_SUPABASE_URL as string | undefined) ??
    ""
  );
}

function getSupabaseKey(): string {
  return (
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_ANON_KEY ??
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.VITE_SUPABASE_ANON_KEY ??
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    ""
  );
}

function getSupabase() {
  const url = getSupabaseUrl();
  const key = getSupabaseKey();
  if (!url || !key) {
    console.warn(
      `${LOG} Supabase env vars not set. DB writes will be skipped.\n` +
      `  SUPABASE_URL              = ${process.env.SUPABASE_URL ? "SET" : "MISSING"}\n` +
      `  VITE_SUPABASE_URL         = ${process.env.VITE_SUPABASE_URL ? "SET" : "MISSING"}\n` +
      `  SUPABASE_SERVICE_ROLE_KEY = ${process.env.SUPABASE_SERVICE_ROLE_KEY ? "SET" : "MISSING"}\n` +
      `  SUPABASE_ANON_KEY         = ${process.env.SUPABASE_ANON_KEY ? "SET" : "MISSING"}`,
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

const solanaAddress = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "Invalid Solana address");

const inputSchema = z.object({
  tokenAddress:   solanaAddress,
  poolAddress:    solanaAddress.optional().nullable(),
  marketCapUsd:   z.number().positive().optional().nullable(),
  liquidityUsd:   z.number().positive().optional().nullable(),
  holderCount:    z.number().int().positive().optional().nullable(),
  tokenCreatedAt: z.number().int().optional().nullable(),
});

// ---------------------------------------------------------------------------
// Background collection runner — decoupled from HTTP lifecycle
//
// KEY FIX: collect() runs first, THEN a fresh Supabase client is created for
// the status update. This avoids the case where the pre-created client was
// null (credential timing issue) and the job was silently stuck in processing.
// ---------------------------------------------------------------------------

async function runCollectionInBackground(
  data: z.infer<typeof inputSchema>,
  jobId: string | null,
): Promise<void> {
  let collectResult: Awaited<ReturnType<typeof collect>> | null = null;
  let collectError: string | null = null;

  try {
    console.log(`${LOG} [bg] collect() START token=${data.tokenAddress} pool=${data.poolAddress ?? "none"}`);

    collectResult = await collect({
      tokenAddress:   data.tokenAddress,
      poolAddress:    data.poolAddress ?? null,
      marketCapUsd:   data.marketCapUsd ?? null,
      liquidityUsd:   data.liquidityUsd ?? null,
      holderCount:    data.holderCount ?? null,
      tokenCreatedAt: data.tokenCreatedAt ?? null,
      enqueuedAt:     new Date().toISOString(),
      attempts:       1,
    });

    console.log(
      `${LOG} [bg] collect() DONE token=${data.tokenAddress} ` +
      `traders=${collectResult.tradersCollected} buyers=${collectResult.buyersCollected} ` +
      `sellers=${collectResult.sellersCollected} errors=${collectResult.errors.length}`,
    );
  } catch (err) {
    collectError = err instanceof Error ? err.message : String(err);
    console.error(`${LOG} [bg] collect() threw for ${data.tokenAddress}: ${collectError}`, err);
  }

  // --- Status update: always runs, fresh client created AFTER collect() ---
  if (!jobId) {
    console.warn(`${LOG} [bg] No jobId — cannot update wallet_collection_jobs status`);
    return;
  }

  // Fresh client is created NOW (after collect) so Railway env is guaranteed
  // to be fully initialised — no more silent null from timing issues.
  const sb = getSupabase();

  if (!sb) {
    console.error(
      `${LOG} [bg] Cannot update job ${jobId} status — Supabase credentials still unavailable after collect().\n` +
      `  url=${getSupabaseUrl() ? "SET" : "MISSING"}  key=${getSupabaseKey() ? "SET" : "MISSING"}\n` +
      `  Ensure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set in Railway → Variables.`,
    );
    return;
  }

  if (collectError) {
    const { error: e } = await sb
      .from("wallet_collection_jobs")
      .update({
        status:       "failed",
        last_error:   collectError,
        completed_at: new Date().toISOString(),
      })
      .eq("id", jobId);
    if (e) console.error(`${LOG} [bg] job ${jobId} UPDATE (failed) error: ${e.message}`);
    else    console.log(`${LOG} [bg] job ${jobId} marked failed`);
    return;
  }

  if (collectResult) {
    const { error: e } = await sb
      .from("wallet_collection_jobs")
      .update({
        status:            "done",
        traders_collected: collectResult.tradersCollected,
        buyers_collected:  collectResult.buyersCollected,
        sellers_collected: collectResult.sellersCollected,
        errors:            collectResult.errors.length > 0 ? collectResult.errors : null,
        completed_at:      new Date().toISOString(),
      })
      .eq("id", jobId);
    if (e) console.error(`${LOG} [bg] job ${jobId} UPDATE (done) error: ${e.message}`);
    else    console.log(`${LOG} [bg] job ${jobId} marked done`);
  }
}

// ---------------------------------------------------------------------------
// Server function — returns IMMEDIATELY, collection runs in background
// ---------------------------------------------------------------------------

export const enqueueWalletCollection = createServerFn({ method: "POST" })
  .inputValidator(inputSchema)
  .handler(async ({ data }) => {
    console.log(
      `${LOG} ▶ ENQUEUE token=${data.tokenAddress} pool=${data.poolAddress ?? "none"} ` +
      `mcap=${data.marketCapUsd ?? "?"} liq=${data.liquidityUsd ?? "?"} holders=${data.holderCount ?? "?"}`,
    );

    const sb = getSupabase();
    let jobId: string | null = null;

    // Step 1 — Insert job record
    if (sb) {
      try {
        const { data: row, error } = await sb
          .from("wallet_collection_jobs")
          .insert({
            token_address:  data.tokenAddress,
            pool_address:   data.poolAddress ?? null,
            status:         "pending",
            attempts:       0,
            market_cap_usd: data.marketCapUsd ?? null,
            liquidity_usd:  data.liquidityUsd ?? null,
            holder_count:   data.holderCount  ?? null,
            enqueued_at:    new Date().toISOString(),
          })
          .select("id")
          .single();

        if (error) {
          console.error(`${LOG} wallet_collection_jobs INSERT error: ${error.message}`);
        } else {
          jobId = (row as { id: string } | null)?.id ?? null;
          console.log(`${LOG} wallet_collection_jobs row created id=${jobId}`);
        }
      } catch (err) {
        console.error(`${LOG} wallet_collection_jobs INSERT exception:`, err);
      }
    } else {
      console.error(`${LOG} No Supabase client — job row and DB writes skipped.`);
    }

    // Step 2 — Mark as processing
    if (sb && jobId) {
      await sb
        .from("wallet_collection_jobs")
        .update({ status: "processing", started_at: new Date().toISOString(), attempts: 1 })
        .eq("id", jobId);
    }

    // Step 3 — Fire background collection WITHOUT blocking the HTTP response.
    void runCollectionInBackground(data, jobId);

    // Return immediately
    return {
      success:      true,
      jobId,
      tokenAddress: data.tokenAddress,
    };
  });

// ---------------------------------------------------------------------------
// getQueueStatus — monitoring endpoint
// ---------------------------------------------------------------------------

export const getQueueStatus = createServerFn({ method: "GET" })
  .inputValidator(z.object({}))
  .handler(async () => {
    const sb = getSupabase();
    if (!sb) return { jobs: [], total: 0 };

    const { data, error } = await sb
      .from("wallet_collection_jobs")
      .select("*")
      .order("enqueued_at", { ascending: false })
      .limit(20);

    if (error) {
      console.error(`${LOG} getQueueStatus error: ${error.message}`);
      return { jobs: [], total: 0 };
    }

    return { jobs: data ?? [], total: data?.length ?? 0 };
  });
