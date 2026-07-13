// =============================================================================
// production-rescore.ts
//
// REAL production rescore — WRITES to the live `wallets` table.
//
// Scope: intentionally limited to classifyWallets() only (wallet_classification,
// intelligence_score, win_rate, average_roi, conviction_score, total_buys,
// total_sells, total_tokens_traded, confidence_tier, closed_position_count,
// evidence_quality, score_computed_at) — the exact function validated via
// dry-run in scripts/validation-report.ts against the v7 scoring formula.
//
// Deliberately does NOT run rescoreAllWallets()'s Pass 0 (implicit rug
// resolution), Pass 2 (discovery score), or Pass 3 (token count refresh) —
// those are separate, unreviewed subsystems out of scope for this rescore.
// Running them now would exceed what was actually validated this session.
//
// Safety:
//   1. Snapshots the full `wallets` table (relevant columns) to a timestamped
//      JSON file BEFORE any write, for full-table rollback if needed.
//   2. Processes wallets in super-batches of 3000, each further split into
//      sub-batches of 200 (matches classifyWallets' .in() query limits and
//      the existing production batch size).
//   3. Snapshots each super-batch's pre-state again immediately before that
//      batch is written (belt-and-suspenders on top of the full snapshot).
//   4. Logs progress and errors per batch; continues on per-batch error
//      (errors are collected and reported, not fatal to the whole run).
//
// Usage: bun scripts/production-rescore.ts
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import { classifyWallets } from "../src/lib/api/wallet-enricher";
import { writeFileSync, mkdirSync } from "fs";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const SUPER_BATCH   = 3000;
const SUB_BATCH     = 200;
const SNAPSHOT_COLS =
  "wallet_address, wallet_classification, intelligence_score, win_rate, " +
  "average_roi, conviction_score, total_buys, total_sells, total_tokens_traded, " +
  "confidence_tier, closed_position_count, evidence_quality, score_computed_at";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collectAllWalletAddresses(errors: string[]): Promise<string[]> {
  const seen = new Set<string>();

  for (const table of ["wallet_raw_tx_metrics", "wallets"] as const) {
    let page = 0;
    const pageSize = 1000;
    while (true) {
      const { data, error } = await sb
        .from(table)
        .select("wallet_address")
        .range(page * pageSize, (page + 1) * pageSize - 1);
      if (error) { errors.push(`${table} page ${page}: ${error.message}`); break; }
      if (!data?.length) break;
      for (const row of data) seen.add(row.wallet_address as string);
      if (data.length < pageSize) break;
      page++;
    }
  }
  return Array.from(seen);
}

async function snapshotWallets(addresses: string[], filePath: string): Promise<number> {
  const rows: Record<string, unknown>[] = [];
  const CHUNK = 500;
  for (let i = 0; i < addresses.length; i += CHUNK) {
    const slice = addresses.slice(i, i + CHUNK);
    const { data, error } = await sb.from("wallets").select(SNAPSHOT_COLS).in("wallet_address", slice);
    if (error) throw new Error(`snapshot query failed: ${error.message}`);
    rows.push(...(data ?? []));
  }
  writeFileSync(filePath, JSON.stringify(rows));
  return rows.length;
}

async function main() {
  const startedAt = new Date();
  const errors: string[] = [];

  // Optional resume window: bun scripts/production-rescore.ts <startOffset> <endOffset>
  // Lets a single run be split across multiple invocations to stay under a
  // shell timeout. Address list is deterministic run-to-run (same Set-based
  // collection order) as long as no wallets are inserted mid-run, so offsets
  // are stable enough to resume from. classifyWallets() is idempotent per
  // wallet, so re-covering a few already-done wallets on resume is harmless.
  const startOffset = process.argv[2] ? Number(process.argv[2]) : 0;
  const endOffsetArg = process.argv[3] ? Number(process.argv[3]) : undefined;

  mkdirSync("exports", { recursive: true });

  console.log("=== PRODUCTION RESCORE — this WRITES to the live wallets table ===");
  console.log(`Started: ${startedAt.toISOString()}`);

  console.log("Collecting all wallet addresses...");
  const allAddressesFull = await collectAllWalletAddresses(errors);
  console.log(`Found ${allAddressesFull.length} wallet addresses total.`);

  const endOffset = endOffsetArg ?? allAddressesFull.length;
  const allAddresses = allAddressesFull.slice(startOffset, endOffset);
  console.log(`Processing window [${startOffset}, ${endOffset}) — ${allAddresses.length} wallets.`);

  const fullSnapshotPath = `exports/pre-rescore-full-snapshot-${startOffset}-${endOffset}-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`;
  console.log(`Snapshotting pre-rescore state for this window to ${fullSnapshotPath} ...`);
  const fullSnapshotCount = await snapshotWallets(allAddresses, fullSnapshotPath);
  console.log(`Snapshotted ${fullSnapshotCount} rows (window rollback reference).`);

  let totalClassified = 0;
  let superBatchNum = 0;

  for (let offset = 0; offset < allAddresses.length; offset += SUPER_BATCH) {
    superBatchNum++;
    const superBatch = allAddresses.slice(offset, offset + SUPER_BATCH);

    // Per-super-batch snapshot (belt-and-suspenders on top of the full snapshot)
    const batchSnapshotPath = `exports/pre-rescore-batch-${superBatchNum}-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`;
    await snapshotWallets(superBatch, batchSnapshotPath);

    let batchClassified = 0;
    for (let i = 0; i < superBatch.length; i += SUB_BATCH) {
      const subBatch = superBatch.slice(i, i + SUB_BATCH);
      const subErrors: string[] = [];
      const classified = await classifyWallets(sb, subBatch, "", subErrors);
      batchClassified += classified;
      errors.push(...subErrors);
    }

    totalClassified += batchClassified;
    console.log(
      `Super-batch ${superBatchNum}: classified ${batchClassified}/${superBatch.length} ` +
      `(${Math.min(offset + SUPER_BATCH, allAddresses.length)}/${allAddresses.length} total, ` +
      `${errors.length} cumulative errors) — snapshot: ${batchSnapshotPath}`,
    );
  }

  const finishedAt = new Date();
  const summary = {
    startedAt:        startedAt.toISOString(),
    finishedAt:        finishedAt.toISOString(),
    durationMs:        finishedAt.getTime() - startedAt.getTime(),
    totalWalletAddresses: allAddresses.length,
    totalClassified,
    superBatches:      superBatchNum,
    errorCount:        errors.length,
    errors:            errors.slice(0, 50), // cap for readability
    fullSnapshotPath,
  };

  writeFileSync(
    `exports/rescore-summary-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`,
    JSON.stringify(summary, null, 2),
  );

  console.log("=== DONE ===");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
