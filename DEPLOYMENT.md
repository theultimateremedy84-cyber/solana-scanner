# Solana Scanner — Permanent Fixes Deployment Guide
> Generated: July 21, 2026

## File Placement

Drop each file into your repository at exactly this path:

```
your-repo/
├── railway.toml                              ← REPLACE existing file
└── scripts/
    ├── audit-rescore-v2.ts                   ← REPLACE existing file
    ├── fix-classification-promotion.ts        ← REPLACE existing file
    ├── patch-null-roi.ts                      ← NEW — add this file
    ├── integrity-monitor.ts                   ← NEW — add this file
    └── daily-pipeline.ts                      ← NEW — add this file
```

---

## What Changed and Why

### `scripts/audit-rescore-v2.ts` — REPLACE
**Bug fixed:** `win_rate` was null for 87% of scored wallets (13,212 wallets).

`classifyWallet()` never returned `winRate` for raw-evidence wallets. Without win_rate,
smart_money and sniper promotion were impossible regardless of score.

The fix adds a direct fallback computation from position data immediately after the
`classifyWallet()` call. No external dependency — uses the same `positions` array
already in scope.

```diff
+ const closedWithSOL = positions.filter(p => p.positionStatus === "CLOSED" && p.totalSolReceived > 0);
+ const profitablePositions = closedWithSOL.filter(p => p.totalSolReceived > p.initialInvestment);
+ const computedWinRate = closedWithSOL.length > 0 ? profitablePositions.length / closedWithSOL.length : null;
+ const resolvedWinRate = scores.winRate ?? computedWinRate;
  ...
- win_rate: scores.winRate,
+ win_rate: resolvedWinRate,
```

---

### `scripts/fix-classification-promotion.ts` — REPLACE
**Bug fixed:** Script was promotion-only. Wallets that no longer met their tier's
criteria (e.g. smart_money wallets whose score dropped below 0.80) were never demoted,
so stale classifications persisted indefinitely.

All 17 existing smart_money wallets were below the 0.80 threshold — this script
now corrects that automatically on every run.

**Before (broken):**
```typescript
if (pnl >= WHALE_MIN_PNL && closed >= WHALE_MIN_CLOSED) {
  if (current !== "whale") { target = "whale"; }   // ← skips already-classified wallets
}
```

**After (correct):**
```typescript
// Determine correct tier unconditionally, then compare to current
let target: string;
if      (pnl >= WHALE_MIN_PNL ...)   target = "whale";
else if (score >= SMART_MONEY ...)   target = "smart_money";
else if (score >= SNIPER ...)        target = "sniper";
else                                 target = "retail";     // ← demotes if needed

if (target !== current) { /* write update */ }
```

Summary output now shows demotions explicitly:
```
→ retail     : 17  (includes 17 demotion(s) from premium tiers)
→ smart_money: 2
→ whale      : 3
  unchanged  : 15,138
```

---

### `scripts/patch-null-roi.ts` — NEW
Fixes CLOSED positions where `roi_multiple` is still null due to race conditions
between the enricher and the ROI backfill script.

- Runs as **Step 1** of `daily-pipeline.ts`, before rescoring
- Idempotent — safe to run at any time, only touches null rows
- Caps extreme ROI values at 200x (same guard as the rest of the pipeline)

```bash
bun scripts/patch-null-roi.ts
```

---

### `scripts/integrity-monitor.ts` — NEW
A 30-second read-only health check that replaces manual morning queries.
Outputs a `PASS / WARN / FAIL` report to stdout (appears in Railway logs).

```
╔══════════════════════════════════════════════════════════════╗
║  INTEGRITY MONITOR — Solana Scanner                          ║
║  2026-07-22 03:04:31 UTC                                     ║
╚══════════════════════════════════════════════════════════════╝

✅  Scored wallets                   15,170 / 96,442 (16%)
✅  Stale scores (> 48h)             0
✅  Null win_rate on scored wallets  0  (0%)
✅  Scored wallets stuck as unknown  0
✅  smart_money wallets below 0.80   0
✅  Retail wallets qualifying whale  0
✅  CLOSED positions null ROI        0
✅  Stale OPEN positions (< Jul 1)   0
✅  Stuck processing jobs            0
✅  Failed jobs                      3  low count, acceptable
⚠️  Null token_age_at_entry         335,094  ← run backfill-wallet-activity.mjs

──────────────────────────────────────────────────────────────
  ⚠️   0 FAIL, 1 WARN — degraded, investigate soon
```

Exit code 1 if any FAIL — surfaces as a red cron job in Railway dashboard.

```bash
bun scripts/integrity-monitor.ts
```

---

### `scripts/daily-pipeline.ts` — NEW
Single command that replaces your 4–5 hour daily maintenance routine.
Chains all steps in the correct dependency order with abort-on-failure logic.

```
Step 1: patch-null-roi.ts              (~5s)    fix ROI stragglers
Step 2: audit-rescore-v2.ts            (~5min)  recompute all scores
Step 3: fix-classification-promotion.ts (~30s)  sync tier classifications
Step 4: backfill-pool-address.mjs      (~2min)  re-queue null pool jobs
Step 5: integrity-monitor.ts           (~20s)   health report to logs
```

If Step 2 (rescore) fails, the pipeline aborts before Step 3 — prevents
running classification on stale scores, which would corrupt data.

```bash
bun scripts/daily-pipeline.ts
```

Optional env flags:
- `SKIP_BACKFILL_POOL=1` — skip step 4 once the pool queue is clean
- `DRY_RUN=1` — print the plan without writing anything

---

### `railway.toml` — REPLACE
Adds the daily maintenance cron job at 03:00 UTC:

```toml
[[deploy.cronJobs]]
name     = "daily-maintenance"
schedule = "0 3 * * *"
command  = "bun scripts/daily-pipeline.ts"
```

The existing `process-wallet-jobs` cron (every minute) is unchanged.

---

## Deployment Steps

### 1. Copy the files

```bash
# From the root of your repository:
cp path/to/this-zip/railway.toml                              ./railway.toml
cp path/to/this-zip/scripts/audit-rescore-v2.ts               ./scripts/
cp path/to/this-zip/scripts/fix-classification-promotion.ts    ./scripts/
cp path/to/this-zip/scripts/patch-null-roi.ts                  ./scripts/
cp path/to/this-zip/scripts/integrity-monitor.ts               ./scripts/
cp path/to/this-zip/scripts/daily-pipeline.ts                  ./scripts/
```

### 2. Run the first manual pass (do this once after deploy)

```bash
# Fix ROI stragglers first
bun scripts/patch-null-roi.ts

# Rescore — now writes win_rate correctly for all wallets
bun scripts/audit-rescore-v2.ts

# Sync classifications — will demote the 17 stale smart_money wallets
# and promote the 3 missing whales and 2 missing snipers
bun scripts/fix-classification-promotion.ts

# Verify the state is clean
bun scripts/integrity-monitor.ts
```

### 3. Commit and deploy to Railway

```bash
git add railway.toml scripts/
git commit -m "fix: win_rate null bug, add demotion logic, automate daily pipeline"
git push
```

Railway will pick up the new `daily-maintenance` cron job on the next deploy.
From that point the pipeline runs nightly at 03:00 UTC without any manual intervention.

---

## What Still Needs a Manual Run (one-time)

These are long-running backfills that can't be automated nightly:

| Script | Time | Frequency | Why not automated |
|--------|------|-----------|-------------------|
| `node backfill-wallet-activity.mjs` | 30–40 min | Once a week | CoinGecko rate limits (2s per day) |

Run once this week to clear the 335,094 null `token_age_at_entry` rows.
After that, weekly is sufficient to stay current.

---

## Morning Routine (after this deploy)

**Old routine:** 4–5 hours of manual script runs and DB queries

**New routine:**
1. Open Railway dashboard → Cron Jobs → `daily-maintenance` → View logs
2. Search for "HEALTH REPORT" in the log output
3. If all ✅: done. If any ⚠️ or ❌: the log line tells you exactly what to run.

Total time: under 2 minutes.
