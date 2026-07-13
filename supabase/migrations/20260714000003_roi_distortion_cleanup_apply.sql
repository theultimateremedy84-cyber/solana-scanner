-- =============================================================================
-- roi_distortion_cleanup_apply
--
-- ISSUE (#3, medium priority)
-- ---------------------------
-- 7 wallet_performance_history rows still have extreme peak_roi / roi_multiple
-- values caused by dust-adjacent investments (< 0.02 SOL) with outsized
-- returns. These rows were supposed to be cleaned up by migration
-- 20260713000004_wph_roi_distortion_cleanup.sql, but that migration was never
-- applied to this production database — live data confirms the 7 rows still
-- carry non-null peak_roi (513× – 1,800×) and roi_multiple values.
--
-- Additionally, one row (wallet BHV7C3t...) has initial_investment = 0 and
-- peak_roi = 91,037×. The original migration's predicate required
-- initial_investment > 0, so this zero-investment outlier was never covered.
--
-- AFFECTED ROWS (confirmed in live data, 2026-07-13):
--   wallet BwWK17cb… × 6 tokens (inv 0.001–0.019 SOL, peak_roi 513–1,804×)
--   wallet B2XxD1DE… × 1 token  (inv 0.001 SOL, peak_roi 600×)
--   wallet BHV7C3t…  × 1 token  (inv 0 SOL,    peak_roi 91,037×)
--
-- ROOT CAUSE
-- ----------
-- The dust-distortion guard (guardRoiMultiple in tx-reconstructor.ts) nulls
-- ROI for positions with < 0.02 SOL invested AND > 500× return. However:
--   (a) The guard was added to tx-reconstructor.ts AFTER these rows were
--       inserted, so historical rows never got re-cleaned.
--   (b) wallet-enricher.ts's classifyWallets() recomputes roi_multiple
--       independently for CLOSED positions FROM raw invested/received values —
--       without applying the same guard. So classification can be skewed by
--       an unguarded in-memory recompute even if the stored column is null.
--   (c) peak_roi uses a "never decrease" invariant (preserve existing peaks)
--       which means a distorted peak_roi written before the guard existed is
--       frozen forever without an explicit migration to correct it.
--
-- FIX
-- ---
-- Null out both peak_roi and roi_multiple for rows matching the distortion
-- criteria. This is the backfill that 20260713000004 was meant to apply plus
-- the zero-investment extension it missed.
--
-- Wallets whose average_roi / classification derive from these rows will
-- self-correct on the next scheduled rescore pass (classifyWallets() recomputes
-- from raw wallet_raw_tx_metrics / wallet_performance_history, does NOT read
-- cached score). No separate wallets-table backfill is needed.
--
-- GUARD DEFINITION
-- ----------------
-- Matches the same rule as guardRoiMultiple() in tx-reconstructor.ts:
--   invested < 0.02 SOL AND roi > 500×
-- Extended to cover zero-investment rows (investment = 0 AND peak_roi > 500).
-- =============================================================================

-- Part 1: rows where investment is between 0 (exclusive) and 0.02 SOL
-- (same predicate as the original 20260713000004 migration, which was never applied)
UPDATE public.wallet_performance_history
SET
  peak_roi     = NULL,
  roi_multiple = NULL
WHERE
  initial_investment > 0
  AND initial_investment < 0.02
  AND (peak_roi > 500 OR roi_multiple > 500);

-- Part 2: rows where investment = 0 AND peak_roi is distorted
-- (zero-investment positions cannot produce meaningful ROI;
--  the original migration missed these by requiring initial_investment > 0)
UPDATE public.wallet_performance_history
SET
  peak_roi = NULL
WHERE
  initial_investment = 0
  AND peak_roi > 500;

DO $$
DECLARE
  affected_count INTEGER;
BEGIN
  -- This count reflects the last UPDATE (Part 2); check Supabase migration
  -- output for the Part 1 count as well.
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  RAISE NOTICE 'roi_distortion_cleanup_apply: Part 2 affected % zero-investment peak_roi rows', affected_count;
END $$;
