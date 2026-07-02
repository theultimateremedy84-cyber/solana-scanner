#!/usr/bin/env node
/**
 * backfill-wallet-activity.mjs
 *
 * Retroactively populates `amount_usd` and `token_age_at_entry` for all rows
 * in wallet_token_activity where these fields are NULL.
 *
 * Rules:
 *   - amount_usd   : amount_sol × HISTORICAL SOL/USD price (CoinGecko /history)
 *   - token_age_at_entry : trade_timestamp − token_creation_timestamp (seconds)
 *   - Never overwrites already-populated values
 *   - Never writes a value when the source data is unavailable — leaves NULL + logs
 *   - Idempotent: safe to re-run
 *   - Processes in batches of 100, commits each batch independently
 *
 * Required env vars:
 *   SUPABASE_URL=https://xxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY=eyJ...
 *
 * Optional:
 *   HELIUS_API_KEY=...   (fallback for token creation time)
 *   BATCH_SIZE=100       (override default)
 *
 * Usage:
 *   node backfill-wallet-activity.mjs
 *
 * Recommended — run with env file:
 *   node --env-file=.env backfill-wallet-activity.mjs
 */

// ─── Bootstrap ───────────────────────────────────────────────────────────────

const SUPABASE_URL              = process.env.SUPABASE_URL ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const HELIUS_API_KEY            = process.env.HELIUS_API_KEY ?? "";
const BATCH_SIZE                = parseInt(process.env.BATCH_SIZE ?? "100", 10);

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

async function sbSelect(table, params = {}) {
  const url  = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res  = await fetch(url.toString(), { headers: SB_HEADERS });
  if (!res.ok) throw new Error(`Supabase SELECT failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function sbCount(table, filter) {
  const url  = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  url.searchParams.set("select", "id");
  if (filter) url.searchParams.set("or", filter);
  const res  = await fetch(url.toString(), {
    headers: { ...SB_HEADERS, "Prefer": "count=exact", "Range": "0-0" },
  });
  const countHeader = res.headers.get("Content-Range");
  const total = countHeader ? parseInt(countHeader.split("/")[1] ?? "0", 10) : 0;
  return total;
}

async function sbUpdate(table, id, fields) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`;
  const res = await fetch(url, {
    method:  "PATCH",
    headers: SB_HEADERS,
    body:    JSON.stringify(fields),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase UPDATE id=${id} failed: ${res.status} ${body}`);
  }
}

/** Check whether a column exists in the given table via information_schema. */
async function columnExists(table, column) {
  try {
    const url = new URL(`${SUPABASE_URL}/rest/v1/rpc/column_exists`);
    // Supabase doesn't expose information_schema via REST by default.
    // We probe by attempting a minimal select of the column.
    const probeUrl = `${SUPABASE_URL}/rest/v1/${table}?select=${column}&limit=1`;
    const res = await fetch(probeUrl, { headers: SB_HEADERS });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Caches ───────────────────────────────────────────────────────────────────

/** "DD-MM-YYYY" → number (SOL/USD) | null */
const solPriceByDay = new Map();

/** tokenAddress → number (unix seconds) | null */
const tokenCreatedAtByMint = new Map();

// ─── CoinGecko historical SOL/USD price ───────────────────────────────────────

/**
 * Returns the daily-close SOL/USD price for the UTC calendar day of
 * `isoTimestamp`, or null if CoinGecko cannot supply it.
 *
 * Respects the free-tier rate limit (~30 req/min) by sleeping 2 s between
 * actual API calls. Cache eliminates redundant calls for the same day.
 */
async function getHistoricalSolPrice(isoTimestamp) {
  const d    = new Date(isoTimestamp);
  const day  = String(d.getUTCDate()).padStart(2, "0");
  const mon  = String(d.getUTCMonth() + 1).padStart(2, "0");
  const year = d.getUTCFullYear();
  const key  = `${day}-${mon}-${year}`;

  if (solPriceByDay.has(key)) return solPriceByDay.get(key);

  // Rate-limit: 2 s between unique-day fetches keeps us well within 30/min
  await sleep(2_000);

  try {
    const url = `https://api.coingecko.com/api/v3/coins/solana/history?date=${key}&localization=false`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });

    if (res.status === 429) {
      console.warn(`  ⚠  CoinGecko rate-limited for ${key}; sleeping 60 s…`);
      await sleep(60_000);
      solPriceByDay.set(key, null);
      return null;
    }

    if (!res.ok) {
      console.warn(`  ⚠  CoinGecko ${res.status} for ${key} — will leave amount_usd NULL`);
      solPriceByDay.set(key, null);
      return null;
    }

    const json  = await res.json();
    const price = json?.market_data?.current_price?.usd ?? null;

    if (price == null) {
      console.warn(`  ⚠  CoinGecko returned no USD price for ${key}`);
    }

    solPriceByDay.set(key, price);
    return price;
  } catch (err) {
    console.warn(`  ⚠  CoinGecko fetch error for ${key}: ${err.message}`);
    solPriceByDay.set(key, null);
    return null;
  }
}

// ─── Token creation time ──────────────────────────────────────────────────────

/**
 * Returns the Unix timestamp (seconds) when the token was created,
 * or null if neither Pump.fun nor Helius can supply it.
 *
 * Strategy:
 *   1. Pump.fun frontend API  (fast, no API key, works for all .pump tokens)
 *   2. Helius getAsset DAS    (fallback, requires HELIUS_API_KEY)
 */
async function getTokenCreatedAt(tokenAddress) {
  if (tokenCreatedAtByMint.has(tokenAddress)) return tokenCreatedAtByMint.get(tokenAddress);

  // ── Attempt 1: Pump.fun ──────────────────────────────────────────────────
  try {
    const res = await fetch(
      `https://frontend-api.pump.fun/coins/${tokenAddress}`,
      { signal: AbortSignal.timeout(8_000) },
    );
    if (res.ok) {
      const json = await res.json();
      if (typeof json.created_timestamp === "number" && json.created_timestamp > 0) {
        const created = Math.floor(json.created_timestamp / 1000); // ms → s
        tokenCreatedAtByMint.set(tokenAddress, created);
        return created;
      }
    }
  } catch { /* fall through */ }

  // ── Attempt 2: Helius DAS getAsset ──────────────────────────────────────
  if (HELIUS_API_KEY) {
    try {
      const res = await fetch(
        `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`,
        {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({
            jsonrpc: "2.0",
            id:      "backfill-get-asset",
            method:  "getAsset",
            params:  { id: tokenAddress },
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      const json     = await res.json();
      const created  = json?.result?.created_at;
      if (typeof created === "number" && created > 0) {
        tokenCreatedAtByMint.set(tokenAddress, created);
        return created;
      }
    } catch { /* non-fatal */ }
  }

  tokenCreatedAtByMint.set(tokenAddress, null);
  return null;
}

// ─── Utility ─────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function fmt(ms) {
  if (ms < 1_000)    return `${ms}ms`;
  if (ms < 60_000)   return `${(ms / 1_000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  return `${m}m ${s}s`;
}

function bar(done, total, width = 20) {
  const pct   = total > 0 ? done / total : 0;
  const filled = Math.round(pct * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}] ${(pct * 100).toFixed(1)}%`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const DIVIDER = "═".repeat(65);
  console.log(DIVIDER);
  console.log("  wallet_token_activity — Historical Backfill");
  console.log("  Fields: amount_usd  ·  token_age_at_entry");
  console.log(DIVIDER);
  console.log();

  // ── Schema check: does sol_price_usd_at_trade column exist? ───────────────
  const hasSolPriceCol = await columnExists("wallet_token_activity", "sol_price_usd_at_trade");
  if (hasSolPriceCol) {
    console.log("✅  Column sol_price_usd_at_trade detected — will populate it.");
  } else {
    console.log(
      "ℹ️   Column sol_price_usd_at_trade does not exist.\n" +
      "    Recommendation: add it with:\n" +
      "      ALTER TABLE wallet_token_activity\n" +
      "        ADD COLUMN IF NOT EXISTS sol_price_usd_at_trade NUMERIC;\n" +
      "    Re-run this script after adding it to store the historical rate used.\n",
    );
  }

  // ── Count rows requiring work ──────────────────────────────────────────────
  const totalUrl = new URL(`${SUPABASE_URL}/rest/v1/wallet_token_activity`);
  totalUrl.searchParams.set("select", "id");
  totalUrl.searchParams.set("or", "(amount_usd.is.null,token_age_at_entry.is.null)");
  const totalRes = await fetch(totalUrl.toString(), {
    headers: { ...SB_HEADERS, "Prefer": "count=exact", "Range-Unit": "items", "Range": "0-0" },
  });
  const rangeHeader = totalRes.headers.get("Content-Range") ?? "";
  const total = parseInt(rangeHeader.split("/")[1] ?? "0", 10) || 0;

  console.log(`📊  Rows needing update : ${total}`);
  console.log(`📦  Batch size          : ${BATCH_SIZE}`);
  console.log(`📅  SOL prices          : CoinGecko historical /history (2 s between unique days)`);
  console.log(`🔍  Token creation      : Pump.fun${HELIUS_API_KEY ? " → Helius fallback" : " (no Helius key)"}`);
  console.log();

  if (total === 0) {
    console.log("✅  Nothing to do — all rows already populated.");
    return;
  }

  // ── Stats ──────────────────────────────────────────────────────────────────
  const stats = {
    scanned:    0,
    usdUpdated: 0,
    ageUpdated: 0,
    failed:     0,
    skipped:    0,
    startMs:    Date.now(),
    batchMs:    [],
  };

  /** Rows that could not be updated — logged at the end */
  const failLog = [];

  /** IDs processed in this run (guards against infinite loop on persistent failures) */
  const processedIds = new Set();

  let batchNum = 0;

  // ── Main loop ──────────────────────────────────────────────────────────────
  // We always fetch from offset 0 because successfully updated rows fall out
  // of the WHERE filter, so the "window" automatically advances.
  // Rows that fail remain in the set; processedIds prevents re-processing them.

  while (true) {
    batchNum++;
    const batchStart = Date.now();

    // Fetch next batch of NULL rows (excluding already-processed-this-run IDs)
    const fetchUrl = new URL(`${SUPABASE_URL}/rest/v1/wallet_token_activity`);
    fetchUrl.searchParams.set(
      "select",
      "id,wallet_address,token_address,amount_sol,timestamp,amount_usd,token_age_at_entry",
    );
    fetchUrl.searchParams.set("or", "(amount_usd.is.null,token_age_at_entry.is.null)");
    fetchUrl.searchParams.set("order", "timestamp.asc");
    fetchUrl.searchParams.set("limit", String(BATCH_SIZE));

    const fetchRes = await fetch(fetchUrl.toString(), { headers: SB_HEADERS });
    if (!fetchRes.ok) {
      console.error(`❌  Fetch failed (batch ${batchNum}): ${fetchRes.status} ${await fetchRes.text()}`);
      break;
    }

    const allRows = await fetchRes.json();
    // Filter out IDs we already tried this run (failed rows stay in DB)
    const rows = allRows.filter(r => !processedIds.has(r.id));

    if (rows.length === 0) break; // nothing left to process

    // ── Process each row in the batch ─────────────────────────────────────
    for (const row of rows) {
      processedIds.add(row.id);
      stats.scanned++;

      const update = {};
      let anyFailure = false;

      // ── amount_usd ────────────────────────────────────────────────────
      if (row.amount_usd == null) {
        if (row.amount_sol == null || row.amount_sol <= 0) {
          // No SOL amount — nothing to compute; skip silently
          stats.skipped++;
        } else {
          const solPrice = await getHistoricalSolPrice(row.timestamp);
          if (solPrice != null) {
            update.amount_usd = Math.round(row.amount_sol * solPrice * 100) / 100;
            if (hasSolPriceCol) update.sol_price_usd_at_trade = solPrice;
          } else {
            anyFailure = true;
            failLog.push({
              id:     row.id,
              field:  "amount_usd",
              reason: `no_sol_price for ${row.timestamp.slice(0, 10)}`,
            });
          }
        }
      }

      // ── token_age_at_entry ────────────────────────────────────────────
      if (row.token_age_at_entry == null) {
        const tradeSec     = Math.floor(new Date(row.timestamp).getTime() / 1_000);
        const tokenCreated = await getTokenCreatedAt(row.token_address);
        if (tokenCreated != null) {
          update.token_age_at_entry = Math.max(0, tradeSec - tokenCreated);
        } else {
          anyFailure = true;
          failLog.push({
            id:     row.id,
            field:  "token_age_at_entry",
            reason: `no_creation_time for ${row.token_address.slice(0, 8)}…`,
          });
        }
      }

      // ── Write (only if we have at least one field to set) ─────────────
      if (Object.keys(update).length === 0) {
        if (anyFailure) stats.failed++;
        // else already-populated — shouldn't happen given filter, but safe
        continue;
      }

      try {
        await sbUpdate("wallet_token_activity", row.id, update);
        if (update.amount_usd            != null) stats.usdUpdated++;
        if (update.token_age_at_entry    != null) stats.ageUpdated++;
        if (anyFailure)                           stats.failed++;   // partial update
      } catch (err) {
        stats.failed++;
        failLog.push({ id: row.id, field: "update", reason: err.message });
      }
    }

    // ── Batch progress report ─────────────────────────────────────────────
    const batchElapsed = Date.now() - batchStart;
    stats.batchMs.push(batchElapsed);

    const avgMs     = stats.batchMs.reduce((a, b) => a + b, 0) / stats.batchMs.length;
    const remaining = total - stats.scanned;
    const etaMs     = remaining > 0 ? (remaining / BATCH_SIZE) * avgMs : 0;

    console.log(
      `Batch ${String(batchNum).padStart(3)} ${bar(stats.scanned, total)} ` +
      `scanned=${stats.scanned}/${total} ` +
      `usd_upd=${stats.usdUpdated} ` +
      `age_upd=${stats.ageUpdated} ` +
      `failed=${stats.failed} ` +
      `skip=${stats.skipped} ` +
      `ETA=${fmt(Math.round(etaMs))}`,
    );

    // Stop if we've processed everything in the DB (all rows either updated or failed)
    if (stats.scanned >= total) break;
  }

  // ── Final report ───────────────────────────────────────────────────────────
  const totalMs = Date.now() - stats.startMs;
  const avgBatch =
    stats.batchMs.length > 0
      ? stats.batchMs.reduce((a, b) => a + b, 0) / stats.batchMs.length
      : 0;

  console.log();
  console.log(DIVIDER);
  console.log("  BACKFILL COMPLETE");
  console.log(DIVIDER);
  console.log(`  Total rows scanned          : ${stats.scanned}`);
  console.log(`  amount_usd updated          : ${stats.usdUpdated}`);
  console.log(`  token_age_at_entry updated  : ${stats.ageUpdated}`);
  console.log(`  Skipped (amount_sol = 0)    : ${stats.skipped}`);
  console.log(`  Failed (no source data)     : ${stats.failed}`);
  console.log(`  Unique days fetched from CG : ${solPriceByDay.size}`);
  console.log(`  Unique tokens fetched       : ${tokenCreatedAtByMint.size}`);
  console.log(`  Avg time per batch          : ${fmt(Math.round(avgBatch))}`);
  console.log(`  Total runtime               : ${fmt(totalMs)}`);

  if (failLog.length > 0) {
    console.log();
    console.log(`  Failures (${failLog.length} rows — amount_usd / token_age_at_entry left NULL):`);
    const shown = failLog.slice(0, 30);
    shown.forEach(f => console.log(`    • id=${f.id}  field=${f.field}  reason=${f.reason}`));
    if (failLog.length > 30) {
      console.log(`    … and ${failLog.length - 30} more`);
    }
  }

  if (!hasSolPriceCol) {
    console.log();
    console.log(
      "  💡 To preserve the historical rate used per trade, add:\n" +
      "       ALTER TABLE wallet_token_activity\n" +
      "         ADD COLUMN IF NOT EXISTS sol_price_usd_at_trade NUMERIC;\n" +
      "     Then re-run this script — it will populate the new column.",
    );
  }

  console.log(DIVIDER);
  console.log();
}

main().catch(err => {
  console.error("❌  Fatal:", err.message ?? err);
  process.exit(1);
});
