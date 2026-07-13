-- =============================================================================
-- extend_roi_distortion_guard
--
-- ISSUE (#2, critical — monetization audit 2026-07-14)
-- -----------------------------------------------------
-- The existing ROI distortion guard (< 0.02 SOL AND roi > 500×) was too
-- narrow.  BwWK17cb-class wallets have initial_investment in the 0.027–0.098
-- SOL range — above the 0.02 SOL floor — yet produce roi_multiple and
-- peak_roi values of 863–2,532×.  These wallets dominate any ROI or
-- intelligence leaderboard and corrupt the confidence-tier pyramid.
--
-- ROOT CAUSE
-- ----------
-- tx-reconstructor.ts SMALL_INVESTMENT_THRESHOLD_SOL was 0.02 SOL, leaving the
-- 0.02–0.10 SOL band unguarded.  The guard was extended to 0.10 SOL in code
-- (commit alongside this migration), but existing DB rows were inserted before
-- the fix and need a one-time backfill.
--
-- AFFECTED ROWS (as confirmed by the check query below)
-- -------------------------------------------------------
--   wallet BwWK17cb… — 6 tokens, inv 0.027–0.098 SOL, roi 863–2,532×
--   Any other wallets in the 0.02–0.10 SOL range with roi > 500× that were
--   missed by the earlier 20260713000004 migration (which covered < 0.02 SOL).
--
-- FIX
-- ---
-- Null out both roi_multiple and peak_roi for rows where:
--   - initial_investment is in the newly-guarded 0.02–0.10 SOL band (exclusive)
--   - AND roi_multiple OR peak_roi exceeds 500× (the EXTREME_ROI_MULTIPLE guard)
--
-- After this migration the next rescore scheduler tick re-computes
-- intelligence_score and average_roi for affected wallets automatically.
--
-- SAFETY
-- ------
-- The WHERE predicate is identical to the new code guard, so this migration
-- is idempotent — rows already nulled are unaffected.
-- Only touches rows in the newly-extended band (> 0.02 AND < 0.10); the
-- original < 0.02 range was handled by migration 20260713000004.
-- =============================================================================

-- Check query (run first to see impact; this does NOT modify data):
-- SELECT COUNT(*), MIN(initial_investment), MAX(initial_investment),
--        MIN(roi_multiple), MAX(roi_multiple), MIN(peak_roi), MAX(peak_roi)
-- FROM   public.wallet_performance_history
-- WHERE  initial_investment > 0.02
--   AND  initial_investment < 0.10
--   AND  (roi_multiple > 500 OR peak_roi > 500);

-- Backfill: extend distortion guard to 0.10 SOL
UPDATE public.wallet_performance_history
SET
  roi_multiple = NULL,
  peak_roi     = NULL,
  updated_at   = now()
WHERE
  initial_investment > 0.02
  AND initial_investment < 0.10
  AND (roi_multiple > 500 OR peak_roi > 500);

DO $$
DECLARE
  affected_count INTEGER;
BEGIN
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  RAISE NOTICE 'extend_roi_distortion_guard: nulled roi/peak_roi for % rows (0.02–0.10 SOL band with >500x return)', affected_count;
END $$;
