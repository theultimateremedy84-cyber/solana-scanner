// =============================================================================
// audit-rescore-v2.ts
//
// Corrected production rescore — July 2026 audit.
//
// Raises the minimum evidence gate from ≥1 real exit to ≥3 real closed exits
// before assigning any intelligence_score. Wallets below the gate are null-ed
// out rather than left with a misleadingly low score.
//
// WHAT THIS CHANGES vs. the default rescore-scheduler:
//   1. Gate: requires ≥3 positions with position_status='CLOSED' AND
//            total_sol_received > 0  (real exits, not rug closures).
//   2. Unrated-tier wallets → force intelligence_score = null (they have
//      evidence but 0 closed positions — scoring them is noise).
//   3. Null-scores any wallet whose confidence_tier is 'unrated' after scoring.
//
// SAFE TO RE-RUN: idempotent per wallet. Does not call any external APIs.
//
// Usage:
//   bun scripts/audit-rescore-v2.ts
//   bun scripts/audit-rescore-v2.ts <startOffset> <endOffset>   # window resume
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import { classifyWallet, computeConfidenceTier } from "../src/lib/api/wallet-classifier";
import { guardRoiMultiple } from "../src/lib/api/tx-reconstructor";
import { writeFileSync, mkdirSync } from "fs";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

// ── Audit gate ────────────────────────────────────────────────────────────────
/** Minimum real closed exits required for any score to be assigned. */
const MIN_REAL_EXITS = 3;

const SUPER_BATCH = 3_000;
const SUB_BATCH   = 200;
const CHUNK       = 500;

type Row = Record<string, unknown>;

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

// ── Wallet collection ─────────────────────────────────────────────────────────

async function collectAllAddresses(): Promise<string[]> {
  const seen = new Set<string>();
  for (const table of ["wallet_raw_tx_metrics", "wallets"] as const) {
    let page = 0;
    while (true) {
      const { data, error } = await sb
        .from(table)
        .select("wallet_address")
        .range(page * 1000, (page + 1) * 1000 - 1);
      if (error) { console.warn(`${table} page ${page}: ${error.message}`); break; }
      if (!data?.length) break;
      for (const r of data) seen.add(r.wallet_address as string);
      if (data.length < 1000) break;
      page++;
    }
  }
  return Array.from(seen);
}

// ── Position building (mirrors classifyWallets in wallet-enricher.ts) ─────────

async function loadPositions(wallets: string[]): Promise<Map<string, Row[]>> {
  const byWallet = new Map<string, Row[]>();

  for (let i = 0; i < wallets.length; i += CHUNK) {
    const slice = wallets.slice(i, i + CHUNK);

    const { data: rawRows } = await sb
      .from("wallet_raw_tx_metrics")
      .select(
        "wallet_address, token_address, data_source, " +
        "total_buy_txs, total_sell_txs, total_tokens_bought, total_tokens_sold, " +
        "total_sol_invested, total_sol_received, current_token_balance",
      )
      .in("wallet_address", slice)
      .eq("has_evidence", true);

    const rawByWallet = new Map<string, Row[]>();
    for (const r of rawRows ?? []) {
      const k = r.wallet_address as string;
      if (!rawByWallet.has(k)) rawByWallet.set(k, []);
      rawByWallet.get(k)!.push(r as Row);
    }

    const missing = slice.filter((a) => !rawByWallet.has(a));
    if (missing.length > 0) {
      const { data: fallback } = await sb
        .from("wallet_performance_history")
        .select(
          "wallet_address, token_address, position_status, " +
          "initial_investment, current_value, roi_multiple, " +
          "total_tokens_bought, total_tokens_sold",
        )
        .in("wallet_address", missing);
      for (const r of fallback ?? []) {
        const k = r.wallet_address as string;
        if (!byWallet.has(k)) byWallet.set(k, []);
        (byWallet.get(k)!).push({ ...(r as Row), _usingRaw: false });
      }
    }

    for (const [addr, rows] of rawByWallet) {
      byWallet.set(addr, rows.map((r) => ({ ...r, _usingRaw: true })));
    }
  }

  return byWallet;
}

function buildPositions(addr: string, rows: Row[]) {
  return rows.map((r) => {
    const usingRaw = r._usingRaw as boolean;
    const tokensBought = Number(r.total_tokens_bought ?? 0);
    const tokensSold   = Number(r.total_tokens_sold ?? 0);
    const invested     = Number(usingRaw ? r.total_sol_invested  : r.initial_investment) || 0;
    const received     = Number(usingRaw ? r.total_sol_received  : r.current_value)      || 0;
    const totalBuyTxs  = Number(usingRaw ? r.total_buy_txs       : tokensBought)         || 0;
    const balance      = Math.max(0, tokensBought - tokensSold);

    let posStatus: "OPEN" | "PARTIALLY_CLOSED" | "CLOSED" | "UNKNOWN";
    if (usingRaw) {
      if ((r.data_source as string) === "holder_scan" && invested === 0) posStatus = "UNKNOWN";
      else if (tokensBought === 0 && tokensSold > 0)                     posStatus = "CLOSED";
      else if (tokensBought > 0 && balance <= tokensBought * 0.001)      posStatus = "CLOSED";
      else if (tokensSold === 0)                                          posStatus = "OPEN";
      else if (tokensBought > 0 && tokensSold >= tokensBought * 0.95)    posStatus = "CLOSED";
      else                                                                posStatus = "PARTIALLY_CLOSED";
    } else {
      posStatus = (r.position_status as typeof posStatus) ?? "UNKNOWN";
    }

    const hasEv = posStatus !== "UNKNOWN" || totalBuyTxs > 0 || tokensBought > 0;
    let roiMultiple: number | null = null;
    if (posStatus === "CLOSED" && invested > 0) {
      roiMultiple = guardRoiMultiple(received / invested, invested);
    }
    let realizedProfit = 0;
    if (posStatus === "CLOSED" && invested > 0) {
      realizedProfit = received - invested;
    } else if (posStatus === "PARTIALLY_CLOSED" && tokensBought > 0 && invested > 0) {
      realizedProfit = received - invested * (tokensSold / tokensBought);
    }

    return {
      walletAddress: addr,
      tokenAddress:  r.token_address as string,
      trades: [],
      totalTokensBought: tokensBought,
      totalTokensSold:   tokensSold,
      initialInvestment: invested,
      totalSolReceived:  received,
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
      hasTransactionEvidence: hasEv,
    };
  });
}

// ── Per-wallet scoring with audit gate ────────────────────────────────────────

function scoreWithGate(addr: string, rows: Row[]): {
  update: Record<string, unknown>;
  gated: boolean;
} {
  const usingRaw = rows[0]?._usingRaw as boolean ?? false;
  const positions = buildPositions(addr, rows);

  // Audit gate: count real closed exits (CLOSED + SOL actually received)
  const realClosedExits = positions.filter(
    (p) => p.positionStatus === "CLOSED" && p.totalSolReceived > 0,
  ).length;

  if (realClosedExits < MIN_REAL_EXITS) {
    // Below gate — null the score
    return {
      gated: true,
      update: {
        wallet_address:        addr,
        intelligence_score:    null,
        win_rate:              null,
        average_roi:           null,
        conviction_score:      null,
        confidence_tier:       "unrated",
        closed_position_count: realClosedExits,
        total_tokens_traded:   rows.length,
        total_buys:            0,
        total_sells:           0,
        score_computed_at:     new Date().toISOString(),
      },
    };
  }

  const totalBuys = usingRaw
    ? rows.reduce((s, r) => s + Number(r.total_buy_txs ?? 0), 0)
    : rows.length;
  const totalSells = usingRaw
    ? rows.reduce((s, r) => s + Number(r.total_sell_txs ?? 0), 0)
    : rows.length;
  const totalVolBought = rows.reduce((s, r) =>
    s + Number(usingRaw ? r.total_sol_invested : r.initial_investment), 0);
  const totalVolSold = rows.reduce((s, r) =>
    s + Number(usingRaw ? r.total_sol_received : r.current_value), 0);

  const scores = classifyWallet({
    positions,
    totalBuys,
    totalSells,
    totalVolumeBoughtSol: totalVolBought,
    totalVolumeSoldSol:   totalVolSold,
  });

  // ── Win-rate fallback ─────────────────────────────────────────────────────
  // BUG FIX: classifyWallet() returns winRate = null for raw-evidence wallets.
  // Compute it directly from positions so every wallet that passes the
  // MIN_REAL_EXITS gate always gets a non-null win_rate written to the DB.
  // This is the root cause of the 13k+ null win_rate rows that blocked all
  // smart_money and sniper promotion.
  const closedWithSOL = positions.filter(
    (p) => p.positionStatus === "CLOSED" && p.totalSolReceived > 0,
  );
  const profitablePositions = closedWithSOL.filter(
    (p) => p.totalSolReceived > p.initialInvestment,
  );
  const computedWinRate =
    closedWithSOL.length > 0
      ? profitablePositions.length / closedWithSOL.length
      : null;
  // Prefer classifier value (may be more precise); fall back to direct computation.
  const resolvedWinRate = scores.winRate ?? computedWinRate;

  const evidenceQuality = usingRaw ? "raw" : "fallback";
  const confidenceTier  = computeConfidenceTier({
    evidenceQuality,
    closedPositionCount: scores.closedPositionCount,
  });

  // Force null if unrated even when above gate (edge case guard)
  const finalScore = confidenceTier === "unrated" ? null : scores.intelligenceScore / 100;

  return {
    gated: false,
    update: {
      wallet_address:        addr,
      intelligence_score:    finalScore,
      win_rate:              resolvedWinRate,
      average_roi:           scores.averageRoi,
      conviction_score:      scores.convictionScore,
      closed_position_count: scores.closedPositionCount,
      total_buys:            totalBuys,
      total_sells:           totalSells,
      total_tokens_traded:   rows.length,
      evidence_quality:      evidenceQuality,
      confidence_tier:       confidenceTier,
      score_computed_at:     new Date().toISOString(),
    },
  };
}

// ── Upsert batch ──────────────────────────────────────────────────────────────

async function upsertBatch(updates: Record<string, unknown>[]): Promise<number> {
  const { error } = await sb
    .from("wallets")
    .upsert(updates, { onConflict: "wallet_address" });
  if (error) throw new Error(`upsert failed: ${error.message}`);
  return updates.length;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const startedAt = new Date();
  mkdirSync("exports", { recursive: true });

  const startOffset  = process.argv[2] ? Number(process.argv[2]) : 0;
  const endOffsetArg = process.argv[3] ? Number(process.argv[3]) : undefined;

  console.log("=== AUDIT RESCORE v2 — gate: ≥3 real closed exits — WRITES to wallets ===");
  console.log(`Started: ${startedAt.toISOString()}`);

  console.log("Collecting wallet addresses…");
  const allAddressesFull = await collectAllAddresses();
  const endOffset  = endOffsetArg ?? allAddressesFull.length;
  const addresses  = allAddressesFull.slice(startOffset, endOffset);
  console.log(
    `${allAddressesFull.length} total wallets — processing [${startOffset}, ${endOffset}) = ${addresses.length}`,
  );

  let totalProcessed = 0;
  let totalGated     = 0;
  let totalScored    = 0;
  let superBatchNum  = 0;
  const errors: string[] = [];

  for (let offset = 0; offset < addresses.length; offset += SUPER_BATCH) {
    superBatchNum++;
    const superBatch = addresses.slice(offset, offset + SUPER_BATCH);

    // Load positions for this super-batch
    const byWallet = await loadPositions(superBatch);

    // Score each wallet with the audit gate
    const updates: Record<string, unknown>[] = [];
    for (const addr of superBatch) {
      const rows = byWallet.get(addr);
      if (!rows?.length) {
        // No evidence — force null
        updates.push({
          wallet_address:      addr,
          intelligence_score:  null,
          confidence_tier:     "unrated",
          total_tokens_traded: 0,
          total_buys:          0,
          total_sells:         0,
          score_computed_at:   new Date().toISOString(),
        });
        totalGated++;
        continue;
      }
      const { update, gated } = scoreWithGate(addr, rows);
      updates.push(update);
      if (gated) totalGated++; else totalScored++;
    }

    // Dedup by wallet_address (safety) then upsert in sub-batches
    const dedupMap = new Map<string, Record<string, unknown>>();
    for (const u of updates) dedupMap.set(u.wallet_address as string, u);
    const deduped = [...dedupMap.values()];

    for (let i = 0; i < deduped.length; i += SUB_BATCH) {
      const slice = deduped.slice(i, i + SUB_BATCH);
      try {
        await upsertBatch(slice);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`super-batch ${superBatchNum} sub-batch ${i}: ${msg}`);
        console.error(`  ✗ ${msg}`);
      }
    }

    totalProcessed += superBatch.length;
    console.log(
      `Super-batch ${superBatchNum}: processed=${superBatch.length} ` +
      `scored=${totalScored} gated=${totalGated} ` +
      `(${totalProcessed}/${addresses.length} done) errors=${errors.length}`,
    );
    await sleep(200);
  }

  const finishedAt = new Date();
  const summary = {
    startedAt:  startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    totalProcessed,
    totalScored,
    totalGated,
    minRealExitsGate: MIN_REAL_EXITS,
    errors: errors.slice(0, 50),
  };

  const summaryPath = `exports/audit-rescore-v2-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  console.log("=== DONE ===");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
