// ─────────────────────────────────────────────────────────────────────────────
// PATCH: Replace the entire _consumeHC function (and the CU log batch flush
// helpers below it) in src/lib/api/token-discovery.ts with this block.
//
// What this adds on top of the original:
//   • In-memory batch accumulator (cuLogBatch)
//   • Auto-flush to Supabase every 60 seconds (or when batch reaches 50 entries)
//   • Each _consumeHC call appends a lightweight record — no await, no blocking
//
// Prerequisites:
//   1. Run helius_cu_log.sql in Supabase SQL Editor first.
//   2. supabaseAdmin must already be imported (it is in the original file).
//
// Placement: Replace lines ~43–106 in token-discovery.ts (the _consumeHC block).
// ─────────────────────────────────────────────────────────────────────────────

// ── In-memory CU log batch ───────────────────────────────────────────────────
// Entries accumulate here and are flushed to Supabase in bulk every 60 seconds.
// Fire-and-forget: _consumeHC never awaits Supabase — the budget guard stays sync.
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any;
if (!g.__cuLogBatch__) g.__cuLogBatch__ = [] as CuLogEntry[];
if (!g.__cuLogFlushing__) g.__cuLogFlushing__ = false;

function _enqueueCuLog(entry: CuLogEntry) {
  g.__cuLogBatch__.push(entry);
  // Flush immediately if batch is large; otherwise the interval handles it.
  if (g.__cuLogBatch__.length >= 50) _flushCuLog();
}

async function _flushCuLog() {
  if (g.__cuLogFlushing__ || g.__cuLogBatch__.length === 0) return;
  g.__cuLogFlushing__ = true;
  const batch: CuLogEntry[] = g.__cuLogBatch__.splice(0, g.__cuLogBatch__.length);
  try {
    const { error } = await supabaseAdmin.from("helius_cu_log").insert(batch);
    if (error) {
      // Non-fatal: put batch back so we retry next flush cycle
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

// Start the 60-second flush interval once (survives hot-reloads via globalThis guard).
if (!g.__cuLogInterval__) {
  g.__cuLogInterval__ = setInterval(_flushCuLog, 60_000);
}

// ── Helius daily credit budget ───────────────────────────────────────────────
// Shared with PostLaunchWatcher via globalThis — both files access the same
// running counter without needing a shared module import.
function _consumeHC(cuAmount: number, label: string): boolean {
  const now = Date.now();

  // ── Daily bucket ────────────────────────────────────────────────────────────
  if (!g.__heliusBudget__ || now - g.__heliusBudget__.day >= 86_400_000) {
    g.__heliusBudget__ = {
      budget: parseInt(process.env.HELIUS_DAILY_BUDGET ?? "20000", 10) || 0,
      used:   0,
      day:    now,
      warned: false,
    };
  }
  const b = g.__heliusBudget__ as { budget: number; used: number; day: number; warned: boolean };

  // ── Hourly bucket ───────────────────────────────────────────────────────────
  // Resets every 60 minutes. Controlled by HELIUS_HOURLY_BUDGET env var.
  // NOTE: omitting the env var does NOT disable the cap — it falls back to a
  // conservative default of 1000 CUs/hr. To actually disable enforcement,
  // set HELIUS_HOURLY_BUDGET=0 explicitly. To raise the cap, set an explicit
  // higher number (e.g. 50000) in Railway Variables.
  if (!g.__heliusHourly__ || now - g.__heliusHourly__.window >= 3_600_000) {
    g.__heliusHourly__ = {
      budget: parseInt(process.env.HELIUS_HOURLY_BUDGET ?? "1000", 10) || 0,
      used:   0,
      window: now,
      warned: false,
    };
  }
  const h = g.__heliusHourly__ as { budget: number; used: number; window: number; warned: boolean };

  // ── Hourly cap check ────────────────────────────────────────────────────────
  if (h.budget > 0 && h.used + cuAmount > h.budget) {
    if (!h.warned) {
      h.warned = true;
      const resetsIn = Math.ceil((h.window + 3_600_000 - now) / 60_000);
      console.warn(
        `[HeliusBudget] ⚠️  Hourly cap reached (${h.used}/${h.budget} CUs used this hour). ` +
        `Skipping "${label}" — resets in ~${resetsIn} min. ` +
        `Raise HELIUS_HOURLY_BUDGET in Railway Variables to increase the limit.`,
      );
    }
    return false;
  }

  // ── Daily cap check ─────────────────────────────────────────────────────────
  if (b.budget > 0 && b.used + cuAmount > b.budget) {
    if (!b.warned) {
      b.warned = true;
      console.warn(
        `[HeliusBudget] ⚠️  Daily budget exhausted (${b.used}/${b.budget} CUs used). ` +
        `Skipping "${label}" until tomorrow. ` +
        `Raise HELIUS_DAILY_BUDGET in Railway Variables to increase the limit.`,
      );
    }
    return false;
  }

  // ── Consume from both buckets ───────────────────────────────────────────────
  if (h.budget > 0) h.used += cuAmount;
  if (b.budget > 0) b.used += cuAmount;

  // ── Log to Supabase (fire-and-forget, batched) ──────────────────────────────
  // Extract the component prefix from the label (e.g. "TokenDiscovery" from
  // "TokenDiscovery/notification") for the dashboard's stacked-bar grouping.
  const component = label.split("/")[0] ?? label;
  _enqueueCuLog({
    logged_at:     new Date().toISOString(),
    label,
    component,
    cu_amount:     cuAmount,
    hourly_used:   h.used,
    hourly_budget: h.budget,
    daily_used:    b.used,
    daily_budget:  b.budget,
  });

  return true;
}
// ─────────────────────────────────────────────────────────────────────────────
