// =============================================================================
// scan-history-handler.ts
//
// Pure server-side handler for POST/GET /api/scan-history.
// Has NO @tanstack/react-start imports so it is safely bundled by Nitro
// as part of src/server.ts — identical pattern to enrich-handler.ts /
// price-refresh-handler.ts.
//
// FIXES audit finding #4:
//   scan_history previously allowed open INSERT from anon/authenticated —
//   the frontend wrote scan results directly with the anon key, so anyone
//   holding that key could insert arbitrary rows (fake risk_score, fake
//   is_*_exploit flags, spoofed token names) with nothing validating them
//   server-side.
//
//   This handler is now the ONLY way to write to scan_history. It validates
//   every field's type/range before writing with supabaseAdmin (service
//   role — the only role migration 20260709000003 grants INSERT to).
//
// src/lib/scan-history.ts's recordScan() calls this route instead of
// inserting into Supabase directly from the browser.
// =============================================================================

import { supabaseAdmin } from "@/integrations/supabase/client.server";

const LOG = "[scan-history-handler]";

// ---------------------------------------------------------------------------
// SECURITY NOTE (from code review, 2026-07-08):
//
// This route is intentionally public — the frontend records a scan for
// anyone visiting the scanner page, with no login. Moving the write off the
// anon Supabase key does NOT, by itself, stop a determined attacker from
// scripting a POST with fabricated fields: this endpoint still has to trust
// client-submitted risk data, because the actual risk computation runs in
// the browser (RugCheck/GoPlus/Helius calls in mockScan.ts), not on this
// server. A full fix for that requires moving the scan computation itself
// server-side — a much larger change, tracked as a follow-up recommendation
// rather than attempted here.
//
// What this endpoint DOES meaningfully fix vs. the old open RLS INSERT:
//   1. Every field is type/range/enum validated — the DB can no longer be
//      sent wildly invalid values (negative counts, risk_score > 100, made
//      up risk_level strings, etc.), which is what the CHECK constraints in
//      the accompanying migration also enforce as defense in depth.
//   2. Same-origin check + per-token-address rate limiting below block
//      casual/naive scripted abuse and flooding, even though they cannot
//      stop a sophisticated attacker who fully replicates browser headers.
//   3. All writes are now centrally logged and service-role-only at the DB
//      level — no client anywhere holds a key that can write this table.
// ---------------------------------------------------------------------------

/** DB-backed sliding-window rate limit: one recorded scan per token_address
 * per window. Backed by scan_history so it survives Railway restarts and
 * works correctly across multiple replicas — unlike the previous in-memory
 * Map which reset on every redeploy (audit fix: duplicate scan rows). */
const RATE_LIMIT_WINDOW_MS = 30_000;

async function isRateLimited(tokenAddress: string): Promise<boolean> {
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
  const { data, error } = await supabaseAdmin
    .from("scan_history")
    .select("scanned_at")
    .eq("token_address", tokenAddress)
    .gte("scanned_at", windowStart)
    .limit(1);
  if (error) {
    // On DB error, allow the write — better to have a duplicate than to
    // silently drop a valid scan.
    console.warn(`${LOG} Rate-limit DB check failed (allowing write): ${error.message}`);
    return false;
  }
  return !!data?.length;
}

/** Best-effort same-origin check. Trivially bypassable by a raw HTTP client
 * that sets its own headers, but blocks naive cross-site scripted abuse and
 * hot-linking. Skipped when ALLOWED_ORIGIN isn't set (e.g. local dev). */
function isAllowedOrigin(request: Request): boolean {
  const allowed = process.env.ALLOWED_ORIGIN;
  if (!allowed) return true;
  const origin = request.headers.get("origin") ?? request.headers.get("referer");
  return !!origin && origin.startsWith(allowed);
}

const RISK_LEVELS = new Set(["LOW", "MEDIUM", "HIGH", "EXTREME"]);
const HONEY_POT_STATUSES = new Set([
  "SAFE",
  "SUSPICIOUS",
  "HIGH RISK",
  "CONFIRMED HONEYPOT",
]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function optionalNonNegativeNumber(v: unknown, field: string, errors: string[]): number | null {
  if (v === undefined || v === null) return null;
  if (!isFiniteNumber(v) || v < 0) {
    errors.push(`${field} must be a non-negative number`);
    return null;
  }
  return v;
}

function optionalPercent(v: unknown, field: string, errors: string[]): number | null {
  if (v === undefined || v === null) return null;
  if (!isFiniteNumber(v) || v < 0 || v > 100) {
    errors.push(`${field} must be a number between 0 and 100`);
    return null;
  }
  return v;
}

function optionalString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function optionalBool(v: unknown, field: string, errors: string[]): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v !== "boolean") {
    errors.push(`${field} must be a boolean`);
    return false;
  }
  return v;
}

/**
 * Validates and normalizes an incoming scan-result payload into a
 * scan_history row. Returns { row } on success or { errors } on failure —
 * never throws, so the caller can always respond with a clean 400.
 */
function buildRow(body: Record<string, unknown>): { row?: Record<string, unknown>; errors: string[] } {
  const errors: string[] = [];

  const tokenAddress = body.token_address;
  if (typeof tokenAddress !== "string" || tokenAddress.length < 32 || tokenAddress.length > 64) {
    errors.push("token_address must be a valid Solana address string");
  }

  const riskScore = body.risk_score;
  if (!isFiniteNumber(riskScore) || riskScore < 0 || riskScore > 100) {
    errors.push("risk_score must be a number between 0 and 100");
  }

  const riskLevel = body.risk_level;
  if (typeof riskLevel !== "string" || !RISK_LEVELS.has(riskLevel)) {
    errors.push(`risk_level must be one of: ${Array.from(RISK_LEVELS).join(", ")}`);
  }

  const honeyPotStatus = body.honey_pot_status;
  if (typeof honeyPotStatus !== "string" || !HONEY_POT_STATUSES.has(honeyPotStatus)) {
    errors.push(`honey_pot_status must be one of: ${Array.from(HONEY_POT_STATUSES).join(", ")}`);
  }

  if (errors.length > 0) return { errors };

  const row: Record<string, unknown> = {
    token_address: tokenAddress,
    token_name: optionalString(body.token_name),
    token_symbol: optionalString(body.token_symbol),
    risk_score: riskScore,
    risk_level: riskLevel,
    honey_pot_status: honeyPotStatus,
    mint_authority: optionalString(body.mint_authority),
    freeze_authority: optionalString(body.freeze_authority),
    liquidity: optionalNonNegativeNumber(body.liquidity, "liquidity", errors),
    lp_status: optionalString(body.lp_status),
    lp_lock_days: optionalNonNegativeNumber(body.lp_lock_days, "lp_lock_days", errors),
    market_cap: optionalNonNegativeNumber(body.market_cap, "market_cap", errors),
    fdv: optionalNonNegativeNumber(body.fdv, "fdv", errors),
    volume_24h: optionalNonNegativeNumber(body.volume_24h, "volume_24h", errors),
    holder_count: optionalNonNegativeNumber(body.holder_count, "holder_count", errors),
    top_holder_pct: optionalPercent(body.top_holder_pct, "top_holder_pct", errors),
    sniper_wallets: optionalNonNegativeNumber(body.sniper_wallets, "sniper_wallets", errors),
    sniper_pct: optionalPercent(body.sniper_pct, "sniper_pct", errors),
    image_url: optionalString(body.image_url),
    is_authority_transitioned: optionalBool(body.is_authority_transitioned, "is_authority_transitioned", errors),
    is_account_resized: optionalBool(body.is_account_resized, "is_account_resized", errors),
    metadata_update_authority: optionalString(body.metadata_update_authority),
    is_metadata_mutable: optionalBool(body.is_metadata_mutable, "is_metadata_mutable", errors),
    is_metadata_hijacked: optionalBool(body.is_metadata_hijacked, "is_metadata_hijacked", errors),
    developer_wallet: optionalString(body.developer_wallet),
    developer_classification: optionalString(body.developer_classification),
    is_path_obfuscated: optionalBool(body.is_path_obfuscated, "is_path_obfuscated", errors),
    cpi_depth: optionalNonNegativeNumber(body.cpi_depth, "cpi_depth", errors) ?? 0,
    is_cpi_manipulated: optionalBool(body.is_cpi_manipulated, "is_cpi_manipulated", errors),
    cpi_risk_details: optionalString(body.cpi_risk_details),
    is_state_hijacked: optionalBool(body.is_state_hijacked, "is_state_hijacked", errors),
    state_hijack_details: optionalString(body.state_hijack_details),
    is_atomic_exploit: optionalBool(body.is_atomic_exploit, "is_atomic_exploit", errors),
    atomic_exploit_details: optionalString(body.atomic_exploit_details),
    has_non_rent_exempt_accounts: optionalBool(body.has_non_rent_exempt_accounts, "has_non_rent_exempt_accounts", errors),
  };

  if (errors.length > 0) return { errors };
  return { row, errors: [] };
}

export async function handleScanHistoryPost(request: Request): Promise<Response> {
  if (!isAllowedOrigin(request)) {
    console.warn(`${LOG} Rejected — origin/referer did not match ALLOWED_ORIGIN`);
    return json({ ok: false, error: "Forbidden" }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const { row, errors } = buildRow(body);
  if (!row) {
    console.warn(`${LOG} Rejected invalid scan payload:`, errors);
    return json({ ok: false, error: "Validation failed", details: errors }, 400);
  }

  if (await isRateLimited(row.token_address as string)) {
    console.warn(`${LOG} Rate limited — token=${(row.token_address as string).slice(0, 8)}…`);
    return json({ ok: false, error: "Too many requests for this token, try again shortly" }, 429);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await supabaseAdmin.from("scan_history").insert(row as any);
  if (error) {
    console.error(`${LOG} Insert failed: ${error.message}`);
    return json({ ok: false, error: error.message }, 500);
  }

  return json({ ok: true });
}

export function handleScanHistoryGet(): Response {
  return json({
    ok: true,
    route: "/api/scan-history",
    method: "POST (GET returns this help message)",
    purpose:
      "Server-validated write path for scan_history. Replaces the old direct " +
      "anon-key insert from the browser (audit finding #4) — every field is " +
      "range/type checked here before hitting the database.",
    body: "ScanResult-shaped JSON — see src/lib/scan-history.ts recordScan()",
  });
}
