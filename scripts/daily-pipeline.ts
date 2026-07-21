// =============================================================================
// daily-pipeline.ts
//
// Automated daily maintenance pipeline — runs while you sleep.
//
// Chains all maintenance steps in the correct dependency order:
//   1. patch-null-roi.ts           (fast, ~5s)   — fix ROI stragglers
//   2. audit-rescore-v2.ts         (slow, ~5min) — recompute all scores
//   3. fix-classification-promotion.ts (~30s)    — sync all tier classifications
//   4. backfill-pool-address.mjs   (fast, ~2min) — queue missing pool address jobs
//   5. integrity-monitor.ts        (fast, ~20s)  — health report to logs
//
// Step 6 (backfill-wallet-activity.mjs) is excluded from the daily run because
// it contacts CoinGecko with a 2s sleep per unique day — for 335k null rows
// it would take 30-40 minutes and hit rate limits. Run it manually once a week:
//   node backfill-wallet-activity.mjs
//
// ENVIRONMENT VARIABLES:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — required
//   SKIP_BACKFILL_POOL=1 — skip step 4 if pool address backfill is already clean
//   DRY_RUN=1            — print plan only, no writes
//
// RAILWAY CRON (set in railway.toml):
//   schedule = "0 3 * * *"    ← runs at 03:00 UTC every day
//   command  = "bun scripts/daily-pipeline.ts"
//
// Usage:
//   bun scripts/daily-pipeline.ts
// =============================================================================

import { spawnSync } from "child_process";

const DRY_RUN           = process.env.DRY_RUN === "1";
const SKIP_POOL_BACKFILL = process.env.SKIP_BACKFILL_POOL === "1";

interface StepResult {
  name:      string;
  command:   string;
  skipped:   boolean;
  exitCode:  number;
  durationMs: number;
  error?:    string;
}

const results: StepResult[] = [];

// ── Helpers ──────────────────────────────────────────────────────────────────

function banner(text: string) {
  const line = "═".repeat(66);
  console.log(`\n${line}`);
  console.log(`  ${text}`);
  console.log(line);
}

function sectionHeader(step: number, name: string) {
  console.log(`\n${"─".repeat(66)}`);
  console.log(`  STEP ${step}: ${name}`);
  console.log(`  ${new Date().toISOString()}`);
  console.log("─".repeat(66));
}

function runStep(
  step:     number,
  name:     string,
  command:  string[],
  options?: { skip?: boolean; env?: Record<string, string> },
): boolean {
  sectionHeader(step, name);

  if (options?.skip) {
    console.log(`  ⏭  Skipped (SKIP flag set)`);
    results.push({ name, command: command.join(" "), skipped: true, exitCode: 0, durationMs: 0 });
    return true;
  }

  if (DRY_RUN) {
    console.log(`  🔍 DRY RUN — would run: ${command.join(" ")}`);
    results.push({ name, command: command.join(" "), skipped: true, exitCode: 0, durationMs: 0 });
    return true;
  }

  const t0 = Date.now();
  const result = spawnSync(command[0], command.slice(1), {
    stdio: "inherit",
    env: {
      ...process.env,
      ...(options?.env ?? {}),
    },
    // 20-minute timeout per step — rescore is the slowest at ~5 min for 70k wallets
    timeout: 20 * 60 * 1000,
  });

  const durationMs = Date.now() - t0;
  const exitCode   = result.status ?? 1;

  results.push({
    name,
    command:    command.join(" "),
    skipped:    false,
    exitCode,
    durationMs,
    error:      result.error?.message,
  });

  if (exitCode !== 0) {
    console.error(`\n  ❌ Step failed (exit ${exitCode}) after ${(durationMs / 1000).toFixed(1)}s`);
    if (result.error) console.error(`  Error: ${result.error.message}`);
    return false;
  }

  console.log(`\n  ✅ Completed in ${(durationMs / 1000).toFixed(1)}s`);
  return true;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const pipelineStart = Date.now();

  banner("DAILY MAINTENANCE PIPELINE — Solana Scanner");
  console.log(`  Started : ${new Date().toISOString()}`);
  console.log(`  Mode    : ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE"}`);
  if (SKIP_POOL_BACKFILL) console.log("  Flags   : SKIP_BACKFILL_POOL=1");

  // ── Step 1: patch null ROI stragglers (fast, must run before rescore) ──────
  // Fixes CLOSED positions where roi_multiple is still null due to race conditions.
  // Must run BEFORE rescore so the rescore can read accurate position data.
  runStep(
    1,
    "Patch null ROI stragglers",
    ["bun", "scripts/patch-null-roi.ts"],
  );

  // ── Step 2: rescore all wallets ───────────────────────────────────────────
  // Recomputes intelligence_score, win_rate, average_roi, confidence_tier for
  // every wallet with evidence. Slowest step (~5 min for 70k wallets).
  const rescoreOk = runStep(
    2,
    "Rescore all wallets (audit-rescore-v2)",
    ["bun", "scripts/audit-rescore-v2.ts"],
  );

  if (!rescoreOk) {
    console.error("\n  ❌ PIPELINE ABORTED: rescore failed. Skipping classification and backfills.");
    printSummary(pipelineStart);
    process.exit(1);
  }

  // ── Step 3: sync classifications (promote + demote) ───────────────────────
  // Must run AFTER rescore — reads the fresh scores written in step 2.
  // Promotes qualifying wallets and demotes any that no longer meet their tier.
  runStep(
    3,
    "Sync wallet classifications (promote + demote)",
    ["bun", "scripts/fix-classification-promotion.ts"],
  );

  // ── Step 4: pool address backfill (optional, fast) ───────────────────────
  // Re-queues jobs for tokens whose original job completed without pool_address.
  // Safe to skip once the queue is clean (SKIP_BACKFILL_POOL=1).
  runStep(
    4,
    "Backfill pool addresses",
    ["node", "backfill-pool-address.mjs"],
    { skip: SKIP_POOL_BACKFILL },
  );

  // ── Step 5: integrity check ───────────────────────────────────────────────
  // Read-only health report. Runs last so it reflects the post-pipeline state.
  // Exits with code 1 if any FAIL checks — this surfaces in Railway logs.
  runStep(
    5,
    "Integrity monitor (health report)",
    ["bun", "scripts/integrity-monitor.ts"],
  );

  printSummary(pipelineStart);
}

function printSummary(pipelineStart: number) {
  const totalMs = Date.now() - pipelineStart;

  banner("PIPELINE SUMMARY");
  console.log(`  Total duration: ${(totalMs / 1000 / 60).toFixed(1)} minutes\n`);

  let anyFail = false;
  for (const r of results) {
    const icon = r.skipped
      ? "⏭ "
      : r.exitCode === 0
        ? "✅"
        : "❌";
    const dur  = r.skipped ? "" : `  (${(r.durationMs / 1000).toFixed(1)}s)`;
    console.log(`  ${icon}  ${r.name}${dur}`);
    if (r.error) console.log(`        Error: ${r.error}`);
    if (r.exitCode !== 0) anyFail = true;
  }

  console.log("");
  if (anyFail) {
    console.log("  ❌ Pipeline completed with failures — check logs above");
    process.exit(1);
  } else {
    console.log("  ✅ Pipeline completed successfully");
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
