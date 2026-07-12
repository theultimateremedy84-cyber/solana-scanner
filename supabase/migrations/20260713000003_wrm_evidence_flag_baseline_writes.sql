-- =============================================================================
-- wrm_evidence_flag_baseline_writes
--
-- BACKGROUND
-- ----------
-- 20260713000001 backfilled `has_evidence = false` for all-zero rows, but only
-- for data_source = 'helius_full_history'. A 2026-07-12 data-quality audit
-- found 32 rows from the OTHER write path (wallet-collection-worker.ts
-- persistRawMetricsBaseline, data_source IN ('holder_scan', 'pool_extraction'))
-- that never explicitly set `has_evidence` and therefore inherited the
-- column's `DEFAULT true`, despite having zero buy/sell transaction evidence
-- (a holder_scan hit with no parsed trades at all). Anyone filtering
-- `has_evidence = true` alone (without also constraining data_source) would
-- silently include these empty rows as if they were real trade evidence.
--
-- The write path itself is fixed in the same commit (persistRawMetricsBaseline
-- now sets `has_evidence: w.buys > 0 || w.sells > 0` explicitly). This
-- migration backfills the existing bad rows, regardless of data_source.
-- =============================================================================

UPDATE public.wallet_raw_tx_metrics
SET
  has_evidence = false
WHERE
  has_evidence = true
  AND total_buy_txs      = 0
  AND total_sell_txs     = 0
  AND total_sol_invested  = 0
  AND total_sol_received  = 0
  AND total_tokens_bought = 0
  AND total_tokens_sold   = 0;
