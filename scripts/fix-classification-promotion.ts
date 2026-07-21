// =============================================================================
// fix-classification-promotion.ts
//
// Idempotent classification sync — promotes AND demotes wallets based on
// current scores. Run after every rescore.
//
// TIER RULES (evaluated in priority order, highest wins):
//   whale       : realized_pnl ≥ 100 SOL  AND  closed ≥ 5   (overrides all)
//   smart_money : score ≥ 0.80  AND  win_rate ≥ 0.65  AND  closed ≥ 5
//   sniper      : score ≥ 0.75  AND  win_rate ≥ 0.80  AND  buys ≥ 10
//                 AND  avg_roi ≥ 5.0  AND  closed ≥ 3
//   retail      : has a score but doesn't meet any premium tier
//   (unknown stays unknown — no score yet)
//
// DEMOTION: wallets that no longer meet their current tier's criteria are
// moved DOWN to the correct tier. This prevents stale promotions from a
// previous looser scoring pass persisting forever.
//
// SAFE TO RE-RUN: idempotent — only writes when classification needs to change.
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

  // Counters — positive = promotion, negative direction = demotion
  let toRetail     = 0;  // includes demotions from premium tiers → retail
  let toSmartMoney = 0;
  let toSniper     = 0;
  let toWhale      = 0;
  let demotions    = 0;  // wallets moving DOWN a tier (stale classifications)
  let unchanged    = 0;  // already correct

  const PREMIUM_TIERS = new Set(["whale", "smart_money", "sniper"]);

  for (const w of wallets) {
    // All wallets in this set have a non-null intelligence_score.
    const score   = w.intelligence_score != null ? Number(w.intelligence_score) : null;
    const wr      = Number(w.win_rate           ?? 0);
    const roi     = Number(w.average_roi        ?? 0);
    const buys    = Number(w.total_buys         ?? 0);
    const pnl     = Number(w.realized_pnl       ?? 0);
    const closed  = Number(w.closed_position_count ?? 0);
    const current = w.wallet_classification ?? "unknown";

    // ── Determine the CORRECT tier unconditionally ──────────────────────────
    // Evaluated in priority order; highest match wins.
    let target: string;

    if (pnl >= WHALE_MIN_PNL && closed >= WHALE_MIN_CLOSED) {
      // PnL + position count override — whale regardless of score
      target = "whale";
    } else if (
      score != null &&
      score >= SMART_MONEY_SCORE &&
      wr    >= SMART_MONEY_WIN_RATE &&
      closed >= SMART_MONEY_MIN_CLOSED
    ) {
      target = "smart_money";
    } else if (
      score != null &&
      score >= SNIPER_SCORE &&
      wr    >= SNIPER_WIN_RATE &&
      buys  >= SNIPER_MIN_BUYS &&
      roi   >= SNIPER_MIN_ROI &&
      closed >= SNIPER_MIN_CLOSED
    ) {
      target = "sniper";
    } else {
      // Has a score but doesn't meet any premium criteria → retail
      // (This includes demoting previously-promoted wallets that no longer qualify)
      target = "retail";
    }

    // ── Only write if classification needs to change ─────────────────────────
    if (target === current) {
      unchanged++;
      continue;
    }

    // Classify the direction of the change
    const isPromotion = !PREMIUM_TIERS.has(current) && PREMIUM_TIERS.has(target);
    const isDemotion  =  PREMIUM_TIERS.has(current) && !PREMIUM_TIERS.has(target);
    const isSidegrade = !isPromotion && !isDemotion; // e.g. whale → smart_money

    if (isDemotion) demotions++;

    switch (target) {
      case "retail":     toRetail++;     break;
      case "smart_money": toSmartMoney++; break;
      case "sniper":     toSniper++;     break;
      case "whale":      toWhale++;      break;
    }

    updatesMap.set(w.wallet_address, {
      wallet_address:        w.wallet_address,
      wallet_classification: target,
    });
  }

  console.log(`  Changes needed:`);
  console.log(`    → retail     : ${toRetail} (includes ${demotions} demotion(s) from premium tiers)`);
  console.log(`    → smart_money: ${toSmartMoney}`);
  console.log(`    → sniper     : ${toSniper}`);
  console.log(`    → whale      : ${toWhale}`);
  console.log(`    unchanged    : ${unchanged}`);
  console.log(`  Total rows to update (deduped): ${updatesMap.size}`);

  if (updatesMap.size === 0) {
    console.log("  ✅ All classifications are already correct.");
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
    process.stdout.write(`\r  Written ${written}/${deduped.length}…`);
  }
  console.log("");

  console.log(`  Written ${written}/${deduped.length} classification updates. Errors: ${errors}.`);

  const finishedAt = new Date();
  const summary = {
    startedAt:    startedAt.toISOString(),
    finishedAt:   finishedAt.toISOString(),
    durationMs:   finishedAt.getTime() - startedAt.getTime(),
    walletsEvaluated: wallets.length,
    changes: {
      retail:      toRetail,
      smart_money: toSmartMoney,
      sniper:      toSniper,
      whale:       toWhale,
      demotions,
      unchanged,
    },
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
