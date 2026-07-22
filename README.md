# Hollow Wallet Enrichment — Audits 2, 3 & 5

## What this script does
Reads all 802 hollow wallet×token pairs from your Supabase DB, fetches each
wallet's Solana transaction history from Helius, computes buy/sell metrics,
and writes:
  - `wallet_raw_tx_metrics`  (data_source = helius_full_history)
  - `wallet_performance_history` (position_status, roi_multiple, etc.)
  - Reclassifies all wallets in the `wallets` table

## Requirements
- Node.js 18+  (native fetch — no npm install needed)
- Your Helius API key
- Supabase service role key

## Run locally
```bash
HELIUS_API_KEY=YOUR_HELIUS_API_KEY \
SUPABASE_URL=YOUR_SUPABASE_URL \
SUPABASE_SERVICE_ROLE_KEY=YOUR_SUPABASE_SERVICE_ROLE_KEY \
HELIUS_DAILY_BUDGET=25000 \
HELIUS_HOURLY_BUDGET=2000 \
node enrich-hollow-wallets.mjs
```

## Run as Railway one-off job
In Railway → your project → click "+" → New Service → choose "Run command":
```
node /app/enrich-hollow-wallets.mjs
```
Set the same env vars in Railway → Variables.

## Dry run (no writes, just prints the plan)
```bash
DRY_RUN=1 HELIUS_API_KEY=xxx ... node enrich-hollow-wallets.mjs
```

## Expected output
```
═══ DONE ═══
  Wallets processed : 802
  Enriched (wrote)  : ~400-600   ← wallets with real tx history
  No tx evidence    : ~200-400   ← wallets that never traded this token
  Errors            : 0
  Duration          : ~8-15 min
```

## Budget estimate
- 802 wallets × 1 CU each ≈ 802 CUs total
- Fits within HELIUS_HOURLY_BUDGET=2000 in a single run
- Full run takes ~8-15 minutes at CONCURRENCY=4, DELAY_MS=500
