// =============================================================================
// fix-classification-promotion.ts
//
// One-time classification promotion backfill — July 2026 audit.
//
// ROOT CAUSE FIXED:
//   wallet_classification was never promoted beyond 'unknown' after enrichment.
//   The enricher wrote scores but left classification as-is, so 13k+ wallets
//   stayed 'unknown' even after scoring, and no wallets were ever promoted to
//   smart_money or sniper.
//
// PROMOTION RULES (applied to scored wallets only):
//   unknown  →  retail        if intelligence_score IS NOT NULL
//   retail   →  smart_money   if score ≥ 0.80 AND win_rate ≥ 0.65 AND closed ≥ 5
//   retail   →  sniper        if score ≥ 0.75 AND win_rate ≥ 0.80 AND total_buys ≥ 10
//                               AND average_roi ≥ 5.0 AND closed ≥ 3
//   *        →  whale         if realized_pnl ≥ 100 SOL AND closed ≥ 5 (overrides)
//
// Deduplication is enforced: each wallet gets the highest applicable tier.
// SAFE TO RE-RUN: upserts are idempotent per wallet_address.
//
// Usage: bun scripts/fix-classification-promotion.ts
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "fs";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const PAGE  = 1_000;
const BATCH = 200;

const SMART_MONEY_SCORE      = 0.80;
const SMART_MONEY_WIN_RATE   = 0.65;
const SMART_MONEY_MIN_CLOSED = 5;

const SNIPER_SCORE      = 0.75;
const SNIPER_WIN_RATE   = 0.80;
const SNIPER_MIN_BUYS   = 10;
const SNIPER_MIN_ROI    = 5.0;
const SNIPER_MIN_CLOSED = 3;

const WHALE_MIN_PNL    = 100;   // SOL
const WHALE_MIN_CLOSED = 5;

type WalletRow = {
  wallet_address:        string;
  wallet_classification: string | null;
  intelligence_score:    number | null;
  win_rate:              number | null;
  average_roi:           number | null;
  total_buys:            number | null;
  realized_pnl:          number | null;
  closed_position_count: number | null;
};

async function main() {
  const startedAt = new Date();
  mkdirSync("exports", { recursive: true });

  console.log("=== fix-classification-promotion.ts — WRITES to wallets.wallet_classification ===");
  console.log(`Started: ${startedAt.toISOString()}`);

  // ── Load all scored wallets ───────────────────────────────────────────────
  console.log("Loading scored wallets…");
  const wallets: WalletRow[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from("wallets")
      .select(
        "wallet_address, wallet_classification, intelligence_score, " +
        "win_rate, average_roi, total_buys, realized_pnl, closed_position_count",
      )
      .not("intelligence_score", "is", null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`wallets: ${error.message}`);
    if (!data?.length) break;
    wallets.push(...(data as WalletRow[]));
    if (data.length < PAGE) break;
    from += PAGE;
    process.stdout.write(`\r  loaded ${wallets.length}…`);
  }
  console.log(`\n  ${wallets.length} scored wallets to evaluate.`);

  // ── Build promotion list ──────────────────────────────────────────────────
  const updatesMap = new Map<string, { wallet_address: string; wallet_classification: string }>();

  let toRetail     = 0;
  let toSmartMoney = 0;
  let toSniper     = 0;
  let toWhale      = 0;

  for (const w of wallets) {
    const score   = Number(w.intelligence_score ?? 0);
    const wr      = Number(w.win_rate           ?? 0);
    const roi     = Number(w.average_roi        ?? 0);
    const buys    = Number(w.total_buys         ?? 0);
    const pnl     = Number(w.realized_pnl       ?? 0);
    const closed  = Number(w.closed_position_count ?? 0);
    const current = w.wallet_classification ?? "unknown";

    let target: string | null = null;

    // Whale override (highest priority)
    if (pnl >= WHALE_MIN_PNL && closed >= WHALE_MIN_CLOSED) {
      if (current !== "whale") { target = "whale"; toWhale++; }
    }
    // Smart money
    else if (score >= SMART_MONEY_SCORE && wr >= SMART_MONEY_WIN_RATE && closed >= SMART_MONEY_MIN_CLOSED) {
      if (current !== "smart_money") { target = "smart_money"; toSmartMoney++; }
    }
    // Sniper
    else if (
      score >= SNIPER_SCORE && wr >= SNIPER_WIN_RATE &&
      buys >= SNIPER_MIN_BUYS && roi >= SNIPER_MIN_ROI && closed >= SNIPER_MIN_CLOSED
    ) {
      if (current !== "sniper") { target = "sniper"; toSniper++; }
    }
    // Unknown → retail (has a score, not yet classified)
    else if (current === "unknown") {
      target = "retail"; toRetail++;
    }

    if (target) {
      updatesMap.set(w.wallet_address, {
        wallet_address:        w.wallet_address,
        wallet_classification: target,
      });
    }
  }

  console.log(`  Promotions: retail=${toRetail} smart_money=${toSmartMoney} sniper=${toSniper} whale=${toWhale}`);
  console.log(`  Total rows to update (deduped): ${updatesMap.size}`);

  if (updatesMap.size === 0) {
    console.log("  Nothing to update.");
    return;
  }

  // ── Write in batches ──────────────────────────────────────────────────────
  const deduped = [...updatesMap.values()];
  let written = 0;
  let errors  = 0;

  for (let i = 0; i < deduped.length; i += BATCH) {
    const slice = deduped.slice(i, i + BATCH);
    const { error } = await sb
      .from("wallets")
      .upsert(slice, { onConflict: "wallet_address" });
    if (error) {
      console.error(`  ✗ batch ${i}: ${error.message}`);
      errors++;
    } else {
      written += slice.length;
    }
  }

  console.log(`  Written ${written}/${deduped.length} classification updates. Errors: ${errors}.`);

  const finishedAt = new Date();
  const summary = {
    startedAt:    startedAt.toISOString(),
    finishedAt:   finishedAt.toISOString(),
    durationMs:   finishedAt.getTime() - startedAt.getTime(),
    walletsEvaluated: wallets.length,
    promotions: { retail: toRetail, smart_money: toSmartMoney, sniper: toSniper, whale: toWhale },
    walletsUpdated: written,
    writeErrors:  errors,
  };

  writeFileSync(
    `exports/fix-classification-promotion-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`,
    JSON.stringify(summary, null, 2),
  );

  console.log("=== DONE ===");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
