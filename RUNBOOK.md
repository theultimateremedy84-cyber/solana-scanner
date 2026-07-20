# Solana Scanner — Operations Runbook

> **Last updated:** July 20, 2026 (second audit pass)
> This document is the authoritative reference for running all maintenance and
> backfill scripts. Read it fully before running anything in production.

---

## Quick Reference — Script Execution Order

When running scripts as part of the second-audit fix batch, **always follow this
exact order**. Each script depends on the outputs of the one above it.

```
1. supabase/migrations/20260720000008_roi_null_backfill.sql  ← SQL, run in Dashboard
2. bun scripts/fix-roi-backfill.ts
3. bun scripts/audit-rescore-v2.ts
4. bun scripts/fix-classification-promotion.ts
5. node backfill-pool-address.mjs
6. node backfill-wallet-activity.mjs                         ← ~30-40 min
7. bun scripts/verify-audit-fixes.ts                         ← confirm all clean
```

Railway deploy (scan `risk_score` fix) is a separate production action — do it
any time, it doesn't depend on the scripts above.

---

## Script Reference

### `supabase/migrations/20260720000008_roi_null_backfill.sql`

**What it does:** Backfills `roi_multiple` and `realized_profit` for 54,552
CLOSED positions that had investment data but no ROI (they were recorded as CLOSED
before the enricher started writing ROI).

**Run in:** Supabase Dashboard → SQL Editor → paste and run.

**Must run before:** `fix-roi-backfill.ts` (which re-aggregates PnL) and
`fix-classification-promotion.ts` (whale promotion needs accurate PnL).

**Idempotent:** Yes — `WHERE roi_multiple IS NULL` prevents double-writes.

---

### `scripts/fix-roi-backfill.ts`

**What it does:**
1. Loads all CLOSED positions with null `roi_multiple` and `initial_investment > 0`
2. Computes and writes `roi_multiple` and `realized_profit`
3. Re-aggregates `realized_pnl` per wallet into the `wallets` table

**Run as:** `bun scripts/fix-roi-backfill.ts`

**Must run after:** `20260720000008_roi_null_backfill.sql` (SQL migration handles
bulk update; this script handles anything the SQL missed and re-aggregates PnL)

**Must run before:** `fix-classification-promotion.ts` (whale promotion gate
requires accurate `realized_pnl`)

**Idempotent:** Yes.

---

### `scripts/audit-rescore-v2.ts`

**What it does:** Re-scores all wallets using the v7 scoring formula with an
audit gate of ≥ 3 real closed exits. Wallets below the gate get `intelligence_score = null`.

**Run as:** `bun scripts/audit-rescore-v2.ts`

**Must run after:** `fix-roi-backfill.ts` — `roi_multiple` per position feeds
directly into `average_roi` and `win_rate` calculations.

**Must run before:** `fix-classification-promotion.ts` — promotion rules read
`intelligence_score`, `win_rate`, and `average_roi`.

**Idempotent:** Yes — upserts on `wallet_address`.

**Resume:** Accepts `<startOffset> <endOffset>` args to process a window:
```bash
bun scripts/audit-rescore-v2.ts 0 10000
bun scripts/audit-rescore-v2.ts 10000 20000
```

---

### `scripts/fix-classification-promotion.ts`

**What it does:** Promotes wallets from `unknown` → `retail` → `smart_money` /
`sniper` / `whale` based on scored fields.

Promotion rules:
- `unknown` → `retail` if `intelligence_score IS NOT NULL`
- `retail` → `smart_money` if score ≥ 0.80, win_rate ≥ 0.65, closed ≥ 5
- `retail` → `sniper` if score ≥ 0.75, win_rate ≥ 0.80, buys ≥ 10, avg_roi ≥ 5.0, closed ≥ 3
- `*` → `whale` (override) if realized_pnl ≥ 100 SOL AND closed ≥ 5

**Run as:** `bun scripts/fix-classification-promotion.ts`

**Must run after:** `audit-rescore-v2.ts` (needs current `intelligence_score`,
`win_rate`, `average_roi`) AND `fix-roi-backfill.ts` (needs accurate `realized_pnl`
for whale promotion gate).

**DANGER:** Running this before `fix-roi-backfill.ts` will fail to promote wallets
with realized_pnl ≥ 100 SOL because `wallets.realized_pnl` will still be
under-counted. Re-running after the ROI fix is safe (idempotent), but the initial
run will miss valid whales.

**Idempotent:** Yes — upserts on `wallet_address`.

---

### `node backfill-pool-address.mjs`

**What it does:** Finds all `wallet_collection_jobs` with `pool_address = NULL`
(done/failed status), derives the Pump.fun bonding curve PDA for each token,
and inserts a new `pending` job with the address set. The cron picks up the
new jobs and collects sell-side data.

**Run as:** `node backfill-pool-address.mjs`

**Does not depend on:** Any other script — safe to run any time.

**Idempotent:** Yes — skips tokens that already have any job with a non-null
pool address.

**Expected result:** 1,519 new pending jobs inserted (as of July 20 snapshot).

---

### `node enrich-hollow-wallets.mjs`

**What it does:** Fetches real Helius transaction history for every
`wallet_performance_history` row not yet enriched with `data_source = helius_full_history`.
Writes to `wallet_raw_tx_metrics` and upgrades positions in `wallet_performance_history`.

**Run as:**
```bash
HELIUS_API_KEY=xxx \
SUPABASE_URL=https://xxx.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=xxx \
node enrich-hollow-wallets.mjs
```

**Optional env vars:**
- `MAX_TXS=500` — max transactions per wallet (default 500, paginated)
- `CONCURRENCY=4` — parallel wallets per batch
- `DELAY_MS=500` — ms between batches
- `HELIUS_HOURLY_BUDGET=2000` — Helius CU limit per hour
- `DRY_RUN=1` — preview without writing

**Must run before:** `fix-classification-promotion.ts` — enrichment upgrades
position statuses that feed into classification scores.

**After running:** Always run `fix-classification-promotion.ts` to reclassify
the wallets that were enriched. The script will remind you at the end.

---

### `node backfill-wallet-activity.mjs`

**What it does:** Populates `amount_usd` (via CoinGecko historical prices) and
`token_age_at_entry` (via Pump.fun / Helius) for all `wallet_token_activity` rows
where these fields are NULL.

**Run as:** `node backfill-wallet-activity.mjs`

Optional: `HELIUS_API_KEY=xxx` for token creation time fallback when Pump.fun
API returns nothing.

**Time estimate:** ~30-40 minutes — CoinGecko free tier limits to ~30 req/min,
and the script sleeps 2s between unique days. 246,499 rows × ~2 unique days
per 100 rows = hundreds of CoinGecko calls.

**Does not depend on:** Any other script — safe to run any time.

**Idempotent:** Yes — only updates rows where the target field is NULL.

---

### `scripts/fix-stale-positions.ts`

**Status:** ✅ Already run — 0 stale OPEN positions remaining.

**What it does:** Closes OPEN positions with `last_updated < 2026-07-01` as rugs
(roi_multiple = 0, total_sol_received = 0).

**Idempotent:** Yes.

---

### `scripts/fix-pnl-backfill.ts`

**Status:** ✅ Already run — 2,759 wallets now have positive realized_pnl (was 86).

**What it does:** Aggregates `realized_pnl` from `wallet_performance_history`
into `wallets.realized_pnl`.

**Note:** `fix-roi-backfill.ts` supersedes this — it does the same aggregation
but after first ensuring all ROI values are computed. Re-running `fix-pnl-backfill.ts`
after `fix-roi-backfill.ts` is safe but redundant.

---

### `scripts/fix-jobs-reset.ts`

**What it does:** Inspects failed jobs, optionally retries or purges them.

**Run as:**
```bash
bun scripts/fix-jobs-reset.ts           # report only
bun scripts/fix-jobs-reset.ts --retry   # reset retryable jobs to pending
bun scripts/fix-jobs-reset.ts --purge   # delete permanent failures
```

**Fix applied (July re-audit):** The `--retry` flag now resets `attempts = 0`
when re-queuing jobs. Previously, attempts was left unchanged, meaning a job
retried after 2 prior failures would be treated as permanently failed on its
very next error.

---

### `scripts/verify-audit-fixes.ts`

**What it does:** Read-only report. Prints before/after counts for every metric
tracked by the audit, with checklist of pending actions at the end.

**Run as:** `bun scripts/verify-audit-fixes.ts`

**No writes. Safe at any time.**

---

### `scripts/production-rescore.ts`

**What it does:** Runs `classifyWallets()` from `wallet-enricher.ts` across all
wallet addresses. More heavyweight than `audit-rescore-v2.ts` — calls the full
production enricher pipeline.

**Run as:** `bun scripts/production-rescore.ts`

Accepts `<startOffset> <endOffset>` to resume: same as `audit-rescore-v2.ts`.

**Note:** The third argument to `classifyWallets(sb, batch, "", errors)` passes
an empty string as the token filter. Verify against the `wallet-enricher.ts`
function signature to confirm `""` means "all tokens" and not "skip all". If
the signature has changed, update the call before running.

---

### `scripts/audit-rescore-v2.ts`

**What it does:** Preferred alternative to `production-rescore.ts` — does not
call external APIs, uses only data already in the database, and enforces the
audit gate (≥ 3 real closed exits before scoring).

**Use this instead of `production-rescore.ts`** for routine post-backfill
rescoring unless you specifically need the full enricher pipeline.

---

## Dependency Graph

```
                           20260720000008_roi_null_backfill.sql
                                          │
                                          ▼
                             fix-roi-backfill.ts
                            /                  \
                           ▼                    ▼
              audit-rescore-v2.ts         (pnl re-aggregated
                           │              into wallets table)
                           ▼
              fix-classification-promotion.ts
                           │
                           ▼
              verify-audit-fixes.ts  ◄── backfill-pool-address.mjs
                                     ◄── backfill-wallet-activity.mjs
                                     ◄── [Railway deploy: risk_score]
```

---

## Environment Variables

All scripts read from environment. Recommended: create a `.env` file at the
project root and load with `node --env-file=.env` or `bun --env-file=.env`.

```
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
HELIUS_API_KEY=xxx          # Required for enrich-hollow-wallets.mjs
                            # Optional for backfill-wallet-activity.mjs
```

**Never commit `.env` to git.** It is already in `.gitignore`.

---

## Troubleshooting

### Script exits immediately with `FATAL: wallets: ...`
Supabase credentials are wrong or the table doesn't exist. Check:
1. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set correctly
2. The migration for that table has been applied in Supabase Dashboard

### `fix-classification-promotion.ts` shows 0 promotions to smart_money/sniper
`audit-rescore-v2.ts` hasn't been run yet, so `intelligence_score` is null for
most wallets. Run the rescore first.

### `fix-classification-promotion.ts` shows 0 whale promotions
`fix-roi-backfill.ts` hasn't been run yet, so `wallets.realized_pnl` is
understated. Run the ROI backfill first.

### `enrich-hollow-wallets.mjs` finishes but classifications haven't changed
This is expected — the script no longer runs inline classification.
Run `fix-classification-promotion.ts` after it completes.

### `backfill-wallet-activity.mjs` is very slow
This is expected — CoinGecko free tier limits to ~30 req/min and the script
sleeps 2s between unique calendar days. With 246K rows across many different
days, expect 30-40 minutes. Do not interrupt mid-run; it's idempotent and
safe to resume.
