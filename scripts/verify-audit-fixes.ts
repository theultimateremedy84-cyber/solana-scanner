// =============================================================================
// verify-audit-fixes.ts
//
// Read-only verification report — July 2026 audit post-fix state.
//
// Checks all metrics from the audit and prints a before/after comparison.
// NEVER WRITES to any table.
//
// Usage: bun scripts/verify-audit-fixes.ts
// =============================================================================

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

// Pre-audit baseline values for before/after display
const BASELINE = {
  totalWallets:        48_679,
  scoredWallets:       46_513,
  scoredPct:           "95.6%",
  staleOpenPositions:  63,
  roiNullClosedFixed:  0,
  positivePnl:         86,
  pendingJobs:         48,
  failedJobs:          59,
  riskScoreZero:       7_574,
};

async function count(
  table: string,
  filters: Record<string, unknown> = {},
): Promise<number> {
  let q = sb.from(table).select("*", { count: "exact", head: true });
  for (const [k, v] of Object.entries(filters)) {
    if (v === null)       q = (q as ReturnType<typeof sb.from>).is(k, null);
    else if (Array.isArray(v)) q = (q as ReturnType<typeof sb.from>).in(k, v);
    else                  q = (q as ReturnType<typeof sb.from>).eq(k, v as string | number | boolean);
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

async function countLt(table: string, col: string, val: number, extra?: { col: string; val: string }): Promise<number> {
  let q = sb.from(table).select("*", { count: "exact", head: true }).lt(col, val);
  if (extra) q = (q as ReturnType<typeof sb.from>).eq(extra.col, extra.val);
  const { count: n, error } = await q;
  if (error) { console.warn(`  countLt: ${error.message}`); return -1; }
  return n ?? 0;
}

function delta(before: number | string, after: number): string {
  if (typeof before === "string") return "";
  const d = after - before;
  if (d === 0) return " (unchanged)";
  return d > 0 ? ` (+${d.toLocaleString()})` : ` (${d.toLocaleString()})`;
}

function row(label: string, before: number | string, after: number, goal?: string): void {
  const b = typeof before === "number" ? before.toLocaleString() : before;
  const a = after === -1 ? "ERROR" : after.toLocaleString();
  const d = after === -1 ? "" : delta(before, after);
  const g = goal ? `  ← ${goal}` : "";
  console.log(`  ${label.padEnd(38)} ${b.padStart(10)}  →  ${a.padStart(10)}${d}${g}`);
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║       POST-FIX VERIFICATION — July 2026 Audit              ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log("  (READ-ONLY — no writes)");
  console.log();

  // ── Scoring ───────────────────────────────────────────────────────────────
  console.log("SCORING");
  console.log("  " + "─".repeat(70));
  const totalWallets   = await count("wallets");
  const scoredWallets  = await countGte("wallets", "intelligence_score", 0);
  const scoredWith0closed = (await (async () => {
    const { count: n } = await sb.from("wallets")
      .select("*", { count: "exact", head: true })
      .not("intelligence_score", "is", null)
      .eq("closed_position_count", 0);
    return n ?? 0;
  })());

  row("Total wallets",               BASELINE.totalWallets,   totalWallets);
  row("Scored wallets",              BASELINE.scoredWallets,  scoredWallets,  "↓ drastically = good");
  row("Scored (% total)",            BASELINE.scoredPct,      Math.round(scoredWallets / totalWallets * 100));
  row("Scored with 0 closed exits",  624,                     scoredWith0closed, "should be ~0 ✅");
  console.log();

  // ── Confidence tiers ──────────────────────────────────────────────────────
  console.log("CONFIDENCE TIERS (post-fix)");
  console.log("  " + "─".repeat(70));
  for (const tier of ["elite", "high", "medium", "low", "unrated"]) {
    const n = await count("wallets", { confidence_tier: tier });
    console.log(`  ${tier.padEnd(12)}  ${n.toLocaleString()}`);
  }
  console.log();

  // ── Classification ────────────────────────────────────────────────────────
  console.log("CLASSIFICATION (post-fix)");
  console.log("  " + "─".repeat(70));
  const classes = ["smart_money", "sniper", "whale", "retail", "unknown", "bot"];
  const BASELINE_CLS: Record<string, number> = {
    smart_money: 0, sniper: 0, whale: 84, retail: 35_324, unknown: 13_366, bot: 0,
  };
  for (const cls of classes) {
    const n = await count("wallets", { wallet_classification: cls });
    row(cls, BASELINE_CLS[cls] ?? 0, n);
  }
  console.log();

  // ── Leaderboard ───────────────────────────────────────────────────────────
  console.log("LEADERBOARD ELIGIBILITY");
  console.log("  " + "─".repeat(70));
  const now = Date.now();
  const minAge    = new Date(now - 3  * 86_400_000).toISOString();
  const maxInact  = new Date(now - 90 * 86_400_000).toISOString();
  const { count: lbClean } = await sb.from("wallets")
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
  row("Eligible (excl. bot/unknown)", 775, lbClean ?? 0, "↑ = more real wallets ✅");
  console.log();

  // ── P&L accuracy ─────────────────────────────────────────────────────────
  console.log("P&L ACCURACY");
  console.log("  " + "─".repeat(70));
  const positivePnl = await countGte("wallets", "realized_pnl", 0.001);
  const negativePnl = (await (async () => {
    const { count: n } = await sb.from("wallets")
      .select("*", { count: "exact", head: true }).lt("realized_pnl", 0);
    return n ?? 0;
  })());
  const { count: zeroPnlScored } = await sb.from("wallets")
    .select("*", { count: "exact", head: true })
    .not("intelligence_score", "is", null)
    .eq("realized_pnl", 0);
  row("Wallets with positive pnl", BASELINE.positivePnl, positivePnl, "↑ big ✅");
  row("Wallets with negative pnl", 23_059,               negativePnl);
  row("Scored wallets with pnl=0", 17_182,               zeroPnlScored ?? 0, "should be ~0 ✅");
  console.log();

  // ── Position health ───────────────────────────────────────────────────────
  console.log("POSITION HEALTH");
  console.log("  " + "─".repeat(70));
  const staleOpen = await countLt("wallet_performance_history", "last_updated", "2026-07-01T00:00:00.000Z" as unknown as number, { col: "position_status", val: "OPEN" });
  const roiNull   = (await (async () => {
    const { count: n } = await sb.from("wallet_performance_history")
      .select("*", { count: "exact", head: true })
      .eq("position_status", "CLOSED")
      .is("roi_multiple", null)
      .gt("initial_investment", 0);
    return n ?? 0;
  })());
  row("Stale OPEN positions (< Jul 1)", BASELINE.staleOpenPositions, staleOpen, "should be 0 ✅");
  row("CLOSED with null ROI (fixable)", 0, roiNull, "should be 0 ✅");
  console.log();

  // ── Job queue ─────────────────────────────────────────────────────────────
  console.log("JOB QUEUE");
  console.log("  " + "─".repeat(70));
  const pendingJobs = await count("wallet_collection_jobs", { status: "pending" });
  const failedJobs  = await count("wallet_collection_jobs", { status: "failed" });
  const doneJobs    = await count("wallet_collection_jobs", { status: "done" });
  row("Pending jobs",  BASELINE.pendingJobs, pendingJobs);
  row("Failed jobs",   BASELINE.failedJobs,  failedJobs, "manual review needed");
  row("Done jobs",     8_534,                doneJobs);
  console.log();

  // ── Risk scores (Railway code fix still needed) ───────────────────────────
  console.log("SCAN RISK SCORES (needs Railway code deploy — Fix #1)");
  console.log("  " + "─".repeat(70));
  const riskZero = await count("scan_history", { risk_score: 0 });
  const riskSet  = await countGte("scan_history", "risk_score", 1);
  row("Scans with risk_score = 0", BASELINE.riskScoreZero, riskZero, "should shrink after deploy");
  row("Scans with risk_score > 0", 151,                    riskSet);
  console.log();

  // ── Top 10 wallets ────────────────────────────────────────────────────────
  console.log("TOP 10 WALLETS (post all fixes)");
  console.log("  " + "─".repeat(70));
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
    const pnl   = (w.realized_pnl as number ?? 0).toFixed(2) + "◎";
    const roi   = w.average_roi != null ? (w.average_roi as number).toFixed(1) + "x" : "—";
    const cls   = w.wallet_classification as string ?? "?";
    const tier  = w.confidence_tier as string ?? "?";
    const buys  = w.total_buys as number ?? 0;
    const closed = w.closed_position_count as number ?? 0;
    console.log(
      `  ${addr}  score=${score}  wr=${wr}  pnl=${pnl}  roi=${roi}` +
      `  buys=${buys}  closed=${closed}  ${tier}  ${cls}`,
    );
  }

  console.log();
  console.log("=== VERIFICATION COMPLETE ===");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
