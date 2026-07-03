-- =============================================================================
-- Migration: 20260703000001_fix_total_sol_received.sql
-- Purpose:   Backfill wallet_performance_history.total_sol_received
--
-- ROOT CAUSE (found in 2026-07-03 audit follow-up):
--   wallet-enricher.ts's upsertPerformanceRow() writes `current_value` from
--   position.totalSolReceived but never included `total_sol_received` in its
--   upsert payload. That function runs on the 20-min rescore scheduler and the
--   30-min enrich-unenriched scheduler, both of which touch nearly every
--   wallet — far more often than wallet-collection-worker.ts's
--   persistPerformanceHistory (which writes both columns correctly, but only
--   once per discovery job). As a result total_sol_received was stuck at its
--   table default (0) for 864/864 wallet_performance_history rows, while
--   current_value held the correct value the whole time.
--
-- CODE FIX: wallet-enricher.ts now also writes total_sol_received on every
--   upsert (see upsertPerformanceRow), so this is a one-time backfill for
--   rows written before that fix shipped.
--
-- STRATEGY: current_value has held the correct "total SOL received" figure
--   throughout (it was never the buggy column), so it is a safe backfill
--   source. Only rows where total_sol_received is still at its 0 default are
--   touched; rows already correctly populated (e.g. by
--   wallet-collection-worker's persistPerformanceHistory) are left untouched.
-- =============================================================================

UPDATE wallet_performance_history
SET total_sol_received = current_value
WHERE total_sol_received = 0
  AND current_value IS NOT NULL
  AND current_value <> 0;

-- Verify coverage (informational — does not fail if zero rows updated)
DO $$
DECLARE
  total_rows   INT;
  zero_rows    INT;
BEGIN
  SELECT COUNT(*) INTO total_rows FROM wallet_performance_history;
  SELECT COUNT(*) INTO zero_rows  FROM wallet_performance_history WHERE total_sol_received = 0;
  RAISE NOTICE 'total_sol_received backfill complete: %/% rows still at 0 (expected: wallets that genuinely received 0 SOL)',
    zero_rows, total_rows;
END;
$$;
