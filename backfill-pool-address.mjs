#!/usr/bin/env node
/**
 * backfill-pool-address.mjs
 *
 * Re-queues wallet collection jobs for tokens whose original job completed
 * with pool_address = NULL (Root Cause #1 from the sell-tracking gap).
 *
 * WHAT IT DOES
 *   1. Finds all wallet_collection_jobs where pool_address IS NULL and
 *      status IN ('done', 'failed').
 *   2. Derives the Pump.fun bonding curve PDA deterministically from each
 *      token_address (same algorithm as deriveBondingCurvePDA in token-discovery.ts).
 *   3. Inserts a NEW 'pending' job with pool_address set, preserving
 *      market_cap_usd and liquidity_usd from the original job.
 *   4. Skips any token that already has a job (in any status) with a non-null
 *      pool_address — so re-runs are fully safe.
 *
 * WHY NEW ROWS, NOT UPDATES
 *   The old completed rows are kept intact as audit history.
 *   The worker picks up the new pending rows on its next cron tick.
 *
 * REQUIRED ENV VARS
 *   SUPABASE_URL=https://xxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY=eyJ...
 *
 * OPTIONAL
 *   DRY_RUN=true    — preview what would be inserted, without writing (default: false)
 *   BATCH_SIZE=50   — rows per Supabase page fetch (default: 50)
 *
 * USAGE
 *   node --env-file=.env backfill-pool-address.mjs
 *   DRY_RUN=true node --env-file=.env backfill-pool-address.mjs
 *
 * IDEMPOTENT — safe to re-run at any time.
 */

import { createHash } from "crypto";

// ─── Config ───────────────────────────────────────────────────────────────────

const SUPABASE_URL              = process.env.SUPABASE_URL ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const DRY_RUN                   = process.env.DRY_RUN === "true";
const BATCH_SIZE                = Math.max(1, parseInt(process.env.BATCH_SIZE ?? "50", 10));

const PUMPFUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌  Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

// ─── Supabase REST helpers (no SDK dependency) ────────────────────────────────

const SB_HEADERS = {
  "apikey":        SUPABASE_SERVICE_ROLE_KEY,
  "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  "Content-Type":  "application/json",
  "Prefer":        "return=representation",
};

async function sbGet(path, params = {}) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { headers: SB_HEADERS });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Returns the total count of rows matching the given params.
 * Throws on network/auth errors — never silently returns 0 on failure.
 */
async function sbCount(path, params = {}) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("select", "id");
  const res = await fetch(url.toString(), {
    headers: { ...SB_HEADERS, "Prefer": "count=exact", "Range": "0-0" },
  });
  if (!res.ok) throw new Error(`COUNT ${path} failed: ${res.status} ${await res.text()}`);
  const countHeader = res.headers.get("Content-Range") ?? "";
  const total = parseInt(countHeader.split("/")[1] ?? "", 10);
  if (Number.isNaN(total)) throw new Error(`COUNT ${path}: unexpected Content-Range header: "${countHeader}"`);
  return total;
}

async function sbInsert(table, row) {
  const url = `${SUPABASE_URL}/rest/v1/${table}`;
  const res = await fetch(url, {
    method:  "POST",
    headers: SB_HEADERS,
    body:    JSON.stringify(row),
  });
  if (!res.ok) {
    const body = await res.text();
    // 23505 = unique constraint violation — treat as idempotent duplicate
    if (res.status === 409 || body.includes("23505")) return "duplicate";
    throw new Error(`INSERT ${table} failed: ${res.status} ${body}`);
  }
  return "inserted";
}

// ─── Pump.fun bonding curve PDA derivation ────────────────────────────────────
//
// Exact port of deriveBondingCurvePDA() from src/lib/api/token-discovery.ts.
//
// Solana PDA algorithm (findProgramAddressSync):
//   for nonce = 255 down to 0:
//     candidate = SHA256(seed1 || ... || seedN || [nonce] || program_id_bytes
//                        || "ProgramDerivedAddress")
//     if candidate is NOT a valid ed25519 point → that is the PDA
//
// For Pump.fun bonding curves: seeds = ["bonding-curve", mint_bytes]

const _ED_P = (1n << 255n) - 19n;
const _ED_D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;

function _modpow(b, e, m) {
  let r = 1n; b = ((b % m) + m) % m;
  for (; e > 0n; e >>= 1n) { if (e & 1n) r = r * b % m; b = b * b % m; }
  return r;
}

/** Returns true if the 32-byte buffer is a valid ed25519 curve point. */
function _isOnCurve(h) {
  const arr = Buffer.from(h); arr[31] &= 0x7f;
  let y = 0n;
  for (let i = 0; i < 32; i++) y |= BigInt(arr[i]) << BigInt(8 * i);
  if (y >= _ED_P) return false;
  const y2 = y * y % _ED_P;
  const u  = (y2 - 1n + _ED_P) % _ED_P;
  const v  = (_ED_D * y2 % _ED_P + 1n) % _ED_P;
  if (v === 0n) return u === 0n;
  const uv = u * _modpow(v, _ED_P - 2n, _ED_P) % _ED_P;
  if (uv === 0n) return true;
  return _modpow(uv, (_ED_P - 1n) / 2n, _ED_P) === 1n;
}

const _B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const _B58MAP = Object.fromEntries(_B58.split("").map((c, i) => [c, i]));

function _b58decode(s) {
  let n = 0n;
  for (const c of s) {
    const d = _B58MAP[c];
    if (d === undefined) throw new Error(`invalid base58 char: ${c}`);
    n = n * 58n + BigInt(d);
  }
  let z = 0; for (const c of s) { if (c !== "1") break; z++; }
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n; }
  return Buffer.from([...new Array(z).fill(0), ...out]);
}

function _b58encode(buf) {
  let n = 0n;
  for (const b of buf) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) { s = _B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b !== 0) break; s = "1" + s; }
  return s;
}

/**
 * Derive the Pump.fun bonding curve PDA for a mint address.
 *
 * Returns null if:
 *   - base58 decoding fails (invalid address characters)
 *   - decoded key length is not exactly 32 bytes (malformed mint — matches
 *     Solana SDK PublicKey validation which rejects non-32-byte keys)
 *   - all 256 nonces are exhausted (astronomically unlikely)
 */
function deriveBondingCurvePDA(mintAddress) {
  try {
    const mint      = _b58decode(mintAddress);
    const programId = _b58decode(PUMPFUN_PROGRAM_ID);
    // Enforce 32-byte key length, matching Solana SDK PublicKey constraints
    if (mint.length !== 32 || programId.length !== 32) return null;
    const seed = Buffer.from("bonding-curve");
    for (let nonce = 255; nonce >= 0; nonce--) {
      const h = createHash("sha256").update(
        Buffer.concat([seed, mint, Buffer.from([nonce]), programId, Buffer.from("ProgramDerivedAddress")]),
      ).digest();
      if (!_isOnCurve(h)) return _b58encode(h);
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmt(ms) {
  if (ms < 1_000)  return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  return `${m}m ${s}s`;
}

function bar(done, total, width = 24) {
  const pct    = total > 0 ? done / total : 0;
  const filled = Math.round(pct * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}] ${(pct * 100).toFixed(1)}%`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const DIVIDER = "═".repeat(68);
  console.log(DIVIDER);
  console.log("  backfill-pool-address — re-queue jobs with pool_address = NULL");
  if (DRY_RUN) console.log("  ⚠️  DRY RUN — no rows will be written");
  console.log(DIVIDER);
  console.log();

  // ── Count target rows (throws on auth/network failure) ────────────────────
  let total;
  try {
    total = await sbCount("wallet_collection_jobs", {
      "pool_address": "is.null",
      "status":       "in.(done,failed)",
    });
  } catch (err) {
    console.error(`❌  Could not count target rows: ${err.message}`);
    console.error("    Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }

  if (total === 0) {
    console.log("✅  Nothing to do — no completed jobs with pool_address = NULL found.");
    return;
  }

  // Count how many distinct tokens already have a non-null pool_address job
  // (used for the progress summary only — skip logic is token-level inside the loop)
  let alreadyFixed = 0;
  try {
    alreadyFixed = await sbCount("wallet_collection_jobs", {
      "pool_address": "not.is.null",
      "status":       "eq.pending",
    });
  } catch { /* non-fatal — just a display hint */ }

  console.log(`📊  Completed jobs with pool_address = NULL : ${total}`);
  console.log(`📊  Existing pending jobs with pool_address : ${alreadyFixed} (will be skipped)`);
  console.log(`📦  Batch size          : ${BATCH_SIZE}`);
  console.log(`🔑  Pump program        : ${PUMPFUN_PROGRAM_ID}`);
  console.log();

  const stats = {
    scanned:    0,
    enqueued:   0,
    skipped:    0,  // already has any job with non-null pool_address
    pdaFailed:  0,  // PDA derivation returned null
    dbDup:      0,  // unique constraint hit on insert
    failed:     0,  // unexpected errors
    startMs:    Date.now(),
  };

  const failLog = [];

  // Keyset pagination on (enqueued_at, id) — immune to concurrent row mutations
  // because we never update the rows we're reading (we only insert new ones).
  let lastEnqueuedAt = "1970-01-01T00:00:00.000Z";
  let lastId         = "00000000-0000-0000-0000-000000000000";

  while (true) {
    // Fetch next page using keyset: (enqueued_at, id) > (lastEnqueuedAt, lastId)
    let rows;
    try {
      rows = await sbGet("wallet_collection_jobs", {
        "select":        "id,token_address,market_cap_usd,liquidity_usd,enqueued_at",
        "pool_address":  "is.null",
        "status":        "in.(done,failed)",
        // Keyset: rows strictly after the last-seen (enqueued_at, id) pair
        "or":            `(enqueued_at.gt.${lastEnqueuedAt},and(enqueued_at.eq.${lastEnqueuedAt},id.gt.${lastId}))`,
        "order":         "enqueued_at.asc,id.asc",
        "limit":         String(BATCH_SIZE),
      });
    } catch (err) {
      console.error(`❌  Fetch failed: ${err.message}`);
      stats.failed++;
      break;
    }

    if (!Array.isArray(rows) || rows.length === 0) break;

    for (const row of rows) {
      stats.scanned++;
      const token = row.token_address;

      // ── Durable idempotency: skip if this token already has ANY job
      //    with a non-null pool_address (in any status — not just pending).
      //    This makes re-runs safe even after previously backfilled jobs
      //    cycle through pending → done/failed again.
      let existingWithPool;
      try {
        existingWithPool = await sbGet("wallet_collection_jobs", {
          "select":        "id",
          "token_address": `eq.${token}`,
          "pool_address":  "not.is.null",
          "limit":         "1",
        });
      } catch (err) {
        stats.failed++;
        failLog.push({ token: token.slice(0, 8) + "…", reason: `check_existing: ${err.message}` });
        continue;
      }

      if (Array.isArray(existingWithPool) && existingWithPool.length > 0) {
        stats.skipped++;
        continue;
      }

      // ── Derive PDA ────────────────────────────────────────────────────
      const pda = deriveBondingCurvePDA(token);
      if (!pda) {
        stats.pdaFailed++;
        failLog.push({ token: token.slice(0, 8) + "…", reason: "PDA derivation failed (invalid mint or non-32-byte key)" });
        continue;
      }

      // ── Insert new pending job ────────────────────────────────────────
      if (DRY_RUN) {
        console.log(`  [DRY] would enqueue ${token.slice(0, 8)}… → pool ${pda.slice(0, 8)}…`);
        stats.enqueued++;
        continue;
      }

      try {
        const outcome = await sbInsert("wallet_collection_jobs", {
          token_address:  token,
          pool_address:   pda,
          status:         "pending",
          enqueued_at:    new Date().toISOString(),
          market_cap_usd: row.market_cap_usd ?? null,
          liquidity_usd:  row.liquidity_usd  ?? null,
        });
        if (outcome === "duplicate") {
          stats.dbDup++;
        } else {
          stats.enqueued++;
        }
      } catch (err) {
        stats.failed++;
        failLog.push({ token: token.slice(0, 8) + "…", reason: `insert: ${err.message}` });
      }

      // Brief pause between inserts to avoid hammering the Supabase REST API
      await sleep(80);
    }

    // Progress after each page
    console.log(
      `  ${bar(stats.scanned, total)} ` +
      `scanned=${stats.scanned}/${total} ` +
      `enqueued=${stats.enqueued} ` +
      `skipped=${stats.skipped} ` +
      `pda_fail=${stats.pdaFailed} ` +
      `err=${stats.failed}`,
    );

    // Advance keyset cursor
    const last = rows[rows.length - 1];
    lastEnqueuedAt = last.enqueued_at;
    lastId         = last.id;

    if (rows.length < BATCH_SIZE) break; // reached the last page
  }

  // ── Final report ───────────────────────────────────────────────────────────
  const elapsed = Date.now() - stats.startMs;
  console.log();
  console.log(DIVIDER);
  console.log("  COMPLETE" + (DRY_RUN ? " (DRY RUN — nothing written)" : ""));
  console.log(DIVIDER);
  console.log(`  Jobs scanned                        : ${stats.scanned}`);
  console.log(`  New pending jobs inserted            : ${stats.enqueued}${DRY_RUN ? " (would insert)" : ""}`);
  console.log(`  Skipped (already has pool_address)  : ${stats.skipped + stats.dbDup}`);
  console.log(`  PDA derivation failed (bad mint?)   : ${stats.pdaFailed}`);
  console.log(`  Errors                              : ${stats.failed}`);
  console.log(`  Runtime                             : ${fmt(elapsed)}`);

  if (failLog.length > 0) {
    console.log();
    console.log(`  Failures (${failLog.length}):`);
    failLog.slice(0, 30).forEach((f) => console.log(`    • ${f.token}  ${f.reason}`));
    if (failLog.length > 30) console.log(`    … and ${failLog.length - 30} more`);
  }

  if (!DRY_RUN && stats.enqueued > 0) {
    console.log();
    console.log(`  ✅  ${stats.enqueued} new pending jobs created.`);
    console.log("      The /api/process-jobs cron will pick them up within 30 seconds.");
    console.log("      Each job will now run Steps 1-2 (pool tx scan) since pool_address is set.");
    console.log("      Sellers will be collected and wallet_performance_history will be updated.");
  }

  console.log(DIVIDER);
}

main().catch((err) => {
  console.error("❌  Fatal:", err.message ?? err);
  process.exit(1);
});
