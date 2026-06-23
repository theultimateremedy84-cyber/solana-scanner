// =============================================================================
// Wallet Collection Trigger — server function
//
// Architecture (FIXED):
//   The handler inserts the job row, marks it processing, then IMMEDIATELY
//   returns the HTTP response. collect() runs in the background on the Node.js
//   event loop — fully decoupled from the HTTP request lifecycle so Railway's
//   connection timeout or client disconnection can never leave a job stuck
//   at "processing".
//
// Pipeline:
//   1. Insert wallet_collection_jobs row (status=pending)
//   2. Update row to status=processing
//   3. Return HTTP response immediately ← KEY FIX
//   4. collect() runs in background → writes wallet_token_activity, wallets,
//      wallet_performance_history
//   5. Update row to status=done / failed
//
// Usage in index.tsx (fire-and-forget — do NOT await):
//
//   enqueueWalletCollection({
//     data: {
//       tokenAddress: live.address,
//       poolAddress:  live.poolAddress ?? null,
//       marketCapUsd: live.marketCap ?? null,
//       liquidityUsd: live.liquidity ?? null,
//       holderCount:  live.holders ?? null,
//     },
//   }).catch((err) =>
//     console.error("[enqueueWalletCollection] Failed:", err instanceof Error ? err.message : String(err)),
//   );
// =============================================================================

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { collect } from "./wallet-collection-worker";

const LOG = "[WalletTrigger]";

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

function getSupabase() {
  const url =
    (import.meta.env.VITE_SUPABASE_URL as string | undefined) ??
    process.env.SUPABASE_URL ??
    process.env.VITE_SUPABASE_URL ??
    "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    "";
  if (!url || !key) {
    console.warn(
      `${LOG} Supabase env vars not set. DB writes will be skipped.\n` +
      `  VITE_SUPABASE_URL (baked) = ${(import.meta.env.VITE_SUPABASE_URL as string | undefined) ? "SET" : "MISSING"}\n` +
      `  SUPABASE_URL              = ${process.env.SUPABASE_URL ? "SET" : "MISSING"}\n` +
      `  SUPABASE_SERVICE_ROLE_KEY = ${process.env.SUPABASE_SERVICE_ROLE_KEY ? "SET" : "MISSING"}`,
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
// ---------------------------------------------------------------------------

async function runCollectionInBackground(
  data: z.infer<typeof inputSchema>,
  jobId: string | null,
): Promise<void> {
  // Create a fresh Supabase client inside the background task so it is
  // fully independent of the request-scoped client.
  const sb = getSupabase();

  try {
    console.log(`${LOG} [bg] collect() START token=${data.tokenAddress} pool=${data.poolAddress ?? "none"}`);

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

    console.log(
      `${LOG} [bg] collect() DONE token=${data.tokenAddress} ` +
      `traders=${result.tradersCollected} buyers=${result.buyersCollected} ` +
      `sellers=${result.sellersCollected} errors=${result.errors.length}`,
    );

    if (sb && jobId) {
      const { error } = await sb
        .from("wallet_collection_jobs")
        .update({
          status:            "done",
          traders_collected: result.tradersCollected,
          buyers_collected:  result.buyersCollected,
          sellers_collected: result.sellersCollected,
          errors:            result.errors.length > 0 ? result.errors : null,
          completed_at:      new Date().toISOString(),
        })
        .eq("id", jobId);

      if (error) {
        console.error(`${LOG} [bg] wallet_collection_jobs UPDATE (done) error: ${error.message}`);
      } else {
        console.log(`${LOG} [bg] job ${jobId} marked done`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${LOG} [bg] collect() threw for ${data.tokenAddress}: ${msg}`, err);

    if (sb && jobId) {
      await sb
        .from("wallet_collection_jobs")
        .update({
          status:       "failed",
          last_error:   msg,
          completed_at: new Date().toISOString(),
        })
        .eq("id", jobId)
        .then(({ error: e }) => {
          if (e) console.error(`${LOG} [bg] wallet_collection_jobs UPDATE (failed) error: ${e.message}`);
          else    console.log(`${LOG} [bg] job ${jobId} marked failed`);
        });
    }
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
    //
    // By NOT awaiting runCollectionInBackground(), the handler returns
    // immediately. The async task continues on the Node.js event loop even
    // after the HTTP response is sent. This means:
    //   • Railway's proxy timeout cannot kill the collection mid-run.
    //   • Client disconnection has no effect on collection completion.
    //   • Jobs reliably transition to "done" or "failed".
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
