// =============================================================================
// discovery-rescore-scheduler.ts
//
// Rescores pipeline-discovered tokens 24 hours after launch, when RugCheck
// has enough trading history to produce a meaningful risk score.
//
// WHY THIS EXISTS
//   Newly launched pump.fun tokens always score ~1 (LOW) on RugCheck because
//   RugCheck needs on-chain trading history (wash trading patterns, holder
//   concentration after market formation, honeypot detection) to compute a
//   real score. At the moment of discovery (T=0), there is no history.
//   After 24 hours of trading, RugCheck's score becomes 5-10x more meaningful.
//
//   This scheduler runs every 30 minutes, picks up to BATCH_SIZE discovery
//   tokens that are >= 24h old and still flagged needs_rescore=TRUE, calls
//   RugCheck for each, and writes the updated risk_score/risk_level back.
//
// PREREQUISITES
//   - Migration 20260716000012_discovery_rescore_columns.sql applied
//     (adds needs_rescore + last_rescored_at columns to scan_history)
//
// FIX (2026-07-20): mapRiskLevel previously returned "CRITICAL" for scores
//   >= 80. The scan_history table has a CHECK constraint
//   (scan_history_risk_level_enum) that only allows 'LOW', 'MEDIUM', 'HIGH',
//   'EXTREME'. Writing "CRITICAL" caused every UPDATE on those rows to fail
//   with a constraint violation — even updates that didn't touch risk_level —
//   because PostgreSQL re-validates all CHECK constraints on every UPDATE.
//   Fix: map scores >= 80 → "EXTREME" to match the DB constraint. The SQL
//   migration also widened the constraint to accept "CRITICAL" as belt-and-
//   suspenders, but the code is now consistent with the original intent.
//
// USAGE — add to server.ts startup sequence:
//   import { startDiscoveryRescoreScheduler } from "./lib/api/discovery-rescore-scheduler";
//   runScheduler("DiscoveryRescoreScheduler", startDiscoveryRescoreScheduler);
// =============================================================================

import { supabaseAdmin } from "@/integrations/supabase/client.server";

const LOG           = "[DiscoveryRescore]";
const INTERVAL_MS   = 30 * 60 * 1_000;  // run every 30 minutes
const BATCH_SIZE    = 200;               // tokens per scheduler tick (raised from 50 — 7.5k backlog)
const MIN_AGE_HOURS = 24;               // only rescore tokens >24h old
const DELAY_MS      = 200;              // ms between RugCheck calls (rate limit)
const RUGCHECK_TIMEOUT_MS = 8_000;

// Risk level mapping — must match scan_history CHECK constraint and browser scanner.
// Allowed values: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME'
// FIX: was returning "CRITICAL" for scores >= 80, which violated the DB constraint.
function mapRiskLevel(score: number): "LOW" | "MEDIUM" | "HIGH" | "EXTREME" {
  if (score >= 80) return "EXTREME";
  if (score >= 60) return "HIGH";
  if (score >= 30) return "MEDIUM";
  return "LOW";
}

// Detect honeypot from RugCheck risks array.
// FIX (2026-07-20): was returning "HONEYPOT" which is not in the DB CHECK constraint
// scan_history_honey_pot_status_enum: ('SAFE','SUSPICIOUS','HIGH RISK','CONFIRMED HONEYPOT').
// Any UPDATE with honey_pot_status='HONEYPOT' would fail the constraint silently.
function detectHoneypot(risks: Array<{ name?: string; level?: string }>): string {
  const isHoneypot = risks.some(
    (r) =>
      r.name?.toLowerCase().includes("honeypot") ||
      (r.level?.toLowerCase() === "danger" && r.name?.toLowerCase().includes("sell")),
  );
  return isHoneypot ? "CONFIRMED HONEYPOT" : "SAFE";
}

// Call RugCheck for a single token — never throws
async function scoreWithRugCheck(mintAddress: string): Promise<{
  risk_score: number;
  risk_level: "LOW" | "MEDIUM" | "HIGH" | "EXTREME";
  honey_pot_status: string;
  raw_risks: Array<{ name?: string; level?: string; description?: string }>;
} | null> {
  try {
    const res = await fetch(
      `https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report/summary`,
      { signal: AbortSignal.timeout(RUGCHECK_TIMEOUT_MS) },
    );
    if (!res.ok) {
      console.warn(`${LOG} RugCheck ${res.status} for ${mintAddress.slice(0, 8)}…`);
      return null;
    }
    const json = await res.json() as {
      score?: number;
      risks?: Array<{ name?: string; level?: string; description?: string }>;
    };
    const score     = typeof json.score === "number" ? Math.round(json.score) : 0;
    const risks     = json.risks ?? [];
    const risk_level = mapRiskLevel(score);
    return {
      risk_score:       score,
      risk_level,
      honey_pot_status: detectHoneypot(risks),
      raw_risks:        risks,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`${LOG} RugCheck fetch failed for ${mintAddress.slice(0, 8)}… (${msg})`);
    return null;
  }
}

// Fetch token metadata from DexScreener (name, symbol, market_cap, liquidity)
async function enrichFromDexScreener(mintAddresses: string[]): Promise<Record<string, {
  name: string | null; symbol: string | null;
  market_cap: number | null; liquidity: number | null;
}>> {
  if (!mintAddresses.length) return {};
  try {
    const addr = mintAddresses.join(",");
    const res  = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addr}`, {
      signal:  AbortSignal.timeout(10_000),
      headers: { "Accept": "application/json" },
    });
    if (!res.ok) return {};
    const json = await res.json() as {
      pairs?: Array<{
        baseToken: { address: string; name?: string; symbol?: string };
        marketCap?: number;
        liquidity?: { usd?: number };
      }>;
    };
    const result: Record<string, { name: string | null; symbol: string | null; market_cap: number | null; liquidity: number | null }> = {};
    for (const pair of json.pairs ?? []) {
      const addr = pair.baseToken?.address;
      if (addr && !result[addr]) {
        result[addr] = {
          name:       pair.baseToken.name   ?? null,
          symbol:     pair.baseToken.symbol ?? null,
          market_cap: pair.marketCap         ?? null,
          liquidity:  pair.liquidity?.usd    ?? null,
        };
      }
    }
    return result;
  } catch {
    return {};
  }
}

// One scheduler tick
async function tick(): Promise<void> {
  const cutoff = new Date(Date.now() - MIN_AGE_HOURS * 3_600_000).toISOString();

  const { data: rows, error } = await supabaseAdmin
    .from("scan_history")
    .select("token_address, risk_score, token_name")
    .eq("source", "discovery")
    .eq("needs_rescore", true)
    .lt("scanned_at", cutoff)
    .order("scanned_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (error) {
    console.error(`${LOG} Failed to fetch rescore candidates: ${error.message}`);
    return;
  }

  if (!rows?.length) {
    console.log(`${LOG} No discovery tokens due for rescore.`);
    return;
  }

  console.log(`${LOG} Rescoring ${rows.length} tokens older than ${MIN_AGE_HOURS}h…`);

  // Batch DexScreener to enrich metadata + market data in one request
  const mintAddresses = rows.map((r) => r.token_address);
  const dexMeta       = await enrichFromDexScreener(mintAddresses);

  let improved = 0, unchanged = 0, failed = 0;

  for (const row of rows) {
    const mint   = row.token_address;
    const result = await scoreWithRugCheck(mint);
    const meta   = dexMeta[mint] ?? {};
    const now    = new Date().toISOString();

    if (!result) {
      // RugCheck failed — skip, retry next tick
      failed++;
      await new Promise((r) => setTimeout(r, DELAY_MS));
      continue;
    }

    // Only update if score changed or token_name was missing
    const scoreChanged     = result.risk_score !== (row.risk_score ?? 0);
    const nameNowAvailable = meta.name && !row.token_name;

    const patch: Record<string, unknown> = {
      needs_rescore:   false,
      last_rescored_at: now,
    };
    if (scoreChanged) {
      patch.risk_score      = result.risk_score;
      patch.risk_level      = result.risk_level;  // now "EXTREME" not "CRITICAL"
      patch.honey_pot_status = result.honey_pot_status;
    }
    if (nameNowAvailable) {
      patch.token_name   = meta.name;
      patch.token_symbol = meta.symbol;
    }
    if (meta.market_cap != null) patch.market_cap = meta.market_cap;
    if (meta.liquidity   != null) patch.liquidity  = meta.liquidity;

    const { error: updateErr } = await supabaseAdmin
      .from("scan_history")
      .update(patch)
      .eq("token_address", mint)
      .eq("source", "discovery");

    if (updateErr) {
      console.error(`${LOG} Update failed for ${mint.slice(0, 8)}…: ${updateErr.message}`);
      failed++;
    } else {
      if (scoreChanged || nameNowAvailable) improved++;
      else unchanged++;
      if (result.risk_level === "HIGH" || result.risk_level === "EXTREME") {
        console.log(
          `${LOG} ⚠️  ${mint.slice(0, 8)}… upgraded to ${result.risk_level} ` +
          `(score: ${result.risk_score}) — ${result.raw_risks.slice(0, 2).map((r) => r.name).join(", ")}`,
        );
      }
    }

    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  console.log(
    `${LOG} Tick complete — improved: ${improved}, unchanged: ${unchanged}, failed: ${failed}`,
  );
}

let _intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startDiscoveryRescoreScheduler(): () => void {
  if (_intervalHandle !== null) {
    console.log(`${LOG} Already running.`);
    return () => { /* noop */ };
  }

  console.log(
    `${LOG} Starting — rescores discovery tokens >24h old every ` +
    `${INTERVAL_MS / 60_000}min. Requires migration 20260716000012.`,
  );

  // First tick after 90 seconds warmup (after graduation tracker, enrichment schedulers)
  const warmup = setTimeout(() => {
    void tick().catch((err) =>
      console.error(`${LOG} Initial tick failed:`, err instanceof Error ? err.message : String(err)),
    );
  }, 90_000);

  _intervalHandle = setInterval(() => {
    void tick().catch((err) =>
      console.error(`${LOG} Tick failed:`, err instanceof Error ? err.message : String(err)),
    );
  }, INTERVAL_MS);

  return () => {
    clearTimeout(warmup);
    if (_intervalHandle !== null) {
      clearInterval(_intervalHandle);
      _intervalHandle = null;
    }
    console.log(`${LOG} Stopped.`);
  };
}
