// =============================================================================
// Wallet Collection Trigger — server function  (v3 — status-update hardened)
//
// ROOT CAUSE FIX (v3):
//   The live Supabase wallet_collection_jobs table may be missing the columns
//   traders_collected / buyers_collected / sellers_collected (created from an
//   older schema). The UPDATE that tries to write those columns fails with a
//   "column does not exist" Postgres error. Because the error was only logged
//   (not retried with a simpler payload), the status was silently left at
//   "processing" forever.
//
// Fix:
//   1. Try the full UPDATE first (all result columns).
//   2. If it fails for ANY reason, fall back to a minimal UPDATE that only
//      sets status + completed_at — columns guaranteed to exist.
//   3. Wrap entire status-update block in try/catch so it can never throw.
//   4. Add a hard 5-minute timeout around collect() so a hung RPC call can't
//      leave the job stuck indefinitely.
//
// Architecture:
//   Handler inserts job row, marks it processing, returns HTTP response
//   immediately. collect() runs in background on the Node.js event loop.
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
// Bulletproof status updater
//
// Always tries full update first. If that fails (e.g. column does not exist
// in the live schema), falls back to a minimal update with only guaranteed
// columns. This means the job ALWAYS moves out of "processing".
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
      `  Ensure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set in Railway → Variables.`,
    );
    return;
  }

  const completedAt = new Date().toISOString();

  // ── Attempt 1: Full update (all optional result columns) ──────────────────
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

    // Log the specific error so it's visible in Railway logs
    console.error(
      `${LOG} [bg] Full update failed for job ${jobId}: ${error.message}\n` +
      `  Code: ${error.code}  Details: ${error.details ?? "none"}\n` +
      `  → Falling back to minimal update (status + completed_at only)`,
    );
  } catch (err) {
    console.error(`${LOG} [bg] Full update threw for job ${jobId}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Attempt 2: Minimal update — only columns guaranteed to exist ──────────
  try {
    const minPayload: Record<string, unknown> = { status, completed_at: completedAt };
    if (payload.lastError) minPayload.last_error = payload.lastError;

    const { error } = await sb
      .from("wallet_collection_jobs")
      .update(minPayload)
      .eq("id", jobId);

    if (!error) {
      console.log(
        `${LOG} [bg] job ${jobId} → ${status} (minimal update — run the SQL patch to add missing columns)`,
      );
      return;
    }

    console.error(`${LOG} [bg] Minimal update also failed for job ${jobId}: ${error.message}`);
  } catch (err) {
    console.error(`${LOG} [bg] Minimal update threw for job ${jobId}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Last resort: log that status couldn't be updated ─────────────────────
  console.error(
    `${LOG} [bg] ✗ UNABLE to update job ${jobId} to ${status} — all attempts failed.\n` +
    `  The job will stay stuck in "processing" until the process-jobs recovery endpoint runs.\n` +
    `  Check Supabase RLS policies and ensure the service-role key is set in Railway.`,
  );
}

// ---------------------------------------------------------------------------
// Background collection runner — decoupled from HTTP lifecycle
//
// Wraps collect() with a 5-minute hard timeout so RPC hangs cannot leave a
// job permanently stuck in "processing".
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
    // Race collect() against a hard timeout
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`collect() timed out after ${COLLECT_TIMEOUT_MS / 1000}s`)), COLLECT_TIMEOUT_MS),
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

  // Status update — always runs regardless of collect() outcome
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
