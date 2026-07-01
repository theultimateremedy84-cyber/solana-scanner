-- =============================================================================
-- 20260701000003_fix_phantom_raw_metrics.sql
--
-- FIX (audit-6 zero-invested investigation):
--
--   Live data audit of the 255 wallet_performance_history rows with
--   initial_investment = 0 found two distinct populations:
--
--     1. 109 LEGITIMATE rows — tokens were acquired via airdrop/transfer
--        (no SOL ever spent) and later sold for real SOL. This is correct
--        behaviour and these rows are NOT touched by this migration.
--
--     2. 146 PHANTOM rows — tagged data_source = 'helius_full_history' (the
--        highest quality tier, defined as "never overwritten by a lower-tier
--        source" per the column comment on wallet_raw_tx_metrics.data_source)
--        but with EVERY metric column at zero: no buy txs, no sell txs, no
--        tokens bought/sold, no SOL invested/received. Real helius_full_history
--        scans always carry evidence when they write this tier — current
--        enrichment code requires it — so these 146 rows predate that
--        guarantee and are stuck: because the tier is already "highest
--        quality", the enricher's monotonic tier rule (never downgrade)
--        permanently skips re-scanning them, even though they hold no real
--        data at all.
--
--   This migration resets ONLY the 146 genuinely-empty phantom rows back to
--   the lowest quality tier ('holder_scan') so the enricher will pick them
--   up and populate them with real data on its next pass over these wallets.
--   Legitimate zero-invested rows (airdrop-then-sold, which DO have non-zero
--   tokens_bought/sold/sol_received) are untouched by the WHERE clause below.
-- =============================================================================

BEGIN;

-- Preview (for the migration log / manual verification — no side effects):
DO $$
DECLARE
  phantom_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO phantom_count
  FROM public.wallet_raw_tx_metrics
  WHERE data_source = 'helius_full_history'
    AND total_buy_txs = 0
    AND total_sell_txs = 0
    AND total_tokens_bought = 0
    AND total_tokens_sold = 0
    AND total_sol_invested = 0
    AND total_sol_received = 0
    AND current_token_balance = 0;

  RAISE NOTICE 'Found % phantom helius_full_history rows to reset', phantom_count;
END $$;

-- Reset the phantom rows to the lowest tier so the enricher re-scans them,
-- and clear last_scanned_at so any staleness-based scheduling picks them up
-- immediately rather than waiting out a normal refresh interval.
UPDATE public.wallet_raw_tx_metrics
SET
  data_source     = 'holder_scan',
  last_scanned_at = TIMESTAMPTZ '1970-01-01T00:00:00Z'
WHERE data_source = 'helius_full_history'
  AND total_buy_txs = 0
  AND total_sell_txs = 0
  AND total_tokens_bought = 0
  AND total_tokens_sold = 0
  AND total_sol_invested = 0
  AND total_sol_received = 0
  AND current_token_balance = 0;

COMMIT;

-- ---------------------------------------------------------------------------
-- Verification query (run manually after applying):
--
--   SELECT COUNT(*) FROM public.wallet_raw_tx_metrics
--   WHERE data_source = 'helius_full_history'
--     AND total_buy_txs = 0 AND total_sell_txs = 0
--     AND total_tokens_bought = 0 AND total_tokens_sold = 0
--     AND total_sol_invested = 0 AND total_sol_received = 0
--     AND current_token_balance = 0;
--   -- Expect: 0
--
-- After this migration is applied, the next enrichment pass (wallet
-- collection jobs / re-scan) will treat these 146 wallets as needing a
-- real scan again instead of skipping them as "already fully enriched".
-- No application code change is required for this migration to take
-- effect — the enricher already re-scans any row not at the
-- 'helius_full_history' tier.
-- ---------------------------------------------------------------------------
