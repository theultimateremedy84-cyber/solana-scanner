// =============================================================================
// fix-pnl-backfill.ts
//
// One-time backfill: aggregate realized_pnl from wallet_performance_history
// into the wallets table.
//
// ROOT CAUSE FIXED:
//   wallets.realized_pnl was never written during enrichment — the enricher
//   only wrote per-position rows to wallet_performance_history. The wallets
//   table column stayed at 0 for the entire lifetime of the scanner.
//
// WHAT IT DOES:
//   For every wallet with ≥1 CLOSED position in wallet_performance_history:
//     realized_pnl = SUM(total_sol_received - initial_investment)
//                    WHERE position_status = 'CLOSED'
//
// SAFE TO RE-RUN: upserts are idempotent per wallet_address.
//
// Usage: bun scripts/fix-pnl-backfill.ts
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "fs";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const PAGE  = 1_000;
const BATCH = 200;

async function main() {
  const startedAt = new Date();
  mkdirSync("exports", { recursive: true });

  console.log("=== fix-pnl-backfill.ts — WRITES to wallets.realized_pnl ===");
  console.log(`Started: ${startedAt.toISOString()}`);

  // ── Load all CLOSED positions ─────────────────────────────────────────────
  console.log("Loading CLOSED positions from wallet_performance_history…");
  const rows: Array<{ wallet_address: string; initial_investment: number; current_value: number; total_sol_received: number }> = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from("wallet_performance_history")
      .select("wallet_address, initial_investment, current_value, total_sol_received")
      .eq("position_status", "CLOSED")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`wallet_performance_history: ${error.message}`);
    if (!data?.length) break;
    rows.push(...(data as typeof rows));
    if (data.length < PAGE) break;
    from += PAGE;
    process.stdout.write(`\r  loaded ${rows.length}…`);
  }
  console.log(`\n  ${rows.length} CLOSED positions across all wallets.`);

  // ── Aggregate by wallet ───────────────────────────────────────────────────
  // Use total_sol_received when available, fall back to current_value.
  const pnlMap = new Map<string, number>();
  for (const r of rows) {
    const received  = Number(r.total_sol_received ?? r.current_value ?? 0);
    const invested  = Number(r.initial_investment ?? 0);
    const positionPnl = received - invested;
    pnlMap.set(r.wallet_address, (pnlMap.get(r.wallet_address) ?? 0) + positionPnl);
  }

  console.log(`  ${pnlMap.size} wallets have realized P&L to write.`);

  // ── Write in batches ──────────────────────────────────────────────────────
  const updates = [...pnlMap.entries()].map(([wallet_address, realized_pnl]) => ({
    wallet_address,
    realized_pnl,
  }));

  let written = 0;
  let errors  = 0;
  for (let i = 0; i < updates.length; i += BATCH) {
    const slice = updates.slice(i, i + BATCH);
    const { error } = await sb
      .from("wallets")
      .upsert(slice, { onConflict: "wallet_address" });
    if (error) {
      console.error(`  ✗ batch ${i}–${i + BATCH}: ${error.message}`);
      errors++;
    } else {
      written += slice.length;
    }
    if (i % 5000 === 0) process.stdout.write(`\r  written ${written}/${updates.length}…`);
  }
  console.log(`\n  Written ${written}/${updates.length} wallets. Errors: ${errors}.`);

  const finishedAt = new Date();
  const summary = {
    startedAt:    startedAt.toISOString(),
    finishedAt:   finishedAt.toISOString(),
    durationMs:   finishedAt.getTime() - startedAt.getTime(),
    closedRows:   rows.length,
    walletsUpdated: written,
    writeErrors:  errors,
  };

  const summaryPath = `exports/fix-pnl-backfill-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  console.log("=== DONE ===");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
