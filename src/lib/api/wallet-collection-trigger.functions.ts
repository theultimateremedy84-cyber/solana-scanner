// =============================================================================
// Wallet Collection Trigger — server functions
//
// Call enqueueWalletCollection() from the client after a scan completes.
// It is a fire-and-forget server function: it enqueues the job and returns
// immediately without waiting for collection to finish.
//
// Usage (client-side, after scanTokenLive resolves):
//
//   import { enqueueWalletCollection } from "@/lib/api/wallet-collection-trigger.functions";
//
//   enqueueWalletCollection({
//     data: {
//       tokenAddress: live.address,
//       marketCapUsd: live.marketCap ?? null,
//       liquidityUsd: live.liquidity ?? null,
//       holderCount: live.holders ?? null,
//     }
//   }).catch((err) => console.error("[enqueueWalletCollection] Failed:", err));
//
// poolAddress is OPTIONAL. Without it the worker collects significant holders
// only (skips trade-history). Passing it enables full buyer/seller collection.
// =============================================================================

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { WalletCollectionQueue } from "./wallet-collection-queue";

const LOG = "[enqueueWalletCollection]";

const solanaAddress = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "Invalid Solana address");

// ---------------------------------------------------------------------------
// enqueueWalletCollection
// ---------------------------------------------------------------------------

/**
 * Enqueue a wallet collection job for a token.
 *
 * This server function returns immediately — collection runs in the background.
 * poolAddress is optional; omitting it activates holder-only collection mode.
 */
export const enqueueWalletCollection = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
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
    }),
  )
  .handler(async ({ data }) => {
    console.log(
      `${LOG} Received trigger for token=${data.tokenAddress} pool=${data.poolAddress ?? "none"} ` +
      `mcap=${data.marketCapUsd ?? "?"} liq=${data.liquidityUsd ?? "?"} holders=${data.holderCount ?? "?"}`,
    );

    try {
      const queue = WalletCollectionQueue.getInstance();

      // Idempotent — safe to call on every trigger.
      queue.start();

      const jobInput = {
        tokenAddress: data.tokenAddress,
        poolAddress: data.poolAddress ?? null,
        marketCapUsd: data.marketCapUsd ?? null,
        liquidityUsd: data.liquidityUsd ?? null,
        holderCount: data.holderCount ?? null,
        tokenCreatedAt: data.tokenCreatedAt ?? null,
      };

      console.log(`${LOG} Calling queue.enqueue for ${data.tokenAddress}`);
      await queue.enqueue(jobInput);

      const pending = queue.pendingCount;
      console.log(
        `${LOG} Enqueue complete for ${data.tokenAddress}. Queue depth: ${pending}`,
      );

      return {
        queued: true,
        pendingCount: pending,
        tokenAddress: data.tokenAddress,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`${LOG} Failed to enqueue ${data.tokenAddress}: ${message}`, err);
      return { queued: false, pendingCount: 0, tokenAddress: data.tokenAddress };
    }
  });

// ---------------------------------------------------------------------------
// getQueueStatus — monitoring endpoint
// ---------------------------------------------------------------------------

/**
 * Returns the current queue snapshot for debugging / monitoring.
 */
export const getQueueStatus = createServerFn({ method: "GET" })
  .inputValidator(z.object({}))
  .handler(async () => {
    const queue = WalletCollectionQueue.getInstance();
    const snapshot = queue.snapshot();
    return {
      pendingCount: queue.pendingCount,
      totalJobs: snapshot.length,
      jobs: snapshot.map((j) => ({
        tokenAddress: j.tokenAddress,
        poolAddress: j.poolAddress ?? null,
        status: j.status,
        attempts: j.attempts,
        enqueuedAt: j.enqueuedAt,
        lastError: j.lastError ?? null,
        dbJobId: j.dbJobId ?? null,
      })),
    };
  });
