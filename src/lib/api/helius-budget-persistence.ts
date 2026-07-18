// =============================================================================
// helius-budget-persistence.ts
//
// Persists the Helius daily CU budget counter to Supabase so it survives
// Railway restarts / redeploys.
//
// PROBLEM (audit finding — globalThis budget resets on restart):
//   The `_consumeHC()` function in token-discovery.ts and tx-reconstructor.ts
//   keeps daily CU usage in `globalThis.__heliusBudget__.used`. Because
//   globalThis is process-local memory, every Railway restart zeros the counter
//   — letting the pipeline burn the full daily Helius quota again within minutes.
//   During active discovery this can exhaust a 20 000-CU/day budget 2–3× per day
//   instead of once, causing unexpected Helius billing overruns.
//
// FIX:
//   1. On server startup, call `initHeliusBudgetPersistence()`.
//      It reads today's row from `helius_budget_daily` in Supabase and seeds
//      `globalThis.__heliusBudget__.used` with the already-consumed amount,
//      so the budget guard immediately enforces the correct remaining headroom.
//   2. A 60-second flush interval writes the current in-memory counter back to
//      the DB, so restarts lose at most ~60s of CU history.
//
// PREREQUISITES:
//   Migration 20260718000002_helius_budget_daily.sql must be applied first.
//
// USAGE (in server.ts, before any scheduler starts):
//   import { initHeliusBudgetPersistence } from "./lib/api/helius-budget-persistence";
//   await initHeliusBudgetPersistence();
// =============================================================================

import { supabaseAdmin } from "@/integrations/supabase/client.server";

const LOG           = "[HeliusBudgetPersistence]";
const FLUSH_MS      = 60_000;  // flush current usage to DB every 60 seconds

// Today's date as YYYY-MM-DD in UTC — used as the primary key in helius_budget_daily.
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

// Read the shared globalThis budget object written by token-discovery.ts /
// tx-reconstructor.ts. Returns null if the budget hasn't been initialised yet
// (i.e. _consumeHC hasn't run).
function getBudgetGlobal(): { budget: number; used: number; day: number; warned: boolean } | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  return g.__heliusBudget__ ?? null;
}

// Overwrite (or seed) the shared globalThis budget object.
function setBudgetGlobal(used: number): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  const daily = parseInt(process.env.HELIUS_DAILY_BUDGET ?? "20000", 10) || 0;
  if (!g.__heliusBudget__) {
    // First boot — _consumeHC hasn't run yet. Pre-seed so it picks up the
    // right `used` value when it runs for the first time.
    g.__heliusBudget__ = {
      budget: daily,
      used,
      day:    Date.now(),
      warned: false,
    };
  } else {
    // Budget object already exists — only update `used` so we don't
    // disturb the `day` window timestamp or the `warned` flag that
    // _consumeHC manages itself.
    g.__heliusBudget__.used = Math.max(g.__heliusBudget__.used, used);
  }
}

// ---------------------------------------------------------------------------
// Flush — upsert today's usage row to the DB.
// Fire-and-forget: called from a setInterval, errors are logged but non-fatal.
// ---------------------------------------------------------------------------
async function flushBudget(): Promise<void> {
  const b = getBudgetGlobal();
  if (!b || b.used === 0) return;   // nothing to persist yet

  const date = todayUtc();
  const { error } = await supabaseAdmin
    .from("helius_budget_daily")
    .upsert(
      { date, cu_used: b.used, updated_at: new Date().toISOString() },
      { onConflict: "date" },
    );

  if (error) {
    console.warn(LOG, "flush error:", error.message);
  }
}

// ---------------------------------------------------------------------------
// initHeliusBudgetPersistence — call once at server startup (await it).
// ---------------------------------------------------------------------------
export async function initHeliusBudgetPersistence(): Promise<void> {
  const today = todayUtc();

  // ── 1. Load today's persisted CU usage ────────────────────────────────────
  try {
    const { data, error } = await supabaseAdmin
      .from("helius_budget_daily")
      .select("cu_used")
      .eq("date", today)
      .maybeSingle();

    if (error) {
      console.warn(LOG, "Could not load persisted budget (non-fatal):", error.message);
    } else if (data && typeof data.cu_used === "number" && data.cu_used > 0) {
      setBudgetGlobal(data.cu_used);
      console.log(
        LOG,
        `Restored daily budget: ${data.cu_used} CUs already used today (${today}).`,
        `Remaining: ${Math.max(0, (parseInt(process.env.HELIUS_DAILY_BUDGET ?? "20000", 10) || 0) - data.cu_used)} CUs.`,
      );
    } else {
      console.log(LOG, `No persisted budget found for ${today} — starting fresh.`);
    }
  } catch (err) {
    // Non-fatal: if Supabase is unreachable on startup, the in-memory budget
    // still works — it just resets. Log and continue.
    console.warn(LOG, "Exception loading persisted budget (non-fatal):", err instanceof Error ? err.message : String(err));
  }

  // ── 2. Start the 60-second flush interval ─────────────────────────────────
  // Guard against double-registration on hot-reloads.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (!g.__heliusBudgetFlushInterval__) {
    g.__heliusBudgetFlushInterval__ = setInterval(() => {
      flushBudget().catch((err) =>
        console.warn(LOG, "Flush interval error:", err instanceof Error ? err.message : String(err)),
      );
    }, FLUSH_MS);
    console.log(LOG, "Flush interval started (every 60s).");
  }
}
