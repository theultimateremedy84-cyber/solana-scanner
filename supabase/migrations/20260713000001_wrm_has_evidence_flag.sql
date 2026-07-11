-- =============================================================================
-- wrm_has_evidence_flag
--
-- Adds a has_evidence BOOLEAN column to wallet_raw_tx_metrics to distinguish
-- "tombstone" rows (written intentionally to stop re-queuing of wallet×token
-- pairs where Helius found zero pump.fun swaps) from rows that carry real
-- on-chain data.
--
-- BACKGROUND
-- ----------
-- When wallet-enricher.ts calls reconstructWalletPosition() and Helius returns
-- no pump.fun swaps for a wallet×token pair, the enricher writes an all-zero
-- helius_full_history row so find_hollow_pairs() permanently removes that pair
-- from its result set (preventing an infinite re-scan loop). These tombstone
-- rows have:
--   total_buy_txs = 0, total_sell_txs = 0,
--   total_sol_invested = 0, total_sol_received = 0,
--   total_tokens_bought = 0, total_tokens_sold = 0
-- They carry no analytical value and must not be included in leaderboard,
-- scoring, or reporting queries.
--
-- FIX
-- ---
-- Add has_evidence BOOLEAN NOT NULL DEFAULT true.
-- Set has_evidence = false for all existing tombstone rows via a backfill.
-- The application code then:
--   • writes has_evidence: false in the tombstone upsert path
--   • writes has_evidence: true in the real-metrics upsert path
--   • filters WHERE has_evidence = true in classifyWallets() and any
--     reporting/leaderboard queries
-- =============================================================================

ALTER TABLE public.wallet_raw_tx_metrics
  ADD COLUMN IF NOT EXISTS has_evidence BOOLEAN NOT NULL DEFAULT true;

-- Backfill: rows with zero activity across all metric columns are tombstones.
-- A real enrichment always produces at least one non-zero field (buy/sell tx
-- count, token amount, or SOL volume) — so the all-zero check is exact.
UPDATE public.wallet_raw_tx_metrics
SET has_evidence = false
WHERE
  data_source          = 'helius_full_history'
  AND total_buy_txs    = 0
  AND total_sell_txs   = 0
  AND total_sol_invested   = 0
  AND total_sol_received   = 0
  AND total_tokens_bought  = 0
  AND total_tokens_sold    = 0;

-- Index so analytics queries can cheaply filter out tombstones.
CREATE INDEX IF NOT EXISTS wrm_has_evidence_idx
  ON public.wallet_raw_tx_metrics (has_evidence)
  WHERE has_evidence = true;

COMMENT ON COLUMN public.wallet_raw_tx_metrics.has_evidence IS
  'false for tombstone rows written to prevent infinite re-queuing of wallet×token '
  'pairs with no pump.fun transaction history. true for all rows containing real '
  'on-chain data. Always filter WHERE has_evidence = true in analytics queries.';
