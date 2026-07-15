-- =============================================================================
-- Migration: 20260715000001_roi_distortion_final_cleanup.sql
-- Phase 1 — Task 2
--
-- PURPOSE
--   Previous migrations 20260713000004 and 20260714000005 nulled roi_multiple
--   for CLOSED positions where initial_investment was in the 0.001–0.02 SOL
--   and 0.02–0.10 SOL bands respectively.  Despite both migrations running,
--   88 rows remain with roi_multiple > 500 and initial_investment in the
--   0.001–0.10 SOL range.  Root cause: some rows were inserted by the enricher
--   after the migrations ran but before the updated guardRoiMultiple() code
--   (SMALL_INVESTMENT_THRESHOLD_SOL = 0.10) was deployed to Railway.
--
-- WHAT THIS DOES
--   Nulls roi_multiple and peak_roi for the remaining 88 distortion rows.
--   Safe: only touches rows where the investment size objectively cannot
--   support a 500× return without being dust/fat-finger/program-error noise.
--   The guardRoiMultiple() code fix in tx-reconstructor.ts prevents new rows
--   from entering this state once deployed.
--
-- IDEMPOTENT: re-running returns 0 rows affected.
-- =============================================================================

-- Step 1: capture the count before for the migration log
DO $$
DECLARE
  affected_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO affected_count
  FROM wallet_performance_history
  WHERE position_status    = 'CLOSED'
    AND roi_multiple        > 500
    AND initial_investment  > 0
    AND initial_investment  < 0.10;

  RAISE NOTICE '[ROI-distortion-cleanup] Rows to fix: %', affected_count;
END $$;

-- Step 2: apply the fix
UPDATE wallet_performance_history
SET
  roi_multiple = NULL,
  peak_roi     = NULL,
  updated_at   = now()
WHERE position_status   = 'CLOSED'
  AND roi_multiple       > 500
  AND initial_investment > 0
  AND initial_investment < 0.10;

-- Step 3: verify — this SELECT must return 0 rows after the migration
DO $$
DECLARE
  remaining INTEGER;
BEGIN
  SELECT COUNT(*) INTO remaining
  FROM wallet_performance_history
  WHERE position_status    = 'CLOSED'
    AND roi_multiple        > 500
    AND initial_investment  > 0
    AND initial_investment  < 0.10;

  IF remaining > 0 THEN
    RAISE WARNING '[ROI-distortion-cleanup] % rows still have distorted ROI — investigate before rescoring', remaining;
  ELSE
    RAISE NOTICE '[ROI-distortion-cleanup] ✓ Verification passed — 0 distorted rows remaining';
  END IF;
END $$;
