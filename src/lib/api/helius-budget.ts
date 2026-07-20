// =============================================================================
// src/lib/api/helius-budget.ts
//
// PURPOSE (P0 #2 fix — Singleton Budget Guard):
//   _consumeHC() was copy-pasted across wallet-collection-worker.ts,
//   token-discovery.ts, and tx-reconstructor.ts. The three copies had already
//   diverged (different reset-window logic — calendar UTC day in
//   helius-budget-persistence.ts vs. rolling 24h in the inline implementations).
//   Silent double-counting near midnight was occurring as a result.
//
//   This module is the single source of truth for Helius CU budget enforcement.
//   Import consumeHeliusBudget() from here and delete all local _consumeHC copies.
//
// USAGE:
//   import { consumeHeliusBudget } from "@/lib/api/helius-budget";
//   if (!consumeHeliusBudget(1, "TokenDiscovery/getAccountInfo")) return null;
//
// WIRING:
//   helius-budget-persistence.ts already seeds globalThis.__heliusBudget__ on
//   startup. This module reads and writes the same globalThis key — no separate
//   init call is needed beyond what persistence already does.
// =============================================================================

import { supabaseAdmin } from "@/integrations/supabase/client.server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any;

// ── In-memory CU log batch (shared with token-discovery.ts via globalThis) ───
interface CuLogEntry {
  logged_at:     string;
  label:         string;
  component:     string;
  cu_amount:     number;
  hourly_used:   number;
  hourly_budget: number;
  daily_used:    number;
  daily_budget:  number;
}

if (!g.__cuLogBatch__)    g.__cuLogBatch__    = [] as CuLogEntry[];
if (!g.__cuLogFlushing__) g.__cuLogFlushing__ = false;

function _enqueueCuLog(entry: CuLogEntry) {
  g.__cuLogBatch__.push(entry);
  if (g.__cuLogBatch__.length >= 50) void _flushCuLog();
}

async function _flushCuLog(): Promise<void> {
  if (g.__cuLogFlushing__ || g.__cuLogBatch__.length === 0) return;
  g.__cuLogFlushing__ = true;
  const batch: CuLogEntry[] = g.__cuLogBatch__.splice(0, g.__cuLogBatch__.length);
  try {
    const { error } = await supabaseAdmin.from("helius_cu_log").insert(batch);
    if (error) {
      console.warn("[HeliusBudget] CU log flush failed:", error.message);
      g.__cuLogBatch__.unshift(...batch);
    }
  } catch (err) {
    console.warn("[HeliusBudget] CU log flush error:", err instanceof Error ? err.message : String(err));
    g.__cuLogBatch__.unshift(...batch);
  } finally {
    g.__cuLogFlushing__ = false;
  }
}

// Start flush interval once (globalThis guard prevents double-registration on hot-reload)
if (!g.__cuLogInterval__) {
  g.__cuLogInterval__ = setInterval(() => { void _flushCuLog(); }, 60_000);
}

// ── Budget state types ────────────────────────────────────────────────────────
interface DailyBucket  { budget: number; used: number; calendarDay: string; warned: boolean; }
interface HourlyBucket { budget: number; used: number; window: number;      warned: boolean; }

/**
 * Attempt to consume `cuAmount` Helius Compute Units under the daily and hourly
 * caps configured via HELIUS_DAILY_BUDGET / HELIUS_HOURLY_BUDGET env vars.
 *
 * Returns `true` if the budget allows the call; `false` if either cap is exceeded.
 * Callers MUST skip the Helius API call when this returns false.
 *
 * FIX (P0 #2): This is the canonical singleton. Delete all local _consumeHC()
 * copies from wallet-collection-worker.ts, token-discovery.ts, and
 * tx-reconstructor.ts and import this function instead.
 *
 * FIX (P0 #5): Uses calendar UTC day (YYYY-MM-DD) for the daily reset, NOT a
 * rolling 24-hour window. This aligns with helius-budget-persistence.ts which
 * reads/writes helius_budget_daily keyed by calendar date, preventing the
 * double-spend bug that occurred on restarts near midnight UTC.
 */
export function consumeHeliusBudget(cuAmount: number, label: string): boolean {
  const now = Date.now();

  // ── Daily bucket ─────────────────────────────────────────────────────────────
  const todayUtc = new Date().toISOString().slice(0, 10);
  if (!g.__heliusBudget__ || (g.__heliusBudget__ as DailyBucket).calendarDay !== todayUtc) {
    g.__heliusBudget__ = {
      budget:      parseInt(process.env.HELIUS_DAILY_BUDGET ?? "0", 10) || 0,
      used:        0,
      calendarDay: todayUtc,
      warned:      false,
    } satisfies DailyBucket;
  }
  const b = g.__heliusBudget__ as DailyBucket;

  // ── Hourly bucket ────────────────────────────────────────────────────────────
  if (!g.__heliusHourly__ || now - (g.__heliusHourly__ as HourlyBucket).window >= 3_600_000) {
    g.__heliusHourly__ = {
      budget: parseInt(process.env.HELIUS_HOURLY_BUDGET ?? "0", 10) || 0,
      used:   0,
      window: now,
      warned: false,
    } satisfies HourlyBucket;
  }
  const h = g.__heliusHourly__ as HourlyBucket;

  // ── Hourly cap check ─────────────────────────────────────────────────────────
  if (h.budget > 0 && h.used + cuAmount > h.budget) {
    if (!h.warned) {
      h.warned = true;
      const resetsIn = Math.ceil((h.window + 3_600_000 - now) / 60_000);
      console.warn(
        `[HeliusBudget] ⚠️  Hourly cap reached (${h.used}/${h.budget} CUs used this hour). ` +
        `Skipping "${label}" — resets in ~${resetsIn} min. ` +
        `Set HELIUS_HOURLY_BUDGET=0 to disable, or raise the limit in Railway Variables.`,
      );
    }
    return false;
  }

  // ── Daily cap check ──────────────────────────────────────────────────────────
  if (b.budget > 0 && b.used + cuAmount > b.budget) {
    if (!b.warned) {
      b.warned = true;
      console.warn(
        `[HeliusBudget] ⚠️  Daily budget exhausted (${b.used}/${b.budget} CUs used). ` +
        `Skipping "${label}" until tomorrow UTC. ` +
        `Raise HELIUS_DAILY_BUDGET in Railway Variables to increase the limit.`,
      );
    }
    return false;
  }

  // ── Consume from both buckets ────────────────────────────────────────────────
  if (h.budget > 0) h.used += cuAmount;
  if (b.budget > 0) b.used += cuAmount;

  // ── Log to Supabase (batched, fire-and-forget) ────────────────────────────────
  const isRawNotification = label.endsWith("/notification");
  if (!isRawNotification) {
    _enqueueCuLog({
      logged_at:     new Date().toISOString(),
      label,
      component:     label.split("/")[0] ?? label,
      cu_amount:     cuAmount,
      hourly_used:   h.used,
      hourly_budget: h.budget,
      daily_used:    b.used,
      daily_budget:  b.budget,
    });
  }

  return true;
}

/**
 * Read remaining daily budget without consuming any. Returns null when
 * HELIUS_DAILY_BUDGET=0 (unlimited mode) so callers can display "unlimited"
 * rather than "0 remaining".
 */
export function getRemainingDailyBudget(): number | null {
  const b = g.__heliusBudget__ as DailyBucket | undefined;
  if (!b || b.budget === 0) return null;
  return Math.max(0, b.budget - b.used);
}

/**
 * Returns a snapshot of current budget usage for monitoring / dashboards.
 */
export function getBudgetSnapshot(): {
  daily: { budget: number; used: number; calendarDay: string } | null;
  hourly: { budget: number; used: number } | null;
} {
  const b = g.__heliusBudget__ as DailyBucket | undefined;
  const h = g.__heliusHourly__ as HourlyBucket | undefined;
  return {
    daily:  b ? { budget: b.budget, used: b.used, calendarDay: b.calendarDay } : null,
    hourly: h ? { budget: h.budget, used: h.used } : null,
  };
}
