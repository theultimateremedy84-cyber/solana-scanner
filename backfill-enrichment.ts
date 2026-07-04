#!/usr/bin/env bun
// =============================================================================
// backfill-enrichment.ts
//
// One-off catch-up job for the wallet enrichment backlog.
//
// WHY THIS EXISTS
// ─────────────────
// The steady-state scheduler (enrich-unenriched-scheduler.ts) only processes
// TOKENS_PER_RUN (10) tokens × WALLETS_PER_TOKEN (20) wallets every 30 minutes
// — enough to keep up with new discoveries, but far too slow to clear an
// existing backlog of hundreds of hollow wallets in a reasonable time.
//
// This script reuses the EXACT SAME production functions the scheduler uses
// (enrichWalletsForToken, classifyWallets, findHollowPairs) so results are
// byte-for-byte consistent with what the live pipeline would have produced —
// it just runs against the WHOLE backlog in one pass instead of a 10-token
// slice, with no artificial per-tick cap.
//
// SAFETY
//   • Read-only discovery (findHollowPairs) + additive-only writes — never
//     touches discovery/scoring/PostLaunchWatcher code paths.
//   • Fully idempotent: safe to re-run or resume after an interruption —
//     findHollowPairs recomputes the remaining backlog from the DB each run,
//     so already-enriched pairs are automatically skipped.
//   • Respects the SAME shared Helius budget guard (globalThis counters) used
//     by every other enrichment path — if HELIUS_DAILY_BUDGET /
//     HELIUS_HOURLY_BUDGET are set, this script will throttle/stop exactly
//     like the live scheduler does, it just won't wait for the next tick.
//
// USAGE
//   bun run backfill-enrichment.ts
//
// Optional env vars (same names the app already uses):
//   HELIUS_DAILY_BUDGET, HELIUS_HOURLY_BUDGET   — Helius CU caps
//   BACKFILL_TOKEN_LIMIT                        — cap how many tokens to
//                                                  process this run (default:
//                                                  no cap — process all)
//   BACKFILL_INTER_TOKEN_DELAY_MS               — pause between tokens
//                                                  (default 2000ms, gives the
//                                                  Helius budget window room
//                                                  to breathe between tokens)
// =============================================================================

import { supabaseAdmin } from "./src/integrations/supabase/client.server";
import { findHollowPairs } from "./src/lib/api/enrich-unenriched-scheduler";
import { enrichWalletsForToken, classifyWallets } from "./src/lib/api/wallet-enricher";
import { fetchTokenPrice } from "./src/lib/api/wallet-collection-worker";

const LOG = "[BackfillEnrichment]";

const TOKEN_LIMIT = process.env.BACKFILL_TOKEN_LIMIT
  ? parseInt(process.env.BACKFILL_TOKEN_LIMIT, 10)
  : Infinity;
const INTER_TOKEN_DELAY_MS = parseInt(process.env.BACKFILL_INTER_TOKEN_DELAY_MS ?? "2000", 10);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function countBacklog(): Promise<{ winRateNull: number; positionUnknown: number }> {
  const [{ count: winRateNull }, { count: positionUnknown }] = await Promise.all([
    supabaseAdmin.from("wallets").select("id", { count: "exact", head: true }).is("win_rate", null),
    supabaseAdmin
      .from("wallet_performance_history")
      .select("id", { count: "exact", head: true })
      .eq("position_status", "UNKNOWN"),
  ]);
  return { winRateNull: winRateNull ?? 0, positionUnknown: positionUnknown ?? 0 };
}

async function main() {
  const startTime = Date.now();
  console.log(`${LOG} ═══════════════════════════════════════════════════`);
  console.log(`${LOG}   Solana Scanner — Enrichment Backlog Catch-up`);
  console.log(`${LOG} ═══════════════════════════════════════════════════`);

  const before = await countBacklog();
  console.log(
    `${LOG} Before: win_rate NULL=${before.winRateNull}, ` +
    `position_status UNKNOWN=${before.positionUnknown}`,
  );

  console.log(`${LOG} Scanning for hollow wallet × token pairs...`);
  const errors: string[] = [];
  const tokenMap = await findHollowPairs(supabaseAdmin, errors);
  if (errors.length) {
    console.warn(`${LOG} findHollowPairs reported ${errors.length} error(s):`, errors);
  }

  const allTokens = Array.from(tokenMap.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, TOKEN_LIMIT);

  const totalHollow = allTokens.reduce((s, [, w]) => s + w.length, 0);
  console.log(
    `${LOG} ${totalHollow} hollow wallets across ${allTokens.length} tokens ` +
    `(of ${tokenMap.size} total tokens with backlog)`,
  );

  if (allTokens.length === 0) {
    console.log(`${LOG} Nothing to do — backlog is already clear.`);
    return;
  }

  let totalEnriched = 0;
  let totalSkipped  = 0;
  let totalTrades   = 0;
  let totalErrors   = 0;
  const allWalletsSeen = new Set<string>();
  for (const [, w] of allTokens) w.forEach((addr) => allWalletsSeen.add(addr));

  for (let i = 0; i < allTokens.length; i++) {
    const [tokenAddress, wallets] = allTokens[i]!;

    const priceData = await fetchTokenPrice(tokenAddress);

    console.log(
      `${LOG} [${i + 1}/${allTokens.length}] ${tokenAddress.slice(0, 10)}… ` +
      `— enriching ${wallets.length} wallets`,
    );

    try {
      const result = await enrichWalletsForToken({
        tokenAddress,
        walletAddresses: wallets,
        priceData,
        maxWallets: wallets.length,
      });

      totalEnriched += result.walletsEnriched;
      totalSkipped  += result.walletsSkipped;
      totalTrades   += result.tradesInserted;
      totalErrors   += result.errors.length;

      if (result.errors.length) {
        console.warn(`${LOG}   ${result.errors.length} error(s):`, result.errors.slice(0, 3));
      }
    } catch (err) {
      totalErrors++;
      console.error(
        `${LOG}   ✗ token ${tokenAddress.slice(0, 10)}… threw: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Progress checkpoint every 10 tokens
    if ((i + 1) % 10 === 0 || i === allTokens.length - 1) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(
        `${LOG} ── progress: ${i + 1}/${allTokens.length} tokens | ` +
        `enriched=${totalEnriched} skipped=${totalSkipped} trades=${totalTrades} ` +
        `errors=${totalErrors} | ${elapsed}s elapsed`,
      );
    }

    if (i < allTokens.length - 1 && INTER_TOKEN_DELAY_MS > 0) {
      await sleep(INTER_TOKEN_DELAY_MS);
    }
  }

  // ── Rescore classification (win_rate / average_roi / intelligence_score) ──
  console.log(`${LOG} Reclassifying ${allWalletsSeen.size} touched wallets...`);
  const classifiedCount = await classifyWallets(
    supabaseAdmin,
    Array.from(allWalletsSeen),
    "",
    errors,
  );
  console.log(`${LOG} Classified ${classifiedCount} wallets`);

  const after = await countBacklog();
  const durationMin = ((Date.now() - startTime) / 60_000).toFixed(1);

  console.log(`${LOG} ═══════════════════ DONE ═══════════════════`);
  console.log(`${LOG}   Tokens processed   : ${allTokens.length}`);
  console.log(`${LOG}   Wallets enriched   : ${totalEnriched}`);
  console.log(`${LOG}   Wallets skipped    : ${totalSkipped} (no tx evidence — existing data preserved)`);
  console.log(`${LOG}   Trades inserted    : ${totalTrades}`);
  console.log(`${LOG}   Errors             : ${totalErrors}`);
  console.log(`${LOG}   Duration           : ${durationMin} min`);
  console.log(`${LOG} ── Backlog ──`);
  console.log(`${LOG}   win_rate NULL      : ${before.winRateNull} → ${after.winRateNull}`);
  console.log(`${LOG}   position UNKNOWN   : ${before.positionUnknown} → ${after.positionUnknown}`);
  console.log(`${LOG} ═════════════════════════════════════════════`);

  if (after.winRateNull > 0 || after.positionUnknown > 0) {
    console.log(
      `${LOG} Backlog not fully cleared — likely Helius budget/rate limits were hit. ` +
      `Safe to re-run this script again (it will pick up where it left off).`,
    );
  }
}

main().catch((err) => {
  console.error(`${LOG} FATAL:`, err);
  process.exit(1);
});
