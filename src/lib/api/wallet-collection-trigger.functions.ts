// =============================================================================
// Wallet Collection Trigger — server function  (v4 — dedup + security hardened)
//
// FIXES vs v3:
//
//   SCHED-04 — Deduplication on enqueue:
//     Before inserting a new job, the handler checks whether a pending or
//     processing job for the same token already exists. If one does, the new
//     request is skipped and the existing jobId is returned. This prevents
//     two concurrent collect() runs from racing on the same token's DB rows.
//     Backed by the partial unique index added in migration 20260627000001:
//       CREATE UNIQUE INDEX wcj_token_pending_unique_idx
//         ON wallet_collection_jobs (token_address)
//         WHERE status IN ('pending','processing');
//
//   SEC-04 — Supabase key fallback hardened:
//     The helper now logs a prominent warning when SUPABASE_SERVICE_ROLE_KEY is
//     absent and the code falls back to the anon key. After the RLS hardening
//     migration, writes with the anon key will be rejected by Postgres — this
//     warning surfaces the misconfiguration before it causes silent failures.
//
// All v3 guarantees are preserved:
//   - Bulletproof two-attempt status updater
//   - 5-minute hard timeout around collect()
//   - Fire-and-forget background collection
// =============================================================================

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { collect } from "./wallet-collection-worker";

const LOG = "[WalletTrigger]";

// ---------------------------------------------------------------------------
// Supabase — resolved at call time from process.env (runtime-safe)
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
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (serviceRoleKey) return serviceRoleKey;

  // SEC-04: warn loudly when falling back to anon key.
  // After the RLS hardening migration, writes with the anon key will be
  // rejected by Postgres. This warning surfaces the misconfiguration.
  const anonKey =
    process.env.SUPABASE_ANON_KEY ??
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.VITE_SUPABASE_ANON_KEY ??
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    "";

  if (anonKey) {
    console.warn(
      `${LOG} ⚠ SUPABASE_SERVICE_ROLE_KEY is not set. ` +
      "Falling back to anon key — DB writes will be rejected by RLS after the " +
      "security hardening migration. Set SUPABASE_SERVICE_ROLE_KEY in Railway → Variables.",
    );
  }
  return anonKey;
}

function getSupabase() {
  const url = getSupabaseUrl();
  const key = getSupabaseKey();
  if (!url || !key) {
    console.warn(
      `${LOG} Supabase env vars not set. DB writes will be skipped.\n` +
      `  SUPABASE_URL              = ${process.env.SUPABASE_URL ? "SET" : "MISSING"}\n` +
      `  VITE_SUPABASE_URL         = ${process.env.VITE_SUPABASE_URL ? "SET" : "MISSING"}\n` +
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
// Deduplication check — SCHED-04 fix
//
// Returns the jobId of an existing pending/processing job for the token,
// or null if no such job exists.
// ---------------------------------------------------------------------------

async function findExistingJob(
  sb: ReturnType<typeof createClient>,
  tokenAddress: string,
): Promise<string | null> {
  try {
    const { data, error } = await sb
      .from("wallet_collection_jobs")
      .select("id, status, enqueued_at")
      .eq("token_address", tokenAddress)
      .in("status", ["pending", "processing"])
      .order("enqueued_at", { ascending: false })
      .limit(1)
      .single();

    if (error || !data) return null;
    return (data as { id: string }).id;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Bulletproof status updater (unchanged from v3)
// ---------------------------------------------------------------------------

async function updateJobStatus(
  jobId: string,
  status: "done" | "failed",
  payload: {
    tradersCollected?: number;
    buyersCollected?:  number;
    sellersCollected?: number;
    errors?:           string[] | null;
    lastError?:        string;
  },
): Promise<void> {
  const sb = getSupabase();
  if (!sb) {
    console.error(
      `${LOG} [bg] Cannot update job ${jobId} — Supabase credentials unavailable.\n` +
      "  Ensure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set in Railway → Variables.",
    );
    return;
  }

  const completedAt = new Date().toISOString();

  // Attempt 1: Full update
  try {
    const fullPayload: Record<string, unknown> = {
      status,
      completed_at: completedAt,
    };
    if (payload.tradersCollected !== undefined) fullPayload.traders_collected = payload.tradersCollected;
    if (payload.buyersCollected  !== undefined) fullPayload.buyers_collected  = payload.buyersCollected;
    if (payload.sellersCollected !== undefined) fullPayload.sellers_collected = payload.sellersCollected;
    if (payload.errors           !== undefined) fullPayload.errors            = payload.errors;
    if (payload.lastError        !== undefined) fullPayload.last_error        = payload.lastError;

    const { error } = await sb
      .from("wallet_collection_jobs")
      .update(fullPayload)
      .eq("id", jobId);

    if (!error) {
      console.log(`${LOG} [bg] job ${jobId} → ${status} (full update)`);
      return;
    }

    console.error(
      `${LOG} [bg] Full update failed for job ${jobId}: ${error.message}\n` +
      `  Code: ${error.code}  Details: ${error.details ?? "none"}\n` +
      "  → Falling back to minimal update (status + completed_at only)",
    );
  } catch (err) {
    console.error(`${LOG} [bg] Full update threw for job ${jobId}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Attempt 2: Minimal update
  try {
    const minPayload: Record<string, unknown> = { status, completed_at: completedAt };
    if (payload.lastError) minPayload.last_error = payload.lastError;

    const { error } = await sb
      .from("wallet_collection_jobs")
      .update(minPayload)
      .eq("id", jobId);

    if (!error) {
      console.log(`${LOG} [bg] job ${jobId} → ${status} (minimal update)`);
      return;
    }

    console.error(`${LOG} [bg] Minimal update also failed for job ${jobId}: ${error.message}`);
  } catch (err) {
    console.error(`${LOG} [bg] Minimal update threw for job ${jobId}: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.error(
    `${LOG} [bg] ✗ UNABLE to update job ${jobId} to ${status} — all attempts failed.\n` +
    "  The job will stay stuck in 'processing' until the process-jobs recovery endpoint runs.\n" +
    "  Check Supabase RLS policies and ensure SUPABASE_SERVICE_ROLE_KEY is set in Railway.",
  );
}

// ---------------------------------------------------------------------------
// Background collection runner — decoupled from HTTP lifecycle (unchanged from v3)
// ---------------------------------------------------------------------------

const COLLECT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

async function runCollectionInBackground(
  data: z.infer<typeof inputSchema>,
  jobId: string | null,
): Promise<void> {
  let collectResult: Awaited<ReturnType<typeof collect>> | null = null;
  let collectError: string | null = null;

  console.log(`${LOG} [bg] collect() START token=${data.tokenAddress} pool=${data.poolAddress ?? "none"}`);

  try {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`collect() timed out after ${COLLECT_TIMEOUT_MS / 1000}s`)),
        COLLECT_TIMEOUT_MS,
      ),
    );

    collectResult = await Promise.race([
      collect({
        tokenAddress:   data.tokenAddress,
        poolAddress:    data.poolAddress ?? null,
        marketCapUsd:   data.marketCapUsd ?? null,
        liquidityUsd:   data.liquidityUsd ?? null,
        holderCount:    data.holderCount ?? null,
        tokenCreatedAt: data.tokenCreatedAt ?? null,
        enqueuedAt:     new Date().toISOString(),
        attempts:       1,
      }),
      timeoutPromise,
    ]);

    console.log(
      `${LOG} [bg] collect() DONE token=${data.tokenAddress} ` +
      `traders=${collectResult.tradersCollected} buyers=${collectResult.buyersCollected} ` +
      `sellers=${collectResult.sellersCollected} errors=${collectResult.errors.length}`,
    );
  } catch (err) {
    collectError = err instanceof Error ? err.message : String(err);
    console.error(`${LOG} [bg] collect() threw for ${data.tokenAddress}: ${collectError}`);
  }

  if (!jobId) {
    console.warn(`${LOG} [bg] No jobId — cannot update wallet_collection_jobs status`);
    return;
  }

  if (collectError) {
    await updateJobStatus(jobId, "failed", { lastError: collectError });
    return;
  }

  if (collectResult) {
    await updateJobStatus(jobId, "done", {
      tradersCollected: collectResult.tradersCollected,
      buyersCollected:  collectResult.buyersCollected,
      sellersCollected: collectResult.sellersCollected,
      errors:           collectResult.errors.length > 0 ? collectResult.errors : null,
    });
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

    if (sb) {
      // ── SCHED-04 fix: check for an existing pending/processing job ─────────
      const existingJobId = await findExistingJob(sb, data.tokenAddress);
      if (existingJobId) {
        console.log(
          `${LOG} ▶ SKIP — existing job ${existingJobId} is already pending/processing ` +
          `for token ${data.tokenAddress}. Returning existing jobId.`,
        );
        return {
          success:      true,
          jobId:        existingJobId,
          tokenAddress: data.tokenAddress,
          skipped:      true,
          reason:       "Job already queued for this token",
        };
      }

      // ── Step 1: Insert job record ─────────────────────────────────────────
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
          // Handle race condition: another request may have inserted between
          // our check and our insert (partial unique index on pending/processing).
          if (error.code === "23505") {
            console.warn(
              `${LOG} Duplicate job detected via constraint (race condition) — ` +
              `fetching existing job for ${data.tokenAddress}`,
            );
            const racedJobId = await findExistingJob(sb, data.tokenAddress);
            return {
              success:      true,
              jobId:        racedJobId,
              tokenAddress: data.tokenAddress,
              skipped:      true,
              reason:       "Job already queued (race condition resolved)",
            };
          }
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

    // ── Step 2: Mark as processing ─────────────────────────────────────────
    if (sb && jobId) {
      await sb
        .from("wallet_collection_jobs")
        .update({ status: "processing", started_at: new Date().toISOString(), attempts: 1 })
        .eq("id", jobId);
    }

    // ── Step 3: Fire background collection WITHOUT blocking HTTP response ───
    void runCollectionInBackground(data, jobId);

    return {
      success:      true,
      jobId,
      tokenAddress: data.tokenAddress,
      skipped:      false,
    };
  });

// ---------------------------------------------------------------------------
// getQueueStatus — monitoring endpoint (unchanged from v3)
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
