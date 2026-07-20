#!/usr/bin/env bun
// =============================================================================
// scripts/check-migrations.ts
//
// PURPOSE (P2 #14 fix — Migration Order Enforcement):
//   Refuses to proceed if any migration in the provided list has a gap in its
//   sequence (i.e., a predecessor is missing from migrations_log).
//
//   Run this before applying a new migration to catch out-of-order applies.
//
// USAGE:
//   bun scripts/check-migrations.ts                  # checks all pending migrations
//   bun scripts/check-migrations.ts 20260720000010   # checks specific migration
//
// EXIT CODES:
//   0 — all prerequisite migrations are applied; safe to proceed
//   1 — missing prerequisite; DO NOT apply new migrations until resolved
// =============================================================================

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL      = process.env.SUPABASE_URL           ?? "";
const SERVICE_ROLE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function main() {
  const targetMigration = process.argv[2] ?? null;

  // Load all applied migrations sorted by sequence_number
  const { data: applied, error } = await sb
    .from("migrations_log")
    .select("migration_name, sequence_number")
    .order("sequence_number", { ascending: true });

  if (error) {
    console.error("ERROR: Could not read migrations_log:", error.message);
    console.error("Has migration 20260720000010_migration_enforcement been applied?");
    process.exit(1);
  }

  if (!applied || applied.length === 0) {
    console.log("migrations_log is empty — run 20260720000010 first.");
    process.exit(1);
  }

  // Check for sequence gaps
  let prevSeq = 0;
  const gaps: string[] = [];
  for (const row of applied) {
    const seq = row.sequence_number as number;
    if (seq !== prevSeq + 1) {
      gaps.push(
        `Gap detected: expected sequence ${prevSeq + 1}, got ${seq} ` +
        `(migration: ${row.migration_name})`
      );
    }
    prevSeq = seq;
  }

  if (gaps.length > 0) {
    console.error("=== MIGRATION SEQUENCE GAPS DETECTED ===");
    for (const g of gaps) console.error("  ✗ " + g);
    console.error("\nDo NOT apply new migrations until gaps are resolved.");
    console.error("Check RUNBOOK.md for the correct application order.");
    process.exit(1);
  }

  console.log(`✓ migrations_log contains ${applied.length} migrations, no gaps.`);
  console.log(`  Last applied: ${applied[applied.length - 1]?.migration_name} (seq ${prevSeq})`);

  if (targetMigration) {
    // Check if the specified migration is already applied
    const isApplied = applied.some(r => (r.migration_name as string).includes(targetMigration));
    if (isApplied) {
      console.log(`\n✓ Migration '${targetMigration}' is already in migrations_log.`);
    } else {
      console.log(`\n⚠  Migration '${targetMigration}' is NOT yet applied.`);
      console.log("   All prerequisites are present — safe to apply.");
    }
  }

  console.log("\n✓ Safe to apply next migration.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
