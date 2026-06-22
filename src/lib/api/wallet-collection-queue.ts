// =============================================================================
// Wallet Collection Queue
//
// Singleton in-memory async queue for wallet collection jobs.
//
// - Max concurrency: 2 simultaneous collection jobs.
// - Deduplication: a token already in-queue or in-progress is not re-added.
// - Retry: up to 2 retries on network/worker errors.
// - Fail-safe: errors are logged but never propagate to callers.
// - DB persistence: each job is written to wallet_collection_jobs in Supabase.
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import { collect } from "./wallet-collection-worker";
import type { QueueEntry, WalletCollectionJob } from "./wallet-collection.types";

const MAX_CONCURRENT = 2;
const MAX_RETRIES = 2;
const POLL_INTERVAL_MS = 2_000;
const LOG = "[WalletCollectionQueue]";

// ---------------------------------------------------------------------------
// Supabase client (service-role preferred for queue writes)
// ---------------------------------------------------------------------------

function getSupabase() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_ANON_KEY ??
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    "";
  if (!url || !key) {
    console.warn(`${LOG} Supabase credentials not set — job rows will not be persisted.`);
    return null;
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ---------------------------------------------------------------------------
// DB helpers — wallet_collection_jobs
// ---------------------------------------------------------------------------

async function dbInsertJob(entry: QueueEntry): Promise<string | null> {
  const sb = getSupabase();
  if (!sb) return null;
  try {
    const { data, error } = await sb
      .from("wallet_collection_jobs")
      .insert({
        token_address: entry.tokenAddress,
        pool_address: entry.poolAddress ?? null,
        status: "pending",
        attempts: 0,
        market_cap_usd: entry.marketCapUsd ?? null,
        liquidity_usd: entry.liquidityUsd ?? null,
        holder_count: entry.holderCount ?? null,
        enqueued_at: entry.enqueuedAt,
      })
      .select("id")
      .single();

    if (error) {
      console.error(`${LOG} DB insert for ${entry.tokenAddress} failed: ${error.message}`);
      return null;
    }
    const id = (data as { id: string } | null)?.id ?? null;
    console.log(`${LOG} DB job row created id=${id} for ${entry.tokenAddress}`);
    return id;
  } catch (err) {
    console.error(`${LOG} DB insert exception for ${entry.tokenAddress}:`, err);
    return null;
  }
}

async function dbUpdateJob(
  dbJobId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  try {
    const { error } = await sb
      .from("wallet_collection_jobs")
      .update(patch)
      .eq("id", dbJobId);
    if (error) {
      console.error(`${LOG} DB update for job ${dbJobId} failed: ${error.message}`);
    }
  } catch (err) {
    console.error(`${LOG} DB update exception for job ${dbJobId}:`, err);
  }
}

// ---------------------------------------------------------------------------
// Queue class
// ---------------------------------------------------------------------------

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
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => this._tick(), POLL_INTERVAL_MS);
    if (this.timer.unref) this.timer.unref();
    console.log(
      `${LOG} Started — poll every ${POLL_INTERVAL_MS}ms, concurrency=${MAX_CONCURRENT}.`,
    );
  }

  /** Stop the background loop. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
    console.log(`${LOG} Stopped.`);
  }

  /**
   * Add a token collection job to the queue.
   * Returns a promise that resolves once the job row is written to DB.
   * Idempotent — duplicate tokenAddress while pending/processing is dropped.
   */
  async enqueue(job: Omit<WalletCollectionJob, "enqueuedAt" | "attempts" | "dbJobId">): Promise<void> {
    const exists = this.queue.some(
      (e) =>
        e.tokenAddress === job.tokenAddress &&
        (e.status === "pending" || e.status === "processing"),
    );
    if (exists) {
      console.log(
        `${LOG} Job for ${job.tokenAddress} already in queue — skipping duplicate.`,
      );
      return;
    }

    const entry: QueueEntry = {
      ...job,
      enqueuedAt: new Date().toISOString(),
      attempts: 0,
      status: "pending",
      dbJobId: null,
    };
    this.queue.push(entry);

    console.log(
      `${LOG} Enqueued ${job.tokenAddress} ` +
      `(pool=${job.poolAddress ?? "none"} mcap=$${job.marketCapUsd ?? "?"} ` +
      `holders=${job.holderCount ?? "?"}). Queue depth: ${this.pendingCount}.`,
    );

    // Write to wallet_collection_jobs table so the job is durable
    const dbId = await dbInsertJob(entry);
    entry.dbJobId = dbId;

    // If the loop is not started, kick an immediate tick
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
    // Trim completed/failed jobs older than 1 hour
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
    const startedAt = new Date().toISOString();

    console.log(
      `${LOG} ▶ Processing ${entry.tokenAddress} attempt=${entry.attempts} ` +
      `pool=${entry.poolAddress ?? "none"} dbJobId=${entry.dbJobId ?? "none"}`,
    );

    // Mark as processing in DB
    if (entry.dbJobId) {
      await dbUpdateJob(entry.dbJobId, {
        status: "processing",
        attempts: entry.attempts,
        started_at: startedAt,
      });
    }

    try {
      const result = await collect(entry);

      if (result.errors.length > 0) {
        console.warn(
          `${LOG} ⚠ Collection for ${entry.tokenAddress} completed with warnings:`,
          result.errors,
        );
      }

      console.log(
        `${LOG} ✓ Collected for ${entry.tokenAddress}: ` +
        `traders=${result.tradersCollected} buyers=${result.buyersCollected} ` +
        `sellers=${result.sellersCollected} skippedDust=${result.skippedDust}`,
      );

      entry.status = "done";

      if (entry.dbJobId) {
        await dbUpdateJob(entry.dbJobId, {
          status: "done",
          traders_collected: result.tradersCollected,
          buyers_collected: result.buyersCollected,
          sellers_collected: result.sellersCollected,
          skipped_dust: result.skippedDust,
          errors: result.errors.length > 0 ? result.errors : null,
          completed_at: new Date().toISOString(),
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      entry.lastError = message;

      if (entry.attempts <= MAX_RETRIES) {
        entry.status = "pending";
        console.warn(
          `${LOG} ↻ Retry ${entry.tokenAddress} attempt=${entry.attempts}/${MAX_RETRIES}: ${message}`,
        );
        if (entry.dbJobId) {
          await dbUpdateJob(entry.dbJobId, {
            status: "pending",
            attempts: entry.attempts,
            last_error: message,
          });
        }
      } else {
        entry.status = "failed";
        console.error(
          `${LOG} ✗ Failed ${entry.tokenAddress} after ${entry.attempts} attempts: ${message}`,
        );
        if (entry.dbJobId) {
          await dbUpdateJob(entry.dbJobId, {
            status: "failed",
            attempts: entry.attempts,
            last_error: message,
            completed_at: new Date().toISOString(),
          });
        }
      }
    } finally {
      this.activeCount = Math.max(0, this.activeCount - 1);
    }
  }
}
