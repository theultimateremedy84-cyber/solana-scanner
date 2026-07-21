// =============================================================================
// fix-null-winrate.ts
//
// Targeted one-shot: compute win_rate for every wallet that has a non-null
// intelligence_score but null win_rate.
//
// Root cause: classifyWallet() never returned winRate for raw-evidence wallets.
// The batch rescore (audit-rescore-v2.ts) and the live classifyWallets() in
// wallet-enricher.ts both had this bug. The enricher source is now fixed;
// this script repairs the rows that were written before the fix.
//
// SAFE TO RE-RUN: only touches rows where win_rate IS NULL AND
// intelligence_score IS NOT NULL. Leaves all other rows untouched.
//
// Usage: bun scripts/fix-null-winrate.ts
// =============================================================================

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const PAGE       = 1_000;
const CHUNK      = 500;   // wallet_raw_tx_metrics .in() chunk
const UPSERT_SZ  = 200;

type WalletRow = {
  wallet_address:     string;
  intelligence_score: number;
};

async function main() {
  console.log("=== fix-null-winrate.ts — compute win_rate for scored wallets ===");
  const startedAt = new Date();

  // ── 1. Collect wallets that need fixing ─────────────────────────────────
  const wallets: WalletRow[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from("wallets")
      .select("wallet_address, intelligence_score")
      .not("intelligence_score", "is", null)
      .is("win_rate", null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`load wallets: ${error.message}`);
    if (!data?.length) break;
    wallets.push(...(data as WalletRow[]));
    if (data.length < PAGE) break;
    from += PAGE;
    process.stdout.write(`\r  Loading… ${wallets.length}`);
  }
  console.log(`\n  Found ${wallets.length} wallets with null win_rate + non-null score`);

  if (wallets.length === 0) {
    console.log("  ✅ Nothing to fix.");
    return;
  }

  const addresses = wallets.map((w) => w.wallet_address);

  // ── 2. Load positions from wallet_raw_tx_metrics (primary) ──────────────
  type RawRow = {
    wallet_address:    string;
    total_sol_invested: number;
    total_sol_received: number;
    total_tokens_bought: number;
    total_tokens_sold:   number;
    data_source:         string;
    current_token_balance: number;
  };

  const rawByWallet = new Map<string, RawRow[]>();
  for (let i = 0; i < addresses.length; i += CHUNK) {
    const slice = addresses.slice(i, i + CHUNK);
    const { data } = await sb
      .from("wallet_raw_tx_metrics")
      .select(
        "wallet_address, total_sol_invested, total_sol_received, " +
        "total_tokens_bought, total_tokens_sold, data_source, current_token_balance",
      )
      .in("wallet_address", slice)
      .eq("has_evidence", true);
    for (const r of data ?? []) {
      const k = r.wallet_address as string;
      if (!rawByWallet.has(k)) rawByWallet.set(k, []);
      rawByWallet.get(k)!.push(r as RawRow);
    }
    process.stdout.write(`\r  Loading positions… ${i + slice.length}/${addresses.length}`);
  }
  console.log(`\n  Position data loaded for ${rawByWallet.size} wallets from raw metrics`);

  // ── 3. Fallback: wallet_performance_history for wallets not in raw ───────
  const missing = addresses.filter((a) => !rawByWallet.has(a));
  type PerfRow = {
    wallet_address:    string;
    position_status:   string;
    initial_investment: number;
    current_value:      number;
  };
  const perfByWallet = new Map<string, PerfRow[]>();
  if (missing.length > 0) {
    for (let i = 0; i < missing.length; i += CHUNK) {
      const slice = missing.slice(i, i + CHUNK);
      const { data } = await sb
        .from("wallet_performance_history")
        .select("wallet_address, position_status, initial_investment, current_value")
        .in("wallet_address", slice);
      for (const r of data ?? []) {
        const k = r.wallet_address as string;
        if (!perfByWallet.has(k)) perfByWallet.set(k, []);
        perfByWallet.get(k)!.push(r as PerfRow);
      }
    }
    console.log(`  Fallback perf data loaded for ${perfByWallet.size} wallets`);
  }

  // ── 4. Compute win_rate per wallet ───────────────────────────────────────
  const updates: Array<{ wallet_address: string; win_rate: number }> = [];
  let noData = 0;
  let noClosed = 0;

  for (const { wallet_address } of wallets) {
    const rawRows = rawByWallet.get(wallet_address);
    const perfRows = perfByWallet.get(wallet_address);

    let closedWithSOL = 0;
    let profitable    = 0;

    if (rawRows?.length) {
      // Raw path: derive position status from token balances & SOL columns
      for (const r of rawRows) {
        const bought   = Number(r.total_tokens_bought ?? 0);
        const sold     = Number(r.total_tokens_sold   ?? 0);
        const invested = Number(r.total_sol_invested  ?? 0);
        const received = Number(r.total_sol_received  ?? 0);
        const balance  = Math.max(0, bought - sold);

        // Determine if CLOSED (same logic as audit-rescore-v2.ts / wallet-enricher.ts)
        let isClosed = false;
        if ((r.data_source === "holder_scan") && invested === 0) {
          // UNKNOWN — skip
        } else if (bought === 0 && sold > 0) {
          isClosed = true;
        } else if (bought > 0 && balance <= bought * 0.001) {
          isClosed = true;
        } else if (bought > 0 && sold >= bought * 0.95) {
          isClosed = true;
        }

        if (isClosed && received > 0) {
          closedWithSOL++;
          if (received > invested) profitable++;
        }
      }
    } else if (perfRows?.length) {
      // Fallback path: use position_status directly
      for (const r of perfRows) {
        if (r.position_status === "CLOSED") {
          const invested = Number(r.initial_investment ?? 0);
          const received = Number(r.current_value      ?? 0);
          if (received > 0) {
            closedWithSOL++;
            if (received > invested) profitable++;
          }
        }
      }
    } else {
      noData++;
      continue;
    }

    if (closedWithSOL === 0) {
      noClosed++;
      continue;  // Can't compute win_rate without closed exits — leave null
    }

    updates.push({
      wallet_address,
      win_rate: profitable / closedWithSOL,
    });
  }

  console.log(
    `  Computable: ${updates.length}  |  No data: ${noData}  |  No closed exits: ${noClosed}`,
  );

  // ── 5. Upsert win_rate ───────────────────────────────────────────────────
  let written = 0;
  let errors  = 0;

  for (let i = 0; i < updates.length; i += UPSERT_SZ) {
    const slice = updates.slice(i, i + UPSERT_SZ);
    const { error } = await sb
      .from("wallets")
      .upsert(slice, { onConflict: "wallet_address", ignoreDuplicates: false });
    if (error) {
      console.error(`  ✗ batch ${i}: ${error.message}`);
      errors++;
    } else {
      written += slice.length;
    }
    process.stdout.write(`\r  Written ${written}/${updates.length}…`);
  }

  const elapsed = ((new Date().getTime() - startedAt.getTime()) / 1000).toFixed(1);
  console.log(`\n  ✅ Fixed ${written} wallets in ${elapsed}s. Errors: ${errors}.`);
  if (noData > 0)   console.log(`  ℹ️  ${noData} wallets had no position data — win_rate left null`);
  if (noClosed > 0) console.log(`  ℹ️  ${noClosed} wallets had no CLOSED exits — win_rate left null (correct)`);
  console.log("=== DONE ===");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
