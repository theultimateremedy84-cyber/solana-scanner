-- Migration: fix_sell_only_unknown_positions
-- Date: 2026-07-13
--
-- Root cause:
--   wallet_performance_history contained 20,852 rows with position_status = UNKNOWN
--   where total_tokens_bought = 0, total_tokens_sold > 0, total_sol_received > 0.
--   These are "sell-only" wallets — the sell is real (confirmed SOL received) but
--   the matching buy is absent from Helius history, either because:
--     (a) The buy predates the Helius lookback window (pre-history buy).
--     (b) The wallet bought via Raydium after token graduation from pump.fun;
--         fetchWalletTokenTxs filters to source=PUMP_FUN which skips Raydium txs.
--
-- Fix:
--   Reclassify from UNKNOWN → CLOSED. These wallets made real trades and should
--   participate in wallet classification. roi_multiple stays NULL (invested_sol = 0
--   guard in application code), so win_rate and average_roi are not inflated.
--   The application-layer zero-cost-basis CLOSED guard sets realized_profit = 0,
--   keeping P&L neutral for scoring purposes.
--
-- Companion code changes (apply alongside this migration):
--   src/lib/api/tx-reconstructor.ts  — classifyPositionStatus(): UNKNOWN only when
--       tokensBought=0 AND tokensSold=0 AND investedSol=0; sell-only → CLOSED.
--   src/lib/api/wallet-enricher.ts   — classifyWallets(): sell-only branch → CLOSED.

UPDATE wallet_performance_history
SET
  position_status = 'CLOSED',
  last_updated    = now()
WHERE
  position_status      = 'UNKNOWN'
  AND total_tokens_bought = 0
  AND total_tokens_sold   > 0
  AND total_sol_received  > 0;
