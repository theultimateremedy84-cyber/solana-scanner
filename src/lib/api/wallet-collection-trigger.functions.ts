// =============================================================================
// Wallet Collection Trigger — server function
//
// Architecture: collect() is called DIRECTLY inside the handler.
// No queue, no singleton, no setInterval.
//
// The client fires-and-forgets this call, so it doesn't matter that the
// handler takes 10–30 s to complete — the scan result is already on screen.
//
// Pipeline (all in one handler call):
//   1. Insert wallet_collection_jobs row (status=pending)
//   2. Update row to status=processing
//   3. Call collect() → writes wallet_token_activity, wallets, wallet_performance_history
//   4. Update row to status=done / failed
//
// Usage in index.tsx (fire-and-forget — do NOT await):
//
//   enqueueWalletCollection({
//     data: {
//       tokenAddress: live.address,
//       marketCapUsd: live.marketCap ?? null,
//       liquidityUsd: live.liquidity ?? null,
//       holderCount: live.holders ?? null,
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
// Supabase — uses the same env vars as the rest of this project's server code
// ---------------------------------------------------------------------------

function getSupabase() {
  // import.meta.env.VITE_SUPABASE_URL is baked in at Vite build time and is
  // guaranteed to resolve correctly in Railway. process.env.SUPABASE_URL is
  // kept as a fallback for local / non-Vite environments.
  const url =
    (import.meta.env.VITE_SUPABASE_URL as string | undefined) ??
    process.env.SUPABASE_URL ??
    "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    "";
  if (!url || !key) {
    console.warn(`${LOG} Supabase env vars not set (VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY). DB writes will be skipped.`);
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
  tokenAddress: solanaAddress,
  poolAddress: z
    .string()
    .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
    .optional()
    .nullable(),
  marketCapUsd: z.number().positive().optional().nullable(),
  liquidityUsd: z.number().positive().optional().nullable(),
  holderCount: z.number().int().positive().optional().nullable(),
  tokenCreatedAt: z.number().int().optional().nullable(),
});

// ---------------------------------------------------------------------------
// Server function
// ---------------------------------------------------------------------------

export const enqueueWalletCollection = createServerFn({ method: "POST" })
  .inputValidator(inputSchema)
  .handler(async ({ data }) => {
    const startMs = Date.now();
    console.log(
      `${LOG} ▶ START token=${data.tokenAddress} pool=${data.poolAddress ?? "none"} ` +
      `mcap=${data.marketCapUsd ?? "?"} liq=${data.liquidityUsd ?? "?"} holders=${data.holderCount ?? "?"}`,
    );

    const sb = getSupabase();
    let jobId: string | null = null;

    // -----------------------------------------------------------------------
    // Step 1 — Insert job record
    // -----------------------------------------------------------------------
    if (sb) {
      try {
        const { data: row, error } = await sb
          .from("wallet_collection_jobs")
          .insert({
            token_address: data.tokenAddress,
            pool_address: data.poolAddress ?? null,
            status: "pending",
            attempts: 0,
            market_cap_usd: data.marketCapUsd ?? null,
            liquidity_usd: data.liquidityUsd ?? null,
            holder_count: data.holderCount ?? null,
            enqueued_at: new Date().toISOString(),
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
      console.error(`${LOG} No Supabase client — job row and DB writes will be skipped.`);
    }

    // -----------------------------------------------------------------------
    // Step 2 — Mark as processing
    // -----------------------------------------------------------------------
    if (sb && jobId) {
      await sb
        .from("wallet_collection_jobs")
        .update({ status: "processing", started_at: new Date().toISOString(), attempts: 1 })
        .eq("id", jobId);
    }

    // -----------------------------------------------------------------------
    // Step 3 — Run collection (writes wallet_token_activity, wallets, wallet_performance_history)
    // -----------------------------------------------------------------------
    let collectionOk = false;
    let tradersCollected = 0;
    let lastError: string | null = null;

    try {
      const result = await collect({
        tokenAddress: data.tokenAddress,
        poolAddress: data.poolAddress ?? null,
        marketCapUsd: data.marketCapUsd ?? null,
        liquidityUsd: data.liquidityUsd ?? null,
        holderCount: data.holderCount ?? null,
        tokenCreatedAt: data.tokenCreatedAt ?? null,
        enqueuedAt: new Date().toISOString(),
        attempts: 1,
      });

      tradersCollected = result.tradersCollected;
      collectionOk = true;
      const elapsed = Date.now() - startMs;

      console.log(
        `${LOG} ✓ DONE token=${data.tokenAddress} ` +
        `traders=${result.tradersCollected} buyers=${result.buyersCollected} ` +
        `sellers=${result.sellersCollected} elapsed=${elapsed}ms errors=${result.errors.length}`,
      );

      // Step 4a — Mark as done
      if (sb && jobId) {
        await sb
          .from("wallet_collection_jobs")
          .update({
            status: "done",
            traders_collected: result.tradersCollected,
            buyers_collected: result.buyersCollected,
            sellers_collected: result.sellersCollected,
            skipped_dust: result.skippedDust,
            errors: result.errors.length > 0 ? result.errors : null,
            completed_at: new Date().toISOString(),
          })
          .eq("id", jobId);
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.error(`${LOG} ✗ collect() threw for ${data.tokenAddress}: ${lastError}`, err);

      // Step 4b — Mark as failed
      if (sb && jobId) {
        await sb
          .from("wallet_collection_jobs")
          .update({
            status: "failed",
            last_error: lastError,
            completed_at: new Date().toISOString(),
          })
          .eq("id", jobId);
      }
    }

    return {
      success: collectionOk,
      tradersCollected,
      jobId,
      tokenAddress: data.tokenAddress,
      ...(lastError ? { error: lastError } : {}),
    };
  });

// ---------------------------------------------------------------------------
// getQueueStatus — monitoring endpoint (reads wallet_collection_jobs table)
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
