// =============================================================================
// agent-circuit-breaker.ts  —  v2
//
// Prevents the agent from hammering endpoints that are already failing.
//
// How it works:
//   1. Before every fix attempt, check whether the circuit for that category
//      is currently OPEN (i.e. too many recent failures without improvement).
//   2. If open → skip the fix, log the skip, alert if it just opened.
//   3. After a fix, record the result (metric_before / metric_after / improved).
//   4. If N consecutive failures in the circuit window → open the circuit.
//   5. Circuit auto-resets after `reset_after` (default 2 h).
//
// All state lives in Supabase so it survives server restarts.
// =============================================================================

import { supabaseAdmin } from "@/integrations/supabase/client.server";

const LOG = "[circuit-breaker]";

// ── Config defaults (overridden by agent_settings) ───────────────────────────

export interface CircuitConfig {
  failureThreshold: number;   // consecutive failures before opening  (default 3)
  windowMinutes: number;      // look-back window for counting failures (default 90)
  resetHours: number;         // hours before open circuit auto-resets  (default 2)
}

const DEFAULT_CONFIG: CircuitConfig = {
  failureThreshold: 3,
  windowMinutes:    90,
  resetHours:       2,
};

// ── Public API ────────────────────────────────────────────────────────────────

/** Returns true when the circuit for `category` is OPEN (fix should be skipped). */
export async function isCircuitOpen(category: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("agent_circuit_state")
    .select("reset_after")
    .eq("category", category)
    .maybeSingle();

  if (error) {
    console.warn(LOG, `Could not query circuit state for '${category}':`, error.message);
    return false; // fail open — allow the fix attempt
  }
  if (!data) return false;

  // If reset_after is in the past, the circuit should have auto-reset
  const resetAt = new Date(data.reset_after as string);
  if (resetAt <= new Date()) {
    await closeCircuit(category);
    return false;
  }

  return true;
}

/**
 * Record a fix attempt result. If the circuit should open after this record,
 * it will be opened automatically.
 *
 * @returns true if the circuit was just opened by this call
 */
export async function recordFixAttempt(
  category: string,
  action: string,
  success: boolean,
  metricKey: string | null,
  metricBefore: string | null,
  metricAfter: string | null,
  improved: boolean | null,
  config: CircuitConfig = DEFAULT_CONFIG,
): Promise<{ circuitOpened: boolean }> {
  const circuitOpened = !success && !(improved ?? true);

  // Insert fix log row
  const { error: logErr } = await supabaseAdmin.from("agent_fix_log").insert({
    category,
    action,
    success,
    metric_key:    metricKey,
    metric_before: metricBefore,
    metric_after:  metricAfter,
    improved,
    circuit_opened: circuitOpened,
  });
  if (logErr) {
    console.warn(LOG, "Failed to insert fix log:", logErr.message);
  }

  // Count consecutive non-improving fixes within the window
  const windowStart = new Date(Date.now() - config.windowMinutes * 60_000).toISOString();
  const { data: recentFixes, error: countErr } = await supabaseAdmin
    .from("agent_fix_log")
    .select("improved, success")
    .eq("category", category)
    .gte("applied_at", windowStart)
    .order("applied_at", { ascending: false });

  if (countErr) {
    console.warn(LOG, "Failed to count recent fixes:", countErr.message);
    return { circuitOpened: false };
  }

  // Count how many consecutive recent fixes were NOT improving
  let consecutiveFailures = 0;
  for (const fix of recentFixes ?? []) {
    if ((fix as Record<string, unknown>).improved === true) break;
    consecutiveFailures++;
  }

  if (consecutiveFailures >= config.failureThreshold) {
    const resetAfter = new Date(Date.now() + config.resetHours * 3_600_000).toISOString();
    const { error: upsertErr } = await supabaseAdmin
      .from("agent_circuit_state")
      .upsert({
        category,
        opened_at:            new Date().toISOString(),
        consecutive_failures: consecutiveFailures,
        last_metric:          metricAfter ?? metricBefore,
        reset_after:          resetAfter,
        notes: `Opened after ${consecutiveFailures} non-improving fixes in ${config.windowMinutes}m window. Resets at ${resetAfter}.`,
      });
    if (upsertErr) {
      console.warn(LOG, "Failed to open circuit:", upsertErr.message);
    } else {
      console.warn(
        LOG,
        `⚡ Circuit OPENED for '${category}' — ${consecutiveFailures} consecutive non-improving fixes. Auto-resets at ${resetAfter}`,
      );
      return { circuitOpened: true };
    }
  }

  return { circuitOpened: false };
}

/** Explicitly close a circuit (called when metric improves or reset_after passes). */
export async function closeCircuit(category: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("agent_circuit_state")
    .delete()
    .eq("category", category);
  if (error) {
    console.warn(LOG, `Failed to close circuit for '${category}':`, error.message);
  } else {
    console.log(LOG, `Circuit CLOSED for '${category}'`);
  }
}

/** Returns all currently-open circuits. */
export async function getOpenCircuits(): Promise<string[]> {
  const { data } = await supabaseAdmin
    .from("agent_circuit_state")
    .select("category, reset_after");

  const now = new Date();
  const open: string[] = [];
  for (const row of data ?? []) {
    const r = row as Record<string, unknown>;
    if (new Date(r.reset_after as string) > now) {
      open.push(r.category as string);
    }
  }
  return open;
}
