// =============================================================================
// integrity-monitor.ts
//
// Automated daily health check — read-only, no writes.
//
// Designed to run as the LAST step of daily-pipeline.ts, or standalone.
// Outputs a concise PASS / WARN / FAIL report to stdout (Railway logs).
// Complete in < 60 seconds.
//
// Each check returns one of:
//   PASS  — within acceptable threshold
//   WARN  — degraded but not broken; investigate soon
//   FAIL  — broken; pipeline output is unreliable
//
// Exit code: 0 = all PASS/WARN, 1 = any FAIL
//
// Usage: bun scripts/integrity-monitor.ts
// =============================================================================

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

type Status = "PASS" | "WARN" | "FAIL";

interface Check {
  name:   string;
  status: Status;
  value:  string;
  note?:  string;
}

const checks: Check[] = [];

function pass(name: string, value: string, note?: string) {
  checks.push({ name, status: "PASS", value, note });
}
function warn(name: string, value: string, note: string) {
  checks.push({ name, status: "WARN", value, note });
}
function fail(name: string, value: string, note: string) {
  checks.push({ name, status: "FAIL", value, note });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function cnt(
  table: string,
  filters: Record<string, unknown> = {},
  notNull?: string,
  isNull?: string,
): Promise<number> {
  let q = sb.from(table).select("*", { count: "exact", head: true });
  for (const [k, v] of Object.entries(filters)) {
    if (v === null)            q = (q as any).is(k, null);
    else if (Array.isArray(v)) q = (q as any).in(k, v);
    else                       q = (q as any).eq(k, v as string | number | boolean);
  }
  if (notNull) q = (q as any).not(notNull, "is", null);
  if (isNull)  q = (q as any).is(isNull, null);
  const { count: n, error } = await q;
  if (error) { console.warn(`  count(${table}): ${error.message}`); return -1; }
  return n ?? 0;
}

async function cntGte(table: string, col: string, val: number): Promise<number> {
  const { count: n, error } = await sb
    .from(table).select("*", { count: "exact", head: true }).gte(col, val);
  if (error) return -1;
  return n ?? 0;
}

// ── Checks ───────────────────────────────────────────────────────────────────

async function checkScoring() {
  const total  = await cnt("wallets");
  const scored = await cntGte("wallets", "intelligence_score", 0);
  const pct    = total > 0 ? Math.round(scored / total * 100) : 0;

  if (scored === 0) {
    fail("Scored wallets", `0 / ${total}`, "No wallets have a score — rescore may have failed");
  } else if (pct < 10) {
    warn("Scored wallets", `${scored.toLocaleString()} / ${total.toLocaleString()} (${pct}%)`,
      "Very low scoring coverage");
  } else {
    pass("Scored wallets", `${scored.toLocaleString()} / ${total.toLocaleString()} (${pct}%)`);
  }

  // Check score freshness — any scored wallet should have score_computed_at within 48h
  const cutoff = new Date(Date.now() - 48 * 3_600_000).toISOString();
  const stale = await (async () => {
    const { count: n } = await sb.from("wallets")
      .select("*", { count: "exact", head: true })
      .not("intelligence_score", "is", null)
      .lt("score_computed_at", cutoff);
    return n ?? 0;
  })();

  if (stale > 1000) {
    fail("Stale scores (> 48h)", stale.toLocaleString(), "audit-rescore-v2.ts may not have run today");
  } else if (stale > 0) {
    warn("Stale scores (> 48h)", stale.toLocaleString(), "A small number of wallets may have been skipped");
  } else {
    pass("Stale scores (> 48h)", "0");
  }
}

async function checkWinRate() {
  const scored = await cntGte("wallets", "intelligence_score", 0);
  const nullWr = await (async () => {
    const { count: n } = await sb.from("wallets")
      .select("*", { count: "exact", head: true })
      .not("intelligence_score", "is", null)
      .is("win_rate", null);
    return n ?? 0;
  })();

  const pct = scored > 0 ? Math.round(nullWr / scored * 100) : 0;

  if (pct >= 50) {
    fail("Null win_rate on scored wallets",
      `${nullWr.toLocaleString()} / ${scored.toLocaleString()} (${pct}%)`,
      "win_rate fallback in audit-rescore-v2.ts is not working — smart_money/sniper promotion broken");
  } else if (pct >= 10) {
    warn("Null win_rate on scored wallets",
      `${nullWr.toLocaleString()} (${pct}%)`,
      "Some wallets missing win_rate — check classifyWallet() return path");
  } else {
    pass("Null win_rate on scored wallets", `${nullWr.toLocaleString()} (${pct}%)`);
  }
}

async function checkClassification() {
  const sm      = await cnt("wallets", { wallet_classification: "smart_money" });
  const sniper  = await cnt("wallets", { wallet_classification: "sniper" });
  const whale   = await cnt("wallets", { wallet_classification: "whale" });
  const retail  = await cnt("wallets", { wallet_classification: "retail" });
  const unknown = await cnt("wallets", { wallet_classification: "unknown" });

  // Scored wallets still classified as unknown (means fix-classification-promotion didn't run)
  const unknownWithScore = await (async () => {
    const { count: n } = await sb.from("wallets")
      .select("*", { count: "exact", head: true })
      .eq("wallet_classification", "unknown")
      .not("intelligence_score", "is", null);
    return n ?? 0;
  })();

  if (unknownWithScore > 500) {
    fail("Scored wallets stuck as unknown", unknownWithScore.toLocaleString(),
      "fix-classification-promotion.ts did not run after rescore");
  } else if (unknownWithScore > 0) {
    warn("Scored wallets stuck as unknown", unknownWithScore.toLocaleString(),
      "A few wallets not yet classified — re-run fix-classification-promotion.ts");
  } else {
    pass("Scored wallets stuck as unknown", "0");
  }

  // Smart money wallets should actually meet the threshold (score >= 0.80)
  const smBelowThreshold = await (async () => {
    const { count: n } = await sb.from("wallets")
      .select("*", { count: "exact", head: true })
      .eq("wallet_classification", "smart_money")
      .lt("intelligence_score", 0.80);
    return n ?? 0;
  })();

  if (smBelowThreshold > 0) {
    fail("smart_money wallets below 0.80 threshold", smBelowThreshold.toLocaleString(),
      "Stale promotions not demoted — fix-classification-promotion.ts demotion logic may not be applied");
  } else {
    pass("smart_money wallets below 0.80 threshold", "0");
  }

  // Missing whales: retail wallets with high PnL that should be whale
  const missedWhales = await (async () => {
    const { count: n } = await sb.from("wallets")
      .select("*", { count: "exact", head: true })
      .eq("wallet_classification", "retail")
      .gte("realized_pnl", 100)
      .gte("closed_position_count", 5);
    return n ?? 0;
  })();

  if (missedWhales > 0) {
    fail("Retail wallets qualifying as whale", missedWhales.toLocaleString(),
      "High-PnL wallets not promoted — re-run fix-classification-promotion.ts");
  } else {
    pass("Retail wallets qualifying as whale", "0");
  }

  pass("Classification counts",
    `smart_money=${sm} sniper=${sniper} whale=${whale} retail=${retail.toLocaleString()} unknown=${unknown.toLocaleString()}`);
}

async function checkROIIntegrity() {
  const nullRoiClosed = await (async () => {
    const { count: n } = await sb.from("wallet_performance_history")
      .select("*", { count: "exact", head: true })
      .eq("position_status", "CLOSED")
      .is("roi_multiple", null)
      .gt("initial_investment", 0);
    return n ?? 0;
  })();

  if (nullRoiClosed > 100) {
    fail("CLOSED positions with null ROI", nullRoiClosed.toLocaleString(),
      "patch-null-roi.ts did not run or backfill is incomplete");
  } else if (nullRoiClosed > 0) {
    warn("CLOSED positions with null ROI", nullRoiClosed.toLocaleString(),
      "Likely race condition with enricher — patch-null-roi.ts will fix these");
  } else {
    pass("CLOSED positions with null ROI", "0");
  }

  // Stale OPEN positions (opened before Jul 1 — should have been force-closed)
  const staleOpen = await (async () => {
    const { count: n } = await sb.from("wallet_performance_history")
      .select("*", { count: "exact", head: true })
      .eq("position_status", "OPEN")
      .lt("last_updated", "2026-07-01T00:00:00.000Z");
    return n ?? 0;
  })();

  if (staleOpen > 0) {
    warn("Stale OPEN positions (< Jul 1)", staleOpen.toLocaleString(),
      "fix-stale-positions.ts should be re-run");
  } else {
    pass("Stale OPEN positions (< Jul 1)", "0");
  }
}

async function checkJobQueue() {
  const pending  = await cnt("wallet_collection_jobs", { status: "pending" });
  const failed   = await cnt("wallet_collection_jobs", { status: "failed" });
  const stuck    = await cnt("wallet_collection_jobs", { status: "processing" });

  if (stuck > 0) {
    fail("Stuck processing jobs", stuck.toLocaleString(),
      "Jobs locked in 'processing' — worker may have crashed; run fix-jobs-reset.ts");
  } else {
    pass("Stuck processing jobs", "0");
  }

  if (failed > 20) {
    warn("Failed jobs", failed.toLocaleString(), "High failure rate — check Helius API key / rate limits");
  } else if (failed > 0) {
    pass("Failed jobs", failed.toLocaleString(), "low count, acceptable");
  } else {
    pass("Failed jobs", "0");
  }

  pass("Pending jobs", pending.toLocaleString());

  const nullPool = await (async () => {
    const { count: n } = await sb.from("wallet_collection_jobs")
      .select("*", { count: "exact", head: true })
      .is("pool_address", null)
      .in("status", ["done", "failed"]);
    return n ?? 0;
  })();

  if (nullPool > 500) {
    warn("Done/Failed jobs with null pool_address", nullPool.toLocaleString(),
      "Run: node backfill-pool-address.mjs");
  } else if (nullPool > 0) {
    pass("Done/Failed jobs with null pool_address", nullPool.toLocaleString(), "low, acceptable");
  } else {
    pass("Done/Failed jobs with null pool_address", "0");
  }
}

async function checkDataGaps() {
  const nullAge = await (async () => {
    const { count: n } = await sb.from("wallet_token_activity")
      .select("*", { count: "exact", head: true })
      .is("token_age_at_entry", null);
    return n ?? 0;
  })();

  if (nullAge > 400_000) {
    fail("Null token_age_at_entry rows", nullAge.toLocaleString(),
      "Sniper detection non-functional — run: node backfill-wallet-activity.mjs");
  } else if (nullAge > 50_000) {
    warn("Null token_age_at_entry rows", nullAge.toLocaleString(),
      "Sniper detection degraded — schedule backfill-wallet-activity.mjs");
  } else {
    pass("Null token_age_at_entry rows", nullAge.toLocaleString());
  }

  // has_evidence flag integrity
  const falseEvidenceWithBuys = await (async () => {
    const { count: n } = await sb.from("wallet_raw_tx_metrics")
      .select("*", { count: "exact", head: true })
      .eq("has_evidence", false)
      .gt("total_buy_txs", 0);
    return n ?? 0;
  })();

  if (falseEvidenceWithBuys > 100) {
    warn("has_evidence=false but buy txs > 0", falseEvidenceWithBuys.toLocaleString(),
      "Tombstone flag bug in upsertRawMetrics — these wallets are excluded from scoring");
  } else if (falseEvidenceWithBuys > 0) {
    warn("has_evidence=false but buy txs > 0", falseEvidenceWithBuys.toLocaleString(),
      "Known tombstone bug — fix when upsertRawMetrics is updated");
  } else {
    pass("has_evidence=false but buy txs > 0", "0");
  }
}

async function checkLeaderboard() {
  const now      = Date.now();
  const minAge   = new Date(now - 3  * 86_400_000).toISOString();
  const maxInact = new Date(now - 90 * 86_400_000).toISOString();

  const { count: eligible } = await sb.from("wallets")
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

  if ((eligible ?? 0) < 10) {
    fail("Leaderboard eligible wallets", String(eligible ?? 0),
      "Too few wallets qualify — check scoring, classification, and timestamp fields");
  } else if ((eligible ?? 0) < 30) {
    warn("Leaderboard eligible wallets", String(eligible ?? 0),
      "Low count — classification or timestamp issue may be reducing coverage");
  } else {
    pass("Leaderboard eligible wallets", String(eligible ?? 0));
  }
}

// ── Runner ────────────────────────────────────────────────────────────────────

async function main() {
  const now = new Date().toISOString();
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  INTEGRITY MONITOR — Solana Scanner                         ║");
  console.log(`║  ${now.slice(0, 19).replace("T", " ")} UTC${" ".repeat(37)}║`);
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log("  (READ-ONLY — no writes)\n");

  // Run all checks
  await checkScoring();
  await checkWinRate();
  await checkClassification();
  await checkROIIntegrity();
  await checkJobQueue();
  await checkDataGaps();
  await checkLeaderboard();

  // Print report
  const width = 64;
  console.log("\n" + "─".repeat(width));
  console.log("  HEALTH REPORT");
  console.log("─".repeat(width));

  let fails = 0;
  let warns = 0;

  for (const c of checks) {
    const icon = c.status === "PASS" ? "✅" : c.status === "WARN" ? "⚠️ " : "❌";
    const label = c.name.padEnd(44);
    const line  = `  ${icon}  ${label} ${c.value}`;
    console.log(line);
    if (c.note) console.log(`       ↳ ${c.note}`);
    if (c.status === "FAIL") fails++;
    if (c.status === "WARN") warns++;
  }

  console.log("─".repeat(width));
  const verdict = fails > 0
    ? `❌  ${fails} FAIL, ${warns} WARN — pipeline output is unreliable`
    : warns > 0
      ? `⚠️   0 FAIL, ${warns} WARN — degraded, investigate soon`
      : `✅  All checks passed`;
  console.log(`\n  ${verdict}\n`);

  if (fails > 0) process.exit(1);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
