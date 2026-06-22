// =============================================================================
// Wallet Collection Queue
//
// Singleton in-memory async queue for wallet collection jobs.
// Follows the same singleton pattern as PostLaunchWatcher.getInstance().
//
// - Max concurrency: 2 simultaneous collection jobs.
// - Deduplication: a token already in-queue or in-progress is not re-added.
// - Retry: up to 2 retries on network/worker errors.
// - Fail-safe: errors are logged but never propagate to callers.
// - Independent: the scanner, routes, and server startup code are unaffected
//   if the queue throws, stalls, or is not started.
// =============================================================================

import { collect } from "./wallet-collection-worker";
import type { QueueEntry, WalletCollectionJob } from "./wallet-collection.types";

const MAX_CONCURRENT = 2;
const MAX_RETRIES = 2;
const POLL_INTERVAL_MS = 2_000;
const LOG_PREFIX = "[WalletCollectionQueue]";

export class WalletCollectionQueue {
  private static _instance: WalletCollectionQueue | null = null;

  private readonly queue: QueueEntry[] = [];
  private activeCount = 0;
  private started = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  private constructor() {}

  /** Returns the process-level singleton queue. */
  static getInstance(): WalletCollectionQueue {
    if (!WalletCollectionQueue._instance) {
      WalletCollectionQueue._instance = new WalletCollectionQueue();
    }
    return WalletCollectionQueue._instance;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Start the background processing loop.
   * Safe to call multiple times — only starts once.
   *
   * Call this from server startup (e.g. alongside PostLaunchWatcher.start()).
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => this._tick(), POLL_INTERVAL_MS);
    // Don't block process exit on this timer
    if (this.timer.unref) this.timer.unref();
    console.log(`${LOG_PREFIX} Started (poll every ${POLL_INTERVAL_MS}ms, concurrency=${MAX_CONCURRENT}).`);
  }

  /** Stop the background loop (useful for tests or graceful shutdown). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
    console.log(`${LOG_PREFIX} Stopped.`);
  }

  /**
   * Add a token collection job to the queue.
   *
   * Idempotent — if the same tokenAddress is already pending or processing,
   * the new job is silently dropped. This prevents duplicate collection runs
   * when the scanner re-scans the same token quickly.
   *
   * Safe to call even if start() has not been called yet.
   * The job will be processed as soon as start() is called.
   */
  enqueue(job: Omit<WalletCollectionJob, "enqueuedAt" | "attempts">): void {
    const exists = this.queue.some(
      (e) =>
        e.tokenAddress === job.tokenAddress &&
        (e.status === "pending" || e.status === "processing"),
    );
    if (exists) {
      console.log(
        `${LOG_PREFIX} Job for ${job.tokenAddress} already in queue — skipping duplicate.`,
      );
      return;
    }

    const entry: QueueEntry = {
      ...job,
      enqueuedAt: new Date().toISOString(),
      attempts: 0,
      status: "pending",
    };
    this.queue.push(entry);
    console.log(
      `${LOG_PREFIX} Enqueued collection job for ${job.tokenAddress} (pool: ${job.poolAddress}). Queue depth: ${this.pendingCount}.`,
    );

    // If the loop is not started yet, kick off a single immediate tick
    // so jobs enqueued before start() don't wait
    if (!this.started) {
      setImmediate(() => this._tick());
    }
  }

  /** Number of jobs currently waiting to be processed. */
  get pendingCount(): number {
    return this.queue.filter((e) => e.status === "pending").length;
  }

  /** Current queue snapshot (read-only view for monitoring). */
  snapshot(): ReadonlyArray<Readonly<QueueEntry>> {
    return this.queue.slice();
  }

  // ---------------------------------------------------------------------------
  // Internal processing
  // ---------------------------------------------------------------------------

  private _tick(): void {
    // Trim completed / failed jobs older than 1 hour to prevent unbounded growth
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const e = this.queue[i];
      if (
        (e.status === "done" || e.status === "failed") &&
        new Date(e.enqueuedAt).getTime() < cutoff
      ) {
        this.queue.splice(i, 1);
      }
    }

    // Dispatch up to MAX_CONCURRENT jobs
    while (this.activeCount < MAX_CONCURRENT) {
      const next = this.queue.find((e) => e.status === "pending");
      if (!next) break;
      next.status = "processing";
      this.activeCount++;
      this._process(next);
    }
  }

  private async _process(entry: QueueEntry): Promise<void> {
    entry.attempts++;
    console.log(
      `${LOG_PREFIX} Processing ${entry.tokenAddress} (attempt ${entry.attempts}).`,
    );

    try {
      const result = await collect(entry);

      if (result.errors.length > 0) {
        console.warn(
          `${LOG_PREFIX} Collection for ${entry.tokenAddress} completed with warnings:`,
          result.errors,
        );
      }

      console.log(
        `${LOG_PREFIX} Collected ${result.tradersCollected} traders for ${entry.tokenAddress} ` +
          `(${result.buyersCollected} buyers, ${result.sellersCollected} sellers).`,
      );

      entry.status = "done";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      entry.lastError = message;

      if (entry.attempts <= MAX_RETRIES) {
        // Re-queue for retry
        entry.status = "pending";
        console.warn(
          `${LOG_PREFIX} Retrying ${entry.tokenAddress} (attempt ${entry.attempts}/${MAX_RETRIES}): ${message}`,
        );
      } else {
        entry.status = "failed";
        console.error(
          `${LOG_PREFIX} Failed ${entry.tokenAddress} after ${entry.attempts} attempts: ${message}`,
        );
      }
    } finally {
      this.activeCount = Math.max(0, this.activeCount - 1);
    }
  }
}
