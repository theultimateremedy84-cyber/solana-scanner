// =============================================================================
// fix-stale-positions.ts
//
// One-time cleanup: close stale OPEN positions — July 2026 audit.
//
// ROOT CAUSE FIXED:
//   63 positions were stuck as position_status='OPEN' with last_updated before
//   July 1, 2026. These are dead tokens the implicit rug-resolver never caught
//   (the resolver's implicit-rug threshold was too conservative, or the token
//   drained before the scanner started tracking it).
//
// WHAT IT DOES:
//   Finds all wallet_performance_history rows where:
//     position_status = 'OPEN'
//     AND last_updated < 2026-07-01T00:00:00Z
//   Marks them CLOSED with:
//     total_sol_received = 0  (rug / total loss)
//     roi_multiple       = 0
//     realized_profit    = -(initial_investment)
//     position_status    = 'CLOSED'
//
// SAFE TO RE-RUN: WHERE clause guarantees idempotency.
// Only touches positions genuinely stuck open before the audit cutoff.
//
// Usage: bun scripts/fix-stale-positions.ts
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "fs";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

// Positions last updated before this date and still OPEN are considered dead.
const STALE_CUTOFF = "2026-07-01T00:00:00.000Z";

async function main() {
  const startedAt = new Date();
  mkdirSync("exports", { recursive: true });

  console.log("=== fix-stale-positions.ts — closes stale OPEN positions ===");
  console.log(`Started: ${startedAt.toISOString()}`);
  console.log(`Stale cutoff: ${STALE_CUTOFF}`);

  // ── Count stale positions ─────────────────────────────────────────────────
  const { count: staleCount, error: countErr } = await sb
    .from("wallet_performance_history")
    .select("*", { count: "exact", head: true })
    .eq("position_status", "OPEN")
    .lt("last_updated", STALE_CUTOFF);

  if (countErr) throw new Error(`count query: ${countErr.message}`);
  console.log(`  Found ${staleCount ?? 0} stale OPEN positions to close.`);

  if (!staleCount || staleCount === 0) {
    console.log("  Nothing to fix.");
    return;
  }

  // ── Fetch stale position IDs + initial_investment for realized_profit ──────
  const PAGE = 1_000;
  const staleRows: Array<{ id: string; initial_investment: number | null }> = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from("wallet_performance_history")
      .select("id, initial_investment")
      .eq("position_status", "OPEN")
      .lt("last_updated", STALE_CUTOFF)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`fetch stale: ${error.message}`);
    if (!data?.length) break;
    staleRows.push(...(data as typeof staleRows));
    if (data.length < PAGE) break;
    from += PAGE;
  }

  console.log(`  Fetched ${staleRows.length} stale position records.`);

  // ── Close each position ───────────────────────────────────────────────────
  const BATCH = 200;
  let closed = 0;
  let errors = 0;

  for (let i = 0; i < staleRows.length; i += BATCH) {
    const slice = staleRows.slice(i, i + BATCH);
    const updates = slice.map((r) => ({
      id:                  r.id,
      position_status:     "CLOSED",
      total_sol_received:  0,
      roi_multiple:        0,
      realized_profit:     -(Number(r.initial_investment ?? 0)),
      last_updated:        new Date().toISOString(),
    }));

    const { error } = await sb
      .from("wallet_performance_history")
      .upsert(updates, { onConflict: "id" });

    if (error) {
      console.error(`  ✗ batch ${i}: ${error.message}`);
      errors++;
    } else {
      closed += slice.length;
    }
  }

  console.log(`  Closed ${closed}/${staleRows.length} stale positions. Errors: ${errors}.`);

  const finishedAt = new Date();
  const summary = {
    startedAt:    startedAt.toISOString(),
    finishedAt:   finishedAt.toISOString(),
    durationMs:   finishedAt.getTime() - startedAt.getTime(),
    staleCutoff:  STALE_CUTOFF,
    positionsClosed: closed,
    writeErrors:  errors,
  };

  writeFileSync(
    `exports/fix-stale-positions-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`,
    JSON.stringify(summary, null, 2),
  );

  console.log("=== DONE ===");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
