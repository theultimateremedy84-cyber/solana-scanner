// =============================================================================
// Wallet Collection Trigger — server functions
//
// Call enqueueWalletCollection() from the client after a scan completes.
// It is a fire-and-forget server function: it enqueues the job and returns
// immediately without waiting for collection to finish.
//
// The scanner continues operating normally regardless of whether this
// call succeeds or whether the background collection job fails.
//
// Usage (client-side, after scanTokenLive resolves):
//
//   import { enqueueWalletCollection } from "@/lib/api/wallet-collection-trigger.functions";
//
//   // Fire and forget — do not await, do not block the scan result render
//   enqueueWalletCollection({
//     data: {
//       tokenAddress: result.address,
//       poolAddress: result.poolAddress,     // from ScanResult
//       marketCapUsd: result.marketCap ?? null,
//       liquidityUsd: result.liquidity ?? null,
//       holderCount: result.holderCount ?? null,
//     }
//   }).catch(() => { /* intentionally swallowed */ });
//
// =============================================================================

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { WalletCollectionQueue } from "./wallet-collection-queue";

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
 * It is safe to call even if the WalletCollectionQueue has not been started;
 * the job will be processed as soon as the queue processes its next tick.
 *
 * Always collect regardless of token quality.
 * Filtering (dust, airdrops, zero-value) happens inside the worker.
 */
export const enqueueWalletCollection = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      tokenAddress: solanaAddress,
      poolAddress: z
        .string()
        .min(32)
        .max(44)
        .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "Invalid pool address"),
      marketCapUsd: z.number().positive().optional().nullable(),
      liquidityUsd: z.number().positive().optional().nullable(),
      holderCount: z.number().int().positive().optional().nullable(),
      tokenCreatedAt: z.number().int().optional().nullable(),
    }),
  )
  .handler(async ({ data }) => {
    try {
      const queue = WalletCollectionQueue.getInstance();

      // Start the queue if it hasn't been started yet.
      // Idempotent — safe to call on every trigger.
      queue.start();

      queue.enqueue({
        tokenAddress: data.tokenAddress,
        poolAddress: data.poolAddress,
        marketCapUsd: data.marketCapUsd ?? null,
        liquidityUsd: data.liquidityUsd ?? null,
        holderCount: data.holderCount ?? null,
        tokenCreatedAt: data.tokenCreatedAt ?? null,
      });

      return {
        queued: true,
        pendingCount: queue.pendingCount,
        tokenAddress: data.tokenAddress,
      };
    } catch (err) {
      // Never fail the caller — log and return a safe error response
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[enqueueWalletCollection] Failed to enqueue ${data.tokenAddress}: ${message}`,
      );
      return { queued: false, pendingCount: 0, tokenAddress: data.tokenAddress };
    }
  });

// ---------------------------------------------------------------------------
// getQueueStatus — monitoring endpoint
// ---------------------------------------------------------------------------

/**
 * Returns the current queue snapshot for debugging / monitoring.
 * Use this to check queue depth and job statuses in development.
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
        poolAddress: j.poolAddress,
        status: j.status,
        attempts: j.attempts,
        enqueuedAt: j.enqueuedAt,
        lastError: j.lastError ?? null,
      })),
    };
  });
