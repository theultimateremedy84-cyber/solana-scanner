// =============================================================================
// validation-report.ts
//
// Re-validation of the v7 scoring formula (Breadth + Classification Bonus
// removed; confidence_tier/closed_position_count/evidence_quality/
// score_computed_at persisted) — Step 5 of the architecture-review plan.
//
// READ-ONLY. Never writes to the database. Recreates the position-building
// logic from wallet-enricher.ts's classifyWallets() (copied, not imported,
// specifically so this script cannot accidentally call the real writer) and
// feeds it into the real, currently-deployed classifyWallet() +
// computeConfidenceTier() from wallet-classifier.ts — so the "after" column
// is exactly what production will compute, not an approximation.
//
// IMPORTANT CONTEXT (found 2026-07-13 while building this report): the live
// Railway service's rescore-scheduler.ts has already been auto-applying the
// v7 formula in production every 20 minutes since deploy, ahead of this
// validation. By the time this script ran, ~49% of wallets already carried
// v7-computed values (confidence_tier IS NOT NULL). To keep the before/after
// comparison scientifically clean, this script splits its sample into:
//   - "untouched" wallets (confidence_tier IS NULL) — their stored
//     intelligence_score is still a genuine pre-v7 value, so before/after
//     here is a true comparison.
//   - "already-touched" wallets — included for Top-50 sanity/reconciliation
//     only, since their stored score already IS the v7 value.
//
// Usage: bun scripts/validation-report.ts
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import { classifyWallet, computeConfidenceTier } from "../src/lib/api/wallet-classifier";
import { guardRoiMultiple } from "../src/lib/api/tx-reconstructor";
import { writeFileSync, mkdirSync } from "fs";

const SUPABASE_URL  = process.env.SUPABASE_URL!;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const TOP_N_SAMPLE       = 300;
const RANDOM_SAMPLE      = 300;
const PER_CLASS_SAMPLE   = 50; // stratified, per classification bucket

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

async function sampleWalletAddresses(): Promise<string[]> {
  const addrs = new Set<string>();

  // 1) Top-N by current stored score (leaderboard candidates)
  {
    const { data } = await sb
      .from("wallets")
      .select("wallet_address")
      .not("intelligence_score", "is", null)
      .order("intelligence_score", { ascending: false })
      .limit(TOP_N_SAMPLE);
    for (const r of data ?? []) addrs.add(r.wallet_address as string);
  }

  // 2) Stratified by classification
  const classes = ["smart_money", "sniper", "whale", "bot", "retail", "unknown"];
  for (const cls of classes) {
    const { data } = await sb
      .from("wallets")
      .select("wallet_address")
      .eq("wallet_classification", cls)
      .order("updated_at", { ascending: false })
      .limit(PER_CLASS_SAMPLE);
    for (const r of data ?? []) addrs.add(r.wallet_address as string);
  }

  // 3) Scattered random-ish windows (use random offset pages)
  const { count } = await sb.from("wallets").select("*", { count: "exact", head: true });
  const total = count ?? 0;
  const pageSize = 25;
  const pages = Math.ceil(RANDOM_SAMPLE / pageSize);
  for (let i = 0; i < pages; i++) {
    const offset = Math.floor(Math.random() * Math.max(1, total - pageSize));
    const { data } = await sb
      .from("wallets")
      .select("wallet_address")
      .range(offset, offset + pageSize - 1);
    for (const r of data ?? []) addrs.add(r.wallet_address as string);
  }

  return Array.from(addrs);
}

// ---------------------------------------------------------------------------
// Position building — mirrors classifyWallets() in wallet-enricher.ts exactly,
// copied (not imported) so this script never touches the write path.
// ---------------------------------------------------------------------------

async function buildPositionsByWallet(walletAddresses: string[]): Promise<{
  byWallet: Map<string, Row[]>;
  usingRawByWallet: Map<string, boolean>;
}> {
  const byWallet = new Map<string, Row[]>();
  const usingRawByWallet = new Map<string, boolean>();

  const CHUNK = 300;
  for (let i = 0; i < walletAddresses.length; i += CHUNK) {
    const slice = walletAddresses.slice(i, i + CHUNK);

    const { data: rawRows } = await sb
      .from("wallet_raw_tx_metrics")
      .select(
        "wallet_address, token_address, data_source, " +
        "total_buy_txs, total_sell_txs, " +
        "total_tokens_bought, total_tokens_sold, " +
        "total_sol_invested, total_sol_received, current_token_balance",
      )
      .in("wallet_address", slice)
      .eq("has_evidence", true);

    const rawByWallet = new Map<string, Row[]>();
    for (const row of rawRows ?? []) {
      const key = row.wallet_address as string;
      if (!rawByWallet.has(key)) rawByWallet.set(key, []);
      rawByWallet.get(key)!.push(row as Row);
    }

    const missing = slice.filter((a) => !rawByWallet.has(a));
    let perfByWallet = new Map<string, Row[]>();
    if (missing.length > 0) {
      const { data: fallback } = await sb
        .from("wallet_performance_history")
        .select(
          "wallet_address, token_address, position_status, " +
          "initial_investment, current_value, realized_profit, unrealized_profit, " +
          "roi_multiple, total_tokens_bought, total_tokens_sold, current_position_value_sol",
        )
        .in("wallet_address", missing);
      for (const row of fallback ?? []) {
        const key = row.wallet_address as string;
        if (!perfByWallet.has(key)) perfByWallet.set(key, []);
        perfByWallet.get(key)!.push(row as Row);
      }
    }

    for (const addr of slice) {
      if (rawByWallet.has(addr)) {
        byWallet.set(addr, rawByWallet.get(addr)!);
        usingRawByWallet.set(addr, true);
      } else if (perfByWallet.has(addr)) {
        byWallet.set(addr, perfByWallet.get(addr)!);
        usingRawByWallet.set(addr, false);
      }
    }
  }

  return { byWallet, usingRawByWallet };
}

function buildPositionsForWallet(walletAddr: string, rows: Row[], usingRaw: boolean) {
  return rows.map((r) => {
    const tokensBought = Number(r.total_tokens_bought ?? 0);
    const tokensSold   = Number(r.total_tokens_sold ?? 0);
    const invested     = Number(usingRaw ? r.total_sol_invested : r.initial_investment) ?? 0;
    const received     = Number(usingRaw ? r.total_sol_received : r.current_value) ?? 0;
    const totalBuyTxs  = Number(usingRaw ? r.total_buy_txs : tokensBought) ?? 0;
    const balance      = Math.max(0, tokensBought - tokensSold);

    let posStatus: "OPEN" | "PARTIALLY_CLOSED" | "CLOSED" | "UNKNOWN";
    if (usingRaw) {
      const dataSource = r.data_source as string;
      if (dataSource === "holder_scan" && invested === 0) {
        posStatus = "UNKNOWN";
      } else if (tokensBought === 0 && tokensSold > 0) {
        posStatus = "CLOSED";
      } else if (tokensBought > 0 && balance <= tokensBought * 0.001) {
        posStatus = "CLOSED";
      } else if (tokensSold === 0) {
        posStatus = "OPEN";
      } else if (tokensBought > 0 && tokensSold >= tokensBought * 0.95) {
        posStatus = "CLOSED";
      } else {
        posStatus = "PARTIALLY_CLOSED";
      }
    } else {
      posStatus = (r.position_status as typeof posStatus) ?? "UNKNOWN";
    }

    const hasBuySellEvidence = totalBuyTxs > 0 || tokensBought > 0;
    const hasTransactionEvidence = posStatus !== "UNKNOWN" || hasBuySellEvidence;

    let roiMultiple: number | null = null;
    if (posStatus === "CLOSED" && invested > 0) {
      roiMultiple = guardRoiMultiple(received / invested, invested);
    }

    let realizedProfit = 0;
    if (posStatus === "CLOSED" && invested > 0) {
      realizedProfit = received - invested;
    } else if (posStatus === "PARTIALLY_CLOSED" && tokensBought > 0 && invested > 0) {
      const fracSold = tokensSold / tokensBought;
      realizedProfit = received - invested * fracSold;
    }

    return {
      walletAddress: walletAddr,
      tokenAddress: r.token_address as string,
      trades: [],
      totalTokensBought: tokensBought,
      totalTokensSold: tokensSold,
      initialInvestment: invested,
      totalSolReceived: received,
      currentTokenBalance: balance,
      positionStatus: posStatus,
      realizedProfit,
      unrealizedProfit: 0,
      roiMultiple,
      currentPositionValueSol: 0,
      peakRoi: null,
      peakPositionValueSol: null,
      firstTradeTs: null,
      lastTradeTs: null,
      hasTransactionEvidence,
    };
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  mkdirSync("exports", { recursive: true });
  const startedAt = new Date();

  console.log("=== VALIDATION REPORT — v7 formula (dry-run, read-only) ===");
  console.log(`Started: ${startedAt.toISOString()}`);

  console.log("Sampling wallet addresses...");
  const sampleAddrs = await sampleWalletAddresses();
  console.log(`Sample size: ${sampleAddrs.length} wallets.`);

  console.log("Fetching current stored DB state for sample...");
  const dbState = new Map<string, Row>();
  {
    const CHUNK = 500;
    for (let i = 0; i < sampleAddrs.length; i += CHUNK) {
      const slice = sampleAddrs.slice(i, i + CHUNK);
      const { data } = await sb
        .from("wallets")
        .select(
          "wallet_address, wallet_classification, intelligence_score, win_rate, average_roi, " +
          "conviction_score, total_buys, total_sells, total_tokens_traded, confidence_tier, " +
          "closed_position_count, evidence_quality, score_computed_at, first_seen_timestamp, last_seen_timestamp",
        )
        .in("wallet_address", slice);
      for (const row of data ?? []) dbState.set(row.wallet_address as string, row as Row);
    }
  }

  console.log("Fetching raw evidence + computing fresh v7 scores (no writes)...");
  const { byWallet, usingRawByWallet } = await buildPositionsByWallet(sampleAddrs);

  interface ReportRow {
    wallet: string;
    dbClassification: string | null;
    dbScore: number | null;
    dbConfidenceTier: string | null;
    dbEvidenceQuality: string | null;
    dbScoreComputedAt: string | null;
    newClassification: string;
    newScore: number; // 0-1
    newWinRate: number | null;
    newAverageRoi: number | null;
    newClosedPositionCount: number;
    newConfidenceTier: string;
    newEvidenceQuality: "raw" | "fallback" | "none";
    totalBuys: number;
    totalSells: number;
    wasAlreadyTouched: boolean; // confidence_tier was already non-null (scheduler got there first)
  }

  const results: ReportRow[] = [];

  for (const addr of sampleAddrs) {
    const rows = byWallet.get(addr);
    const dbRow = dbState.get(addr);
    if (!rows || !dbRow) continue; // no raw evidence at all — skip (matches production skip-if-empty)

    const usingRaw = usingRawByWallet.get(addr) ?? false;
    const positions = buildPositionsForWallet(addr, rows, usingRaw);

    // Matches the v8 bug-fix in wallet-enricher.ts's classifyWallets(): fallback
    // (non-raw) evidence has no real tx-count columns, only token quantities —
    // using rows.length as a conservative proxy instead of summing quantities.
    const totalBuyTxs = usingRaw
      ? rows.reduce((s, r) => s + Number(r.total_buy_txs ?? 0), 0)
      : rows.length;
    const totalSellTxs = usingRaw
      ? rows.reduce((s, r) => s + Number(r.total_sell_txs ?? 0), 0)
      : rows.length;
    const totalVolumeBoughtSol = rows.reduce((s, r) =>
      s + Number(usingRaw ? r.total_sol_invested : r.initial_investment), 0);
    const totalVolumeSoldSol = rows.reduce((s, r) =>
      s + Number(usingRaw ? r.total_sol_received : r.current_value), 0);

    const scores = classifyWallet({
      positions,
      totalBuys: totalBuyTxs,
      totalSells: totalSellTxs,
      totalVolumeBoughtSol,
      totalVolumeSoldSol,
    });

    const evidenceQuality: "raw" | "fallback" = usingRaw ? "raw" : "fallback";
    const confidenceTier = computeConfidenceTier({
      evidenceQuality,
      closedPositionCount: scores.closedPositionCount,
    });

    results.push({
      wallet: addr,
      dbClassification: (dbRow.wallet_classification as string) ?? null,
      dbScore: dbRow.intelligence_score != null ? Number(dbRow.intelligence_score) : null,
      dbConfidenceTier: (dbRow.confidence_tier as string) ?? null,
      dbEvidenceQuality: (dbRow.evidence_quality as string) ?? null,
      dbScoreComputedAt: (dbRow.score_computed_at as string) ?? null,
      newClassification: scores.classification,
      newScore: scores.intelligenceScore / 100,
      newWinRate: scores.winRate,
      newAverageRoi: scores.averageRoi,
      newClosedPositionCount: scores.closedPositionCount,
      newConfidenceTier: confidenceTier,
      newEvidenceQuality: evidenceQuality,
      totalBuys: totalBuyTxs,
      totalSells: totalSellTxs,
      wasAlreadyTouched: dbRow.confidence_tier != null,
    });
  }

  console.log(`Scored ${results.length} wallets (had evidence; ${sampleAddrs.length - results.length} skipped — no raw/fallback data).`);

  // ── Split: untouched (true before/after) vs already-touched (sanity only) ──
  const untouched = results.filter((r) => !r.wasAlreadyTouched);
  const touched    = results.filter((r) => r.wasAlreadyTouched);

  console.log(`Untouched by scheduler (true pre-v7 "before" data): ${untouched.length}`);
  console.log(`Already touched by scheduler (post-v7 already): ${touched.length}`);

  // ── Score distribution (untouched only — true before/after) ──
  function bucket(score: number): string {
    if (score >= 0.8) return "0.80-1.00";
    if (score >= 0.6) return "0.60-0.79";
    if (score >= 0.4) return "0.40-0.59";
    if (score >= 0.3) return "0.30-0.39 (leaderboard floor)";
    if (score >= 0.1) return "0.10-0.29";
    return "0.00-0.09";
  }
  const buckets = ["0.80-1.00", "0.60-0.79", "0.40-0.59", "0.30-0.39 (leaderboard floor)", "0.10-0.29", "0.00-0.09"];
  const beforeDist: Record<string, number> = Object.fromEntries(buckets.map((b) => [b, 0]));
  const afterDist: Record<string, number> = Object.fromEntries(buckets.map((b) => [b, 0]));
  for (const r of untouched) {
    if (r.dbScore != null) beforeDist[bucket(r.dbScore)]++;
    afterDist[bucket(r.newScore)]++;
  }

  // ── Reconciliation: classification changes, tier distribution ──
  let classificationChanged = 0;
  for (const r of untouched) {
    if (r.dbClassification !== r.newClassification) classificationChanged++;
  }
  const tierCounts: Record<string, number> = {};
  for (const r of results) tierCounts[r.newConfidenceTier] = (tierCounts[r.newConfidenceTier] ?? 0) + 1;

  // ── Top-50 by fresh v7 score, across the full sample ──
  const top50 = [...results].sort((a, b) => b.newScore - a.newScore).slice(0, 50);

  // ── Leaderboard-gate crossers: wallets that would newly fall below/above 0.30 ──
  const droppedBelowFloor = untouched.filter((r) => (r.dbScore ?? 0) >= 0.30 && r.newScore < 0.30);
  const roseAboveFloor = untouched.filter((r) => (r.dbScore ?? 0) < 0.30 && r.newScore >= 0.30);

  // ── Build markdown report ──
  const lines: string[] = [];
  lines.push("# Validation Report — Scoring Formula v7 (dry-run, no production writes)");
  lines.push("");
  lines.push(`Generated: ${startedAt.toISOString()}`);
  lines.push(`Sample size: ${sampleAddrs.length} wallets (top-${TOP_N_SAMPLE}-by-score + stratified-by-classification + scattered random windows)`);
  lines.push(`Scored (had evidence): ${results.length}`);
  lines.push("");
  lines.push("## Operational note");
  lines.push("");
  lines.push(
    "The live service's `rescore-scheduler.ts` was already auto-applying the v7 formula in " +
    "production every 20 minutes ahead of this report (its scores only improve/never revert, " +
    "and it is idempotent from the underlying raw evidence, so this is not destructive — but it " +
    "means roughly half the wallets table already reflects v7 by the time this ran). To keep the " +
    "before/after comparison honest, the distribution and reconciliation sections below use ONLY " +
    `wallets NOT yet touched by the scheduler (confidence_tier IS NULL at query time: ${untouched.length} ` +
    `of ${results.length} scored wallets). The remaining ${touched.length} are folded into the Top-50 ` +
    "audit and tier distribution only, since their stored score already IS the v7 value.",
  );
  lines.push("");
  lines.push("## 1. Score distribution comparison (untouched wallets only — true before/after)");
  lines.push("");
  lines.push("| Score bucket | Before (stored, pre-v7) | After (fresh v7) |");
  lines.push("|---|---|---|");
  for (const b of buckets) lines.push(`| ${b} | ${beforeDist[b]} | ${afterDist[b]} |`);
  lines.push("");
  lines.push("## 2. Reconciliation (untouched wallets only)");
  lines.push("");
  lines.push(`- Classification changed old→new: ${classificationChanged} / ${untouched.length}`);
  lines.push(`- Wallets that would DROP below the 0.30 leaderboard floor under v7: ${droppedBelowFloor.length}`);
  lines.push(`- Wallets that would RISE above the 0.30 leaderboard floor under v7: ${roseAboveFloor.length}`);
  lines.push("");
  if (droppedBelowFloor.length > 0) {
    lines.push("Wallets dropping below floor (first 15):");
    lines.push("");
    lines.push("| Wallet | Before | After | Classification |");
    lines.push("|---|---|---|---|");
    for (const r of droppedBelowFloor.slice(0, 15)) {
      lines.push(`| \`${r.wallet.slice(0, 8)}…\` | ${r.dbScore?.toFixed(2)} | ${r.newScore.toFixed(2)} | ${r.newClassification} |`);
    }
    lines.push("");
  }
  lines.push("## 3. Confidence tier distribution (full sample, fresh v7 computation)");
  lines.push("");
  lines.push("| Tier | Count |");
  lines.push("|---|---|");
  for (const tier of ["elite", "high", "medium", "low", "unrated"]) {
    lines.push(`| ${tier} | ${tierCounts[tier] ?? 0} |`);
  }
  lines.push("");
  lines.push("## 4. Top-50 by fresh v7 score — manual audit");
  lines.push("");
  lines.push("| # | Wallet | Buys | Sells | Closed | Win Rate | Avg ROI | Score | Tier | Evidence | Classification |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  top50.forEach((r, i) => {
    lines.push(
      `| ${i + 1} | \`${r.wallet.slice(0, 8)}…\` | ${r.totalBuys} | ${r.totalSells} | ` +
      `${r.newClosedPositionCount} | ${r.newWinRate != null ? (r.newWinRate * 100).toFixed(0) + "%" : "—"} | ` +
      `${r.newAverageRoi != null ? r.newAverageRoi.toFixed(1) + "x" : "—"} | ${r.newScore.toFixed(2)} | ` +
      `${r.newConfidenceTier} | ${r.newEvidenceQuality} | ${r.newClassification} |`,
    );
  });
  lines.push("");
  lines.push("## 5. Sanity flags");
  lines.push("");
  const top50SingleTrade = top50.filter((r) => r.totalBuys <= 1);
  const top50NoClosedPositions = top50.filter((r) => r.newClosedPositionCount === 0);
  lines.push(`- Top-50 wallets with ≤1 total buy: ${top50SingleTrade.length}`);
  lines.push(`- Top-50 wallets with 0 closed positions: ${top50NoClosedPositions.length}`);
  lines.push(`- Top-50 wallets tiered "elite" or "high": ${top50.filter((r) => r.newConfidenceTier === "elite" || r.newConfidenceTier === "high").length}`);
  lines.push(`- Top-50 wallets tiered "unrated" (should be near-impossible if the floor/gate is working — unrated means closedPositionCount<=0): ${top50.filter((r) => r.newConfidenceTier === "unrated").length}`);
  lines.push("");

  const reportPath = `exports/validation-report-v7-${startedAt.toISOString().replace(/[:.]/g, "-")}.md`;
  writeFileSync(reportPath, lines.join("\n"));

  console.log(`Report written to ${reportPath}`);
  console.log("=== DONE ===");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
