// =============================================================================
// verify-audit-fixes.ts
//
// Read-only verification report — July 2026 audit post-fix state.
//
// Checks all metrics from the audit and prints a before/after comparison.
// NEVER WRITES to any table.
//
// BASELINES UPDATED (July 20 re-audit):
//   The original baselines reflected the pre-first-audit state (before June 2026
//   fixes). These have been updated to reflect the July 20 live snapshot, which
//   is the "before" state for the second round of fixes (ROI backfill,
//   classification promotion, pool address backfill, wallet activity backfill).
//   Items already fixed in the first round are marked ✅ DONE in the goals.
//
// Usage: bun scripts/verify-audit-fixes.ts
// =============================================================================

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

// ── Baselines (live snapshot July 20, 2026 — after first-round fixes) ────────
const BASELINE = {
  // Wallet counts
  totalWallets:          54_303,
  scoredWallets:          9_563,
  scoredPct:             "17.6%",

  // Classification (first-round fix not yet run)
  smartMoney:                 0,
  sniper:                     0,
  whale:                     38,
  retail:                 9_435,
  unknown:               44_830,
  bot:                        0,

  // Confidence tiers
  tierElite:                346,
  tierHigh:                 620,
  tierMedium:             4_042,
  tierLow:               30_928,
  tierUnrated:           18_265,

  // P&L (fix-pnl-backfill.ts already run ✅)
  positivePnl:            2_759,
  zeroPnlScored:              0,

  // Positions
  staleOpenPositions:         0,   // fix-stale-positions.ts run ✅
  roiNullClosed:         54_552,   // NEW — fix-roi-backfill.ts NOT yet run
  wphTotal:             136_347,

  // Job queue
  pendingJobs:               52,
  failedJobs:                 0,
  doneJobs:              10_312,
  nullPoolDone:           1_519,   // backfill-pool-address.mjs NOT yet run

  // Risk scores (Railway deploy still pending)
  riskScoreZero:          6_413,
  riskScoreSet:           2_029,

  // Leaderboard
  lbEligible:                77,

  // wallet_token_activity backfill (NOT yet run)
  wtaNullAmountUsd:      35_047,
  wtaNullTokenAge:      246_499,
};

async function count(
  table: string,
  filters: Record<string, unknown> = {},
): Promise<number> {
  let q = sb.from(table).select("*", { count: "exact", head: true });
  for (const [k, v] of Object.entries(filters)) {
    if (v === null)            q = (q as any).is(k, null);
    else if (Array.isArray(v)) q = (q as any).in(k, v);
    else                       q = (q as any).eq(k, v as string | number | boolean);
  }
  const { count: n, error } = await q;
  if (error) { console.warn(`  count(${table}): ${error.message}`); return -1; }
  return n ?? 0;
}

async function countGte(table: string, col: string, val: number): Promise<number> {
  const { count: n, error } = await sb
    .from(table).select("*", { count: "exact", head: true }).gte(col, val);
  if (error) { console.warn(`  countGte: ${error.message}`); return -1; }
  return n ?? 0;
}

function delta(before: number | string, after: number): string {
  if (typeof before === "string") return "";
  if (after === -1) return " (query error)";
  const d = after - before;
  if (d === 0) return " (unchanged)";
  return d > 0 ? ` (+${d.toLocaleString()})` : ` (${d.toLocaleString()})`;
}

function row(label: string, before: number | string, after: number, goal?: string): void {
  const b = typeof before === "number" ? before.toLocaleString() : before;
  const a = after === -1 ? "ERROR" : after.toLocaleString();
  const d = after === -1 ? "" : delta(before, after);
  const g = goal ? `  ← ${goal}` : "";
  console.log(`  ${label.padEnd(42)} ${b.padStart(10)}  →  ${a.padStart(10)}${d}${g}`);
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║      POST-FIX VERIFICATION — July 2026 Re-Audit                 ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");
  console.log("  (READ-ONLY — no writes)");
  console.log("  Baselines = July 20 live snapshot (after first-round fixes)");
  console.log();

  // ── Scoring ───────────────────────────────────────────────────────────────
  console.log("SCORING");
  console.log("  " + "─".repeat(74));
  const totalWallets  = await count("wallets");
  const scoredWallets = await countGte("wallets", "intelligence_score", 0);
  const scoredPct     = totalWallets > 0
    ? Math.round((scoredWallets / totalWallets) * 100)
    : 0;
  const scoredWith0closed = await (async () => {
    const { count: n } = await sb.from("wallets")
      .select("*", { count: "exact", head: true })
      .not("intelligence_score", "is", null)
      .eq("closed_position_count", 0);
    return n ?? 0;
  })();

  row("Total wallets",              BASELINE.totalWallets,  totalWallets);
  row("Scored wallets",             BASELINE.scoredWallets, scoredWallets);
  row("Scored %",                   BASELINE.scoredPct,     scoredPct);
  row("Scored with 0 closed exits", 0,                      scoredWith0closed, "should be 0 ✅");
  console.log();

  // ── Classification ────────────────────────────────────────────────────────
  console.log("CLASSIFICATION");
  console.log("  " + "─".repeat(74));
  const smartMoney = await count("wallets", { wallet_classification: "smart_money" });
  const sniper     = await count("wallets", { wallet_classification: "sniper" });
  const whale      = await count("wallets", { wallet_classification: "whale" });
  const retail     = await count("wallets", { wallet_classification: "retail" });
  const unknown    = await count("wallets", { wallet_classification: "unknown" });
  const bot        = await count("wallets", { wallet_classification: "bot" });

  row("smart_money", BASELINE.smartMoney, smartMoney, "↑ after fix-classification-promotion.ts");
  row("sniper",      BASELINE.sniper,     sniper,     "↑ after fix-classification-promotion.ts");
  row("whale",       BASELINE.whale,      whale);
  row("retail",      BASELINE.retail,     retail,     "↑ absorbs unknown wallets");
  row("unknown",     BASELINE.unknown,    unknown,    "↓ after fix-classification-promotion.ts");
  row("bot",         BASELINE.bot,        bot);
  console.log();

  // ── Confidence tiers ──────────────────────────────────────────────────────
  console.log("CONFIDENCE TIERS");
  console.log("  " + "─".repeat(74));
  for (const [key, tier] of [
    ["tierElite",   "elite"],
    ["tierHigh",    "high"],
    ["tierMedium",  "medium"],
    ["tierLow",     "low"],
    ["tierUnrated", "unrated"],
  ] as const) {
    const n = await count("wallets", { confidence_tier: tier });
    row(tier, BASELINE[key as keyof typeof BASELINE] as number, n);
  }
  console.log();

  // ── Leaderboard ───────────────────────────────────────────────────────────
  console.log("LEADERBOARD ELIGIBILITY");
  console.log("  " + "─".repeat(74));
  const now      = Date.now();
  const minAge   = new Date(now - 3  * 86_400_000).toISOString();
  const maxInact = new Date(now - 90 * 86_400_000).toISOString();
  const { count: lbEligible } = await sb.from("wallets")
    .select("*", { count: "exact", head: true })
    .not("confidence_tier", "is", null)
    .neq("confidence_tier", "unrated")
    .gte("intelligence_score", 0.30)
    .gte("total_tokens_traded", 3)
    .not("wallet_classification", "in", '("bot","unknown")')
    .not("first_seen_timestamp", "is", null)
    .lte("first_seen_timestamp", minAge)
    .not("last_seen_timestamp", "is", null)
    .gte("last_seen_timestamp", maxInact);
  row("Eligible (excl. bot/unknown)", BASELINE.lbEligible, lbEligible ?? 0,
    "↑ after classification + ROI fixes");
  console.log();

  // ── P&L accuracy ─────────────────────────────────────────────────────────
  console.log("P&L ACCURACY (fix-pnl-backfill.ts ✅ DONE)");
  console.log("  " + "─".repeat(74));
  const positivePnl  = await countGte("wallets", "realized_pnl", 0.001);
  const { count: zeroPnlScored } = await sb.from("wallets")
    .select("*", { count: "exact", head: true })
    .not("intelligence_score", "is", null)
    .eq("realized_pnl", 0);
  row("Wallets with positive pnl",   BASELINE.positivePnl,   positivePnl,         "already fixed ✅");
  row("Scored wallets with pnl = 0", BASELINE.zeroPnlScored, zeroPnlScored ?? 0,  "should stay 0 ✅");
  console.log();

  // ── Position ROI health ───────────────────────────────────────────────────
  console.log("POSITION ROI HEALTH (fix-roi-backfill.ts PENDING)");
  console.log("  " + "─".repeat(74));
  const staleOpen   = await (async () => {
    const { count: n } = await sb.from("wallet_performance_history")
      .select("*", { count: "exact", head: true })
      .eq("position_status", "OPEN")
      .lt("last_updated", "2026-07-01T00:00:00.000Z");
    return n ?? 0;
  })();
  const roiNullClosed = await (async () => {
    const { count: n } = await sb.from("wallet_performance_history")
      .select("*", { count: "exact", head: true })
      .eq("position_status", "CLOSED")
      .is("roi_multiple", null)
      .gt("initial_investment", 0);
    return n ?? 0;
  })();
  const wphTotal = await count("wallet_performance_history");

  row("Stale OPEN positions (< Jul 1)", BASELINE.staleOpenPositions, staleOpen,
    "already fixed ✅");
  row("CLOSED with null ROI & invest>0", BASELINE.roiNullClosed, roiNullClosed,
    "should be 0 after fix-roi-backfill.ts");
  row("Total WPH rows",                 BASELINE.wphTotal, wphTotal);
  console.log();

  // ── Job queue ─────────────────────────────────────────────────────────────
  console.log("JOB QUEUE");
  console.log("  " + "─".repeat(74));
  const pendingJobs  = await count("wallet_collection_jobs", { status: "pending" });
  const failedJobs   = await count("wallet_collection_jobs", { status: "failed" });
  const doneJobs     = await count("wallet_collection_jobs", { status: "done" });
  const nullPoolDone = await (async () => {
    const { count: n } = await sb.from("wallet_collection_jobs")
      .select("*", { count: "exact", head: true })
      .is("pool_address", null)
      .in("status", ["done", "failed"]);
    return n ?? 0;
  })();

  row("Pending jobs",                    BASELINE.pendingJobs,  pendingJobs);
  row("Failed jobs",                     BASELINE.failedJobs,   failedJobs,   "manual review if > 0");
  row("Done jobs",                       BASELINE.doneJobs,     doneJobs);
  row("Done/Failed with null pool_addr", BASELINE.nullPoolDone, nullPoolDone,
    "should be 0 after backfill-pool-address.mjs");
  console.log();

  // ── Risk scores ───────────────────────────────────────────────────────────
  console.log("SCAN RISK SCORES (Railway code deploy PENDING)");
  console.log("  " + "─".repeat(74));
  const riskZero = await count("scan_history", { risk_score: 0 });
  const riskSet  = await countGte("scan_history", "risk_score", 1);
  row("Scans with risk_score = 0", BASELINE.riskScoreZero, riskZero,
    "↓ after Railway deploy");
  row("Scans with risk_score > 0", BASELINE.riskScoreSet,  riskSet,
    "↑ after Railway deploy");
  console.log();

  // ── wallet_token_activity ─────────────────────────────────────────────────
  console.log("WALLET TOKEN ACTIVITY (backfill-wallet-activity.mjs PENDING)");
  console.log("  " + "─".repeat(74));
  const wtaNullUsd = await (async () => {
    const { count: n } = await sb.from("wallet_token_activity")
      .select("*", { count: "exact", head: true }).is("amount_usd", null);
    return n ?? 0;
  })();
  const wtaNullAge = await (async () => {
    const { count: n } = await sb.from("wallet_token_activity")
      .select("*", { count: "exact", head: true }).is("token_age_at_entry", null);
    return n ?? 0;
  })();
  row("Rows with null amount_usd",      BASELINE.wtaNullAmountUsd, wtaNullUsd,
    "↓ after backfill-wallet-activity.mjs");
  row("Rows with null token_age_at_entry", BASELINE.wtaNullTokenAge, wtaNullAge,
    "↓ enables sniper detection ✅");
  console.log();

  // ── Top 10 wallets ────────────────────────────────────────────────────────
  console.log("TOP 10 WALLETS (by intelligence_score)");
  console.log("  " + "─".repeat(74));
  const { data: top10 } = await sb
    .from("wallets")
    .select(
      "wallet_address, intelligence_score, win_rate, realized_pnl, " +
      "total_buys, closed_position_count, average_roi, confidence_tier, " +
      "wallet_classification, last_seen_timestamp",
    )
    .not("intelligence_score", "is", null)
    .not("confidence_tier", "is", null)
    .neq("confidence_tier", "unrated")
    .order("intelligence_score", { ascending: false })
    .limit(10);

  for (const w of top10 ?? []) {
    const addr  = (w.wallet_address as string).slice(0, 12) + "…";
    const score = ((w.intelligence_score as number) ?? 0).toFixed(3);
    const wr    = w.win_rate != null ? ((w.win_rate as number) * 100).toFixed(0) + "%" : "—";
    const pnl   = ((w.realized_pnl as number) ?? 0).toFixed(2) + "◎";
    const roi   = w.average_roi != null ? (w.average_roi as number).toFixed(1) + "x" : "—";
    const cls   = (w.wallet_classification as string) ?? "?";
    const tier  = (w.confidence_tier as string) ?? "?";
    const buys  = (w.total_buys as number) ?? 0;
    const closed = (w.closed_position_count as number) ?? 0;
    console.log(
      `  ${addr}  score=${score}  wr=${wr}  pnl=${pnl}  roi=${roi}` +
      `  buys=${buys}  closed=${closed}  ${tier}  ${cls}`,
    );
  }

  console.log();
  console.log("=== VERIFICATION COMPLETE ===");
  console.log();
  console.log("PENDING ACTIONS CHECKLIST:");
  console.log("  [ ] Run: bun scripts/fix-roi-backfill.ts");
  console.log("        OR apply: supabase/migrations/20260720000008_roi_null_backfill.sql");
  console.log("  [ ] Run: bun scripts/fix-classification-promotion.ts");
  console.log("  [ ] Run: node backfill-pool-address.mjs");
  console.log("  [ ] Run: node backfill-wallet-activity.mjs  (30-40 min, CoinGecko rate limited)");
  console.log("  [ ] Run: bun scripts/audit-rescore-v2.ts    (after ROI backfill)");
  console.log("  [ ] Deploy Railway service for scan risk_score fix");
  console.log("  [ ] Fix enrich-hollow-wallets.mjs crashes (see updated file in this patch)");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
