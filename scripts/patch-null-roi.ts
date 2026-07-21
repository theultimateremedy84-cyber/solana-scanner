// =============================================================================
// patch-null-roi.ts
//
// Targeted fix: compute roi_multiple and realized_profit for any CLOSED
// positions that still have null roi_multiple despite having initial_investment > 0.
//
// Root cause: race condition between the enricher and fix-roi-backfill.ts —
// newly enriched positions sometimes land after the backfill ran. This script
// is idempotent and safe to run at any time or as a daily maintenance step.
//
// SAFE TO RE-RUN: only touches rows with null roi_multiple.
//
// Usage: bun scripts/patch-null-roi.ts
// =============================================================================

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const EXTREME_ROI_CAP = 200;   // rows above this are dust — cap, don't null
const PAGE            = 1_000;
const BATCH           = 200;

async function main() {
  console.log("=== patch-null-roi.ts — fix CLOSED positions with null roi_multiple ===");
  const startedAt = new Date();

  // Load all CLOSED rows where roi is still null but investment is known
  const rows: Array<{
    id: number;
    wallet_address: string;
    initial_investment: number;
    current_value: number | null;
    total_sol_received: number | null;
  }> = [];

  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from("wallet_performance_history")
      .select("id, wallet_address, initial_investment, current_value, total_sol_received")
      .eq("position_status", "CLOSED")
      .is("roi_multiple", null)
      .gt("initial_investment", 0)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`load: ${error.message}`);
    if (!data?.length) break;
    rows.push(...(data as typeof rows));
    if (data.length < PAGE) break;
    from += PAGE;
  }

  console.log(`  Found ${rows.length} CLOSED positions with null roi_multiple`);
  if (rows.length === 0) {
    console.log("  ✅ Nothing to patch.");
    return;
  }

  // Build patches
  const patches: Array<{ id: number; roi_multiple: number; realized_profit: number }> = [];
  let skipped = 0;

  for (const r of rows) {
    const invested  = Number(r.initial_investment);
    // Prefer total_sol_received (exact), fall back to current_value (estimate)
    const received  = Number(r.total_sol_received ?? r.current_value ?? 0);

    if (received <= 0 || invested <= 0) { skipped++; continue; }

    let roi = received / invested;
    // Cap extreme values — likely dust positions with near-zero cost basis
    if (roi > EXTREME_ROI_CAP) roi = EXTREME_ROI_CAP;

    patches.push({
      id:               r.id,
      roi_multiple:     Math.round(roi   * 10_000) / 10_000,
      realized_profit:  Math.round((received - invested) * 10_000) / 10_000,
    });
  }

  console.log(`  Patchable: ${patches.length}  |  Skipped (no received data): ${skipped}`);

  // Write in batches
  let written = 0;
  let errors  = 0;

  for (let i = 0; i < patches.length; i += BATCH) {
    const slice = patches.slice(i, i + BATCH);
    // Use individual updates by id — avoids not-null constraint on insert path
    const results = await Promise.all(
      slice.map((p) =>
        sb
          .from("wallet_performance_history")
          .update({ roi_multiple: p.roi_multiple, realized_profit: p.realized_profit })
          .eq("id", p.id),
      ),
    );
    const batchErrors = results.filter((r) => r.error);
    if (batchErrors.length > 0) {
      console.error(`  ✗ batch ${i}: ${batchErrors[0].error!.message}`);
      errors += batchErrors.length;
    }
    written += slice.length - batchErrors.length;
    process.stdout.write(`\r  Written ${written}/${patches.length}…`);
  }

  const elapsed = ((new Date().getTime() - startedAt.getTime()) / 1000).toFixed(1);
  console.log(`\n  ✅ Patched ${written} rows in ${elapsed}s. Errors: ${errors}.`);
  console.log("=== DONE ===");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
