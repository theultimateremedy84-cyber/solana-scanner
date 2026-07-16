// =============================================================================
// intelligence-snapshot-scheduler.ts
//
// Takes a daily immutable snapshot of all scored wallets, developer
// reputations, and token risk scores. Runs once per day at midnight UTC.
//
// WHY THIS EXISTS
//   The intelligence_snapshots table (migration 20260716000011) is the moat
//   asset. Every day that passes without a snapshot is a day of history you
//   can never recover. After 12-18 months this dataset will answer questions
//   no competitor can answer: how did wallet reputations evolve over time,
//   which developers improved their track record, how did risk scores change.
//
// PREREQUISITES
//   - Migration 20260716000011_intelligence_snapshots.sql applied
//   - Migration 20260716000010_verified_positions_column.sql applied
//
// USAGE — add to server.ts startup sequence:
//   import { startIntelligenceSnapshotScheduler } from "./lib/api/intelligence-snapshot-scheduler";
//   runScheduler("SnapshotScheduler", startIntelligenceSnapshotScheduler);
// =============================================================================

import { supabaseAdmin } from "@/integrations/supabase/client.server";

const LOG         = "[SnapshotScheduler]";
const BATCH_SIZE  = 500;   // wallets per DB round-trip (avoids large payload)

// ── Milliseconds until next midnight UTC ─────────────────────────────────────
function msUntilMidnightUTC(): number {
  const now     = Date.now();
  const todayMs = new Date().setUTCHours(0, 0, 0, 0);
  const nextMs  = todayMs + 86_400_000;
  return Math.max(0, nextMs - now);
}

// ── Snapshot wallet intelligence scores ──────────────────────────────────────
async function snapshotWallets(): Promise<number> {
  const today  = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  let   offset = 0;
  let   total  = 0;

  while (true) {
    const { data, error } = await supabaseAdmin
      .from("wallets")
      .select(
        "wallet_address, intelligence_score, discovery_score, conviction_score, " +
        "win_rate, average_roi, wallet_classification, confidence_tier, " +
        "evidence_quality, total_buys, total_sells, verified_positions, closed_position_count",
      )
      .not("intelligence_score", "is", null)
      .range(offset, offset + BATCH_SIZE - 1);

    if (error) {
      console.error(`${LOG} Wallet batch ${offset} failed: ${error.message}`);
      break;
    }
    if (!data?.length) break;

    const rows = data.map((w) => ({
      wallet_address:        w.wallet_address,
      snapshot_date:         today,
      intelligence_score:    w.intelligence_score,
      discovery_score:       w.discovery_score,
      conviction_score:      w.conviction_score,
      win_rate:              w.win_rate,
      average_roi:           w.average_roi,
      wallet_classification: w.wallet_classification,
      confidence_tier:       w.confidence_tier,
      evidence_quality:      w.evidence_quality,
      total_buys:            w.total_buys,
      total_sells:           w.total_sells,
      verified_positions:    (w as { verified_positions?: number }).verified_positions ?? null,
      closed_position_count: w.closed_position_count,
      snapshotted_at:        new Date().toISOString(),
    }));

    const { error: insertErr } = await supabaseAdmin
      .from("intelligence_snapshots")
      .insert(rows);
      // ON CONFLICT DO NOTHING handled by the unique constraint

    if (insertErr && !insertErr.message.includes("duplicate key")) {
      console.error(`${LOG} Wallet snapshot insert failed: ${insertErr.message}`);
    } else {
      total += rows.length;
    }

    offset += BATCH_SIZE;
    if (data.length < BATCH_SIZE) break;
  }

  return total;
}

// ── Snapshot developer reputations ───────────────────────────────────────────
async function snapshotDevelopers(): Promise<number> {
  const today = new Date().toISOString().split("T")[0];

  // Aggregate from scan_history
  const { data, error } = await supabaseAdmin
    .from("scan_history")
    .select("developer_wallet, risk_level, graduated_at")
    .not("developer_wallet", "is", null)
    .eq("source", "discovery");

  if (error) {
    console.error(`${LOG} Developer fetch failed: ${error.message}`);
    return 0;
  }

  // Aggregate per developer
  const devMap: Record<string, {
    total: number; graduated: number; high_risk: number;
  }> = {};

  for (const row of data ?? []) {
    const dev = row.developer_wallet as string;
    if (!devMap[dev]) devMap[dev] = { total: 0, graduated: 0, high_risk: 0 };
    devMap[dev].total++;
    if (row.graduated_at) devMap[dev].graduated++;
    if (row.risk_level === "HIGH" || row.risk_level === "CRITICAL") devMap[dev].high_risk++;
  }

  const rows = Object.entries(devMap).map(([dev, stats]) => ({
    developer_wallet:      dev,
    snapshot_date:         today,
    total_tokens_launched: stats.total,
    graduated_count:       stats.graduated,
    high_risk_count:       stats.high_risk,
    graduation_rate:       stats.total > 0 ? stats.graduated / stats.total : 0,
    snapshotted_at:        new Date().toISOString(),
  }));

  if (!rows.length) return 0;

  // Insert in batches
  let total = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const { error: insertErr } = await supabaseAdmin
      .from("developer_reputation_snapshots")
      .insert(rows.slice(i, i + BATCH_SIZE));
    if (insertErr && !insertErr.message.includes("duplicate key")) {
      console.error(`${LOG} Dev snapshot insert failed: ${insertErr.message}`);
    } else {
      total += Math.min(BATCH_SIZE, rows.length - i);
    }
  }
  return total;
}

// ── Snapshot token risk scores ────────────────────────────────────────────────
async function snapshotTokens(): Promise<number> {
  const today  = new Date().toISOString().split("T")[0];
  let   offset = 0;
  let   total  = 0;

  while (true) {
    const { data, error } = await supabaseAdmin
      .from("scan_history")
      .select("token_address, risk_score, risk_level, honey_pot_status, market_cap, liquidity, holder_count, graduated_at")
      .range(offset, offset + BATCH_SIZE - 1);

    if (error) { console.error(`${LOG} Token batch ${offset} failed: ${error.message}`); break; }
    if (!data?.length) break;

    const rows = data.map((s) => ({
      token_address:    s.token_address,
      snapshot_date:    today,
      risk_score:       s.risk_score,
      risk_level:       s.risk_level,
      honey_pot_status: s.honey_pot_status,
      market_cap:       s.market_cap,
      liquidity:        s.liquidity,
      holder_count:     s.holder_count,
      graduated:        s.graduated_at != null,
      snapshotted_at:   new Date().toISOString(),
    }));

    const { error: insertErr } = await supabaseAdmin
      .from("token_risk_snapshots")
      .insert(rows);
    if (insertErr && !insertErr.message.includes("duplicate key")) {
      console.error(`${LOG} Token snapshot insert failed: ${insertErr.message}`);
    } else {
      total += rows.length;
    }

    offset += BATCH_SIZE;
    if (data.length < BATCH_SIZE) break;
  }

  return total;
}

// ── Main snapshot job ─────────────────────────────────────────────────────────
async function runDailySnapshot(): Promise<void> {
  const start = Date.now();
  console.log(`${LOG} Daily snapshot starting…`);

  const [wallets, developers, tokens] = await Promise.all([
    snapshotWallets().catch((e) => { console.error(`${LOG} Wallet snapshot failed:`, e); return 0; }),
    snapshotDevelopers().catch((e) => { console.error(`${LOG} Dev snapshot failed:`, e); return 0; }),
    snapshotTokens().catch((e) => { console.error(`${LOG} Token snapshot failed:`, e); return 0; }),
  ]);

  const durationSec = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `${LOG} Daily snapshot complete in ${durationSec}s — ` +
    `wallets: ${wallets}, developers: ${developers}, tokens: ${tokens}`,
  );
}

// ── Scheduler lifecycle ───────────────────────────────────────────────────────
let _timeoutHandle: ReturnType<typeof setTimeout> | null = null;

function scheduleNextTick(): void {
  const delay = msUntilMidnightUTC();
  console.log(`${LOG} Next snapshot in ${Math.round(delay / 60_000)} minutes (midnight UTC).`);
  _timeoutHandle = setTimeout(() => {
    void runDailySnapshot().catch((e) =>
      console.error(`${LOG} Snapshot run failed:`, e instanceof Error ? e.message : String(e)),
    ).finally(() => {
      scheduleNextTick(); // schedule the next day
    });
  }, delay);
}

export function startIntelligenceSnapshotScheduler(): () => void {
  if (_timeoutHandle !== null) {
    console.log(`${LOG} Already scheduled.`);
    return () => { /* noop */ };
  }

  console.log(`${LOG} Starting — daily snapshot at midnight UTC.`);
  scheduleNextTick();

  return () => {
    if (_timeoutHandle !== null) {
      clearTimeout(_timeoutHandle);
      _timeoutHandle = null;
    }
    console.log(`${LOG} Stopped.`);
  };
}
