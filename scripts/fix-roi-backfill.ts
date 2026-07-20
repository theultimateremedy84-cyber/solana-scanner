// =============================================================================
// fix-roi-backfill.ts
//
// NEW — One-time backfill: compute roi_multiple and realized_profit for all
// CLOSED positions in wallet_performance_history where these fields are NULL
// but initial_investment > 0 (i.e., the investment was tracked but ROI was
// never written).
//
// ROOT CAUSE:
//   The wallet_performance_history PATCH in enrich-hollow-wallets.mjs and the
//   production enricher only write roi_multiple when upgrading a position from
//   a lower status (OPEN → CLOSED). Positions that were already recorded as
//   CLOSED (e.g. from a holder_scan or earlier enrichment pass) never had the
//   PATCH applied, leaving roi_multiple NULL even though initial_investment and
//   total_sol_received were both present.
//
//   Live count (July 20, 2026): 54,552 CLOSED positions with null roi_multiple
//   and initial_investment > 0. A further 22,037 are CLOSED with null roi_multiple
//   but also no initial_investment (rugs / airdrop-only positions — left as NULL).
//
// WHAT IT DOES:
//   For every wallet_performance_history row where:
//     position_status = 'CLOSED'
//     AND roi_multiple IS NULL
//     AND initial_investment > 0
//   Computes:
//     roi_multiple    = ROUND(COALESCE(total_sol_received, current_value, 0) / initial_investment, 4)
//     realized_profit = ROUND(COALESCE(total_sol_received, current_value, 0) - initial_investment, 4)
//   And writes them back to the row.
//
//   After the position-level backfill completes, re-aggregates realized_pnl at
//   the wallet level and writes it back to wallets.realized_pnl (same logic as
//   fix-pnl-backfill.ts, now including the newly-fixed positions).
//
// SAFE TO RE-RUN: idempotent — the WHERE clause on roi_multiple IS NULL
// ensures already-fixed rows are skipped.
//
// MUST RUN BEFORE: fix-classification-promotion.ts (whale promotion checks
// realized_pnl ≥ 100 SOL, which is only accurate after this script).
//
// Usage:
//   bun scripts/fix-roi-backfill.ts
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "fs";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const PAGE  = 1_000;
const BATCH = 200;

type WphRow = {
  id:                  string;
  wallet_address:      string;
  initial_investment:  number;
  total_sol_received:  number | null;
  current_value:       number | null;
};

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function main() {
  const startedAt = new Date();
  mkdirSync("exports", { recursive: true });

  console.log("=== fix-roi-backfill.ts — WRITES to wallet_performance_history and wallets ===");
  console.log(`Started: ${startedAt.toISOString()}`);

  // ── Count target rows ─────────────────────────────────────────────────────
  const { count: targetCount, error: countErr } = await sb
    .from("wallet_performance_history")
    .select("*", { count: "exact", head: true })
    .eq("position_status", "CLOSED")
    .is("roi_multiple", null)
    .gt("initial_investment", 0);

  if (countErr) throw new Error(`count query: ${countErr.message}`);
  console.log(`  Found ${targetCount ?? 0} CLOSED positions with null roi_multiple and investment > 0.`);

  if (!targetCount || targetCount === 0) {
    console.log("  Nothing to fix in wallet_performance_history.");
  } else {
    // ── Load all target rows ────────────────────────────────────────────────
    console.log("  Loading target rows…");
    const rows: WphRow[] = [];
    let from = 0;
    while (true) {
      const { data, error } = await sb
        .from("wallet_performance_history")
        .select("id, wallet_address, initial_investment, total_sol_received, current_value")
        .eq("position_status", "CLOSED")
        .is("roi_multiple", null)
        .gt("initial_investment", 0)
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`fetch: ${error.message}`);
      if (!data?.length) break;
      rows.push(...(data as WphRow[]));
      if (data.length < PAGE) break;
      from += PAGE;
      process.stdout.write(`\r  loaded ${rows.length}…`);
    }
    console.log(`\n  ${rows.length} rows to update.`);

    // ── Compute and write roi_multiple + realized_profit ───────────────────
    type Update = { id: string; roi_multiple: number; realized_profit: number };
    const updates: Update[] = rows.map((r) => {
      const received  = Number(r.total_sol_received ?? r.current_value ?? 0);
      const invested  = Number(r.initial_investment);
      const roi       = Math.round((received / invested) * 10_000) / 10_000;
      const profit    = Math.round((received - invested) * 10_000) / 10_000;
      return { id: r.id, roi_multiple: roi, realized_profit: profit };
    });

    let wphWritten = 0;
    let wphErrors  = 0;
    for (let i = 0; i < updates.length; i += BATCH) {
      const slice = updates.slice(i, i + BATCH);
      const { error } = await sb
        .from("wallet_performance_history")
        .upsert(slice, { onConflict: "id" });
      if (error) {
        console.error(`  ✗ wph batch ${i}: ${error.message}`);
        wphErrors++;
      } else {
        wphWritten += slice.length;
      }
      if (i % 5_000 === 0) process.stdout.write(`\r  written ${wphWritten}/${updates.length}…`);
      // Brief pause every 50 batches to avoid hammering the DB
      if (i > 0 && (i / BATCH) % 50 === 0) await sleep(200);
    }
    console.log(`\n  wallet_performance_history: ${wphWritten} updated, ${wphErrors} batch errors.`);
  }

  // ── Re-aggregate realized_pnl into wallets table ──────────────────────────
  // Now that roi_multiple is correct, re-sum all CLOSED positions per wallet
  // to get accurate realized_pnl (same logic as fix-pnl-backfill.ts but run
  // after the ROI fix above so the totals are complete).
  console.log("\n  Re-aggregating realized_pnl into wallets table…");

  const pnlRows: Array<{
    wallet_address:    string;
    initial_investment: number;
    total_sol_received: number | null;
    current_value:      number | null;
  }> = [];

  let pnlFrom = 0;
  while (true) {
    const { data, error } = await sb
      .from("wallet_performance_history")
      .select("wallet_address, initial_investment, total_sol_received, current_value")
      .eq("position_status", "CLOSED")
      .range(pnlFrom, pnlFrom + PAGE - 1);
    if (error) throw new Error(`pnl fetch: ${error.message}`);
    if (!data?.length) break;
    pnlRows.push(...(data as typeof pnlRows));
    if (data.length < PAGE) break;
    pnlFrom += PAGE;
    process.stdout.write(`\r  loaded ${pnlRows.length} closed positions…`);
  }
  console.log(`\n  ${pnlRows.length} total CLOSED positions loaded.`);

  const pnlMap = new Map<string, number>();
  for (const r of pnlRows) {
    const received  = Number(r.total_sol_received ?? r.current_value ?? 0);
    const invested  = Number(r.initial_investment ?? 0);
    pnlMap.set(r.wallet_address, (pnlMap.get(r.wallet_address) ?? 0) + (received - invested));
  }

  const walletUpdates = [...pnlMap.entries()].map(([wallet_address, realized_pnl]) => ({
    wallet_address,
    realized_pnl: Math.round(realized_pnl * 10_000) / 10_000,
  }));

  console.log(`  Writing realized_pnl for ${walletUpdates.length} wallets…`);
  let pnlWritten = 0, pnlErrors = 0;
  for (let i = 0; i < walletUpdates.length; i += BATCH) {
    const slice = walletUpdates.slice(i, i + BATCH);
    const { error } = await sb
      .from("wallets")
      .upsert(slice, { onConflict: "wallet_address" });
    if (error) {
      console.error(`  ✗ pnl batch ${i}: ${error.message}`);
      pnlErrors++;
    } else {
      pnlWritten += slice.length;
    }
    if (i % 5_000 === 0) process.stdout.write(`\r  written ${pnlWritten}/${walletUpdates.length}…`);
  }
  console.log(`\n  wallets: ${pnlWritten} realized_pnl values written, ${pnlErrors} batch errors.`);

  // ── Summary ───────────────────────────────────────────────────────────────
  const finishedAt = new Date();
  const summary = {
    startedAt:           startedAt.toISOString(),
    finishedAt:          finishedAt.toISOString(),
    durationMs:          finishedAt.getTime() - startedAt.getTime(),
    wphRowsTargeted:     targetCount ?? 0,
    wphRowsUpdated:      wphErrors === 0 ? (targetCount ?? 0) : "partial — check wphErrors",
    wphBatchErrors:      wphErrors,
    walletsReaggregated: pnlWritten,
    walletPnlErrors:     pnlErrors,
  };

  const summaryPath = `exports/fix-roi-backfill-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  console.log("\n=== DONE ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log("\n  ⚠️  NEXT STEPS:");
  console.log("  1. Run fix-classification-promotion.ts — whale promotion now has accurate PnL data.");
  console.log("  2. Run audit-rescore-v2.ts — rescoring now has accurate ROI per position.");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
