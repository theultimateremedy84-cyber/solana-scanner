// =============================================================================
// fix-jobs-reset.ts
//
// Inspect and optionally retry failed wallet_collection_jobs — July 2026 audit.
//
// WHAT IT DOES:
//   1. Reports all failed jobs grouped by error_message (so you can see
//      the failure reasons before deciding what to retry).
//   2. With --retry flag: resets failed jobs that have < MAX_AUTO_RETRY
//      attempts back to 'pending' so the scheduler picks them up again.
//   3. With --purge flag: deletes permanently failed jobs (≥ MAX_ATTEMPTS
//      attempts) from the queue.
//
// DEFAULTS (no flags): report only, no writes.
//
// Usage:
//   bun scripts/fix-jobs-reset.ts              # report only
//   bun scripts/fix-jobs-reset.ts --retry      # reset retryable jobs
//   bun scripts/fix-jobs-reset.ts --purge      # delete permanent failures
//   bun scripts/fix-jobs-reset.ts --retry --purge  # both
// =============================================================================

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const MAX_ATTEMPTS  = 3;  // jobs with ≥ this many attempts are permanently failed
const MAX_AUTO_RETRY = MAX_ATTEMPTS - 1;

const doRetry = process.argv.includes("--retry");
const doPurge = process.argv.includes("--purge");

type JobRow = {
  id:            string;
  token_address: string;
  status:        string;
  attempts:      number | null;
  error_message: string | null;
  enqueued_at:   string | null;
  updated_at:    string | null;
};

async function main() {
  console.log("=== fix-jobs-reset.ts ===");
  console.log(`Mode: retry=${doRetry} purge=${doPurge}`);

  // ── Load all failed jobs ───────────────────────────────────────────────────
  const PAGE = 1_000;
  const failedJobs: JobRow[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from("wallet_collection_jobs")
      .select("id, token_address, status, attempts, error_message, enqueued_at, updated_at")
      .eq("status", "failed")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`jobs: ${error.message}`);
    if (!data?.length) break;
    failedJobs.push(...(data as JobRow[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }

  console.log(`\nTotal failed jobs: ${failedJobs.length}`);

  // ── Group by error_message ────────────────────────────────────────────────
  const byError = new Map<string, number>();
  for (const j of failedJobs) {
    const key = (j.error_message ?? "(no message)").slice(0, 120);
    byError.set(key, (byError.get(key) ?? 0) + 1);
  }

  console.log("\nFailed job breakdown by error:");
  const sorted = [...byError.entries()].sort((a, b) => b[1] - a[1]);
  for (const [msg, count] of sorted) {
    console.log(`  ${count.toString().padStart(4)}  ${msg}`);
  }

  const retryable = failedJobs.filter((j) => (j.attempts ?? 0) < MAX_ATTEMPTS);
  const permanent = failedJobs.filter((j) => (j.attempts ?? 0) >= MAX_ATTEMPTS);

  console.log(`\nRetryable (< ${MAX_ATTEMPTS} attempts): ${retryable.length}`);
  console.log(`Permanent failures (≥ ${MAX_ATTEMPTS} attempts): ${permanent.length}`);

  // ── Retry ─────────────────────────────────────────────────────────────────
  if (doRetry && retryable.length > 0) {
    console.log(`\nResetting ${retryable.length} retryable jobs to 'pending'…`);
    const BATCH = 200;
    let reset = 0;
    for (let i = 0; i < retryable.length; i += BATCH) {
      const slice = retryable.slice(i, i + BATCH);
      const { error } = await sb
        .from("wallet_collection_jobs")
        .upsert(
          slice.map((j) => ({
            id:      j.id,
            status:  "pending",
            error_message: null,
            updated_at: new Date().toISOString(),
          })),
          { onConflict: "id" },
        );
      if (error) {
        console.error(`  ✗ batch ${i}: ${error.message}`);
      } else {
        reset += slice.length;
      }
    }
    console.log(`  Reset ${reset}/${retryable.length} jobs.`);
  } else if (doRetry) {
    console.log("  No retryable jobs to reset.");
  }

  // ── Purge ─────────────────────────────────────────────────────────────────
  if (doPurge && permanent.length > 0) {
    console.log(`\nDeleting ${permanent.length} permanently failed jobs…`);
    const ids = permanent.map((j) => j.id);
    const BATCH = 200;
    let deleted = 0;
    for (let i = 0; i < ids.length; i += BATCH) {
      const slice = ids.slice(i, i + BATCH);
      const { error } = await sb
        .from("wallet_collection_jobs")
        .delete()
        .in("id", slice);
      if (error) {
        console.error(`  ✗ batch ${i}: ${error.message}`);
      } else {
        deleted += slice.length;
      }
    }
    console.log(`  Deleted ${deleted}/${permanent.length} jobs.`);
  } else if (doPurge) {
    console.log("  No permanent failures to purge.");
  }

  console.log("\n=== DONE ===");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
