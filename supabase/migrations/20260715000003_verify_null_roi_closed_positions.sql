-- =============================================================================
-- Migration: 20260715000003_verify_null_roi_closed_positions.sql
-- Phase 1 — Task 4
--
-- PURPOSE
--   C-4 from the audit: 86 CLOSED positions had roi_multiple = NULL despite
--   having real investment (initial_investment > 0.001 SOL) and not being
--   airdrop exits.  The document SQL fix was applied and live data now shows
--   0 matching rows.
--
--   This migration is a verification + proactive safety net.  It:
--     1. Confirms the C-4 fix holds (logs a warning if any rows have appeared
--        since the audit, e.g. from new enrichment runs).
--     2. Applies the roi_multiple = total_sol_received / initial_investment
--        formula to any remaining rows so future enrichment gaps self-heal.
--     3. Adds a check for the is_airdrop_exit column being NULL (vs FALSE) —
--        some rows were inserted before the airdrop-exit migration and have
--        NULL rather than FALSE, which can cause the C-4 filter to miss them.
--
-- IDEMPOTENT: if 0 rows match, 0 rows are updated.
-- =============================================================================

-- Step 1: count rows in each gap category for the log
DO $$
DECLARE
  c4_strict        INTEGER;
  c4_null_flag     INTEGER;
BEGIN
  -- Original C-4 definition: CLOSED, not airdrop (FALSE), investment > 0.001, no ROI
  SELECT COUNT(*) INTO c4_strict
  FROM wallet_performance_history
  WHERE position_status    = 'CLOSED'
    AND is_airdrop_exit    IS NOT TRUE
    AND initial_investment  > 0.001
    AND roi_multiple        IS NULL;

  -- Broader: includes rows where is_airdrop_exit is NULL (pre-migration rows)
  SELECT COUNT(*) INTO c4_null_flag
  FROM wallet_performance_history
  WHERE position_status    = 'CLOSED'
    AND is_airdrop_exit    IS NULL
    AND initial_investment  > 0.001
    AND roi_multiple        IS NULL;

  IF c4_strict > 0 THEN
    RAISE WARNING '[null-roi-verify] % CLOSED rows missing roi_multiple — applying fix', c4_strict;
  ELSE
    RAISE NOTICE '[null-roi-verify] ✓ C-4 holds: 0 rows with null roi on real investment';
  END IF;

  IF c4_null_flag > 0 THEN
    RAISE NOTICE '[null-roi-verify] % rows with is_airdrop_exit=NULL will also be fixed', c4_null_flag;
  END IF;
END $$;

-- Step 2: fix any C-4 rows that exist (is_airdrop_exit = FALSE or NULL)
-- Guard: guardRoiMultiple logic — only compute when investment >= 0.001 SOL
-- and the resulting multiple is not extreme (capped at 500 per the distortion guard)
UPDATE wallet_performance_history
SET
  roi_multiple = LEAST(
    total_sol_received / initial_investment,
    500.0  -- matches EXTREME_ROI_MULTIPLE cap in guardRoiMultiple()
  ),
  updated_at   = now()
WHERE position_status    = 'CLOSED'
  AND is_airdrop_exit    IS NOT TRUE   -- covers both FALSE and NULL
  AND initial_investment  > 0.001
  AND roi_multiple        IS NULL
  AND total_sol_received  IS NOT NULL
  AND total_sol_received  >= 0;

-- Step 3: also normalise any is_airdrop_exit = NULL → FALSE for pre-migration rows
-- (prevents future C-4 filter gaps — these rows are genuine trades, not airdrops)
UPDATE wallet_performance_history
SET
  is_airdrop_exit = FALSE,
  updated_at      = now()
WHERE is_airdrop_exit IS NULL
  AND initial_investment > 0;

-- Step 4: final verification summary
DO $$
DECLARE
  still_null INTEGER;
  airdrop_null INTEGER;
BEGIN
  SELECT COUNT(*) INTO still_null
  FROM wallet_performance_history
  WHERE position_status    = 'CLOSED'
    AND is_airdrop_exit    IS NOT TRUE
    AND initial_investment  > 0.001
    AND roi_multiple        IS NULL;

  SELECT COUNT(*) INTO airdrop_null
  FROM wallet_performance_history
  WHERE is_airdrop_exit IS NULL;

  IF still_null = 0 THEN
    RAISE NOTICE '[null-roi-verify] ✓ All CLOSED positions with real investment now have roi_multiple';
  ELSE
    RAISE WARNING '[null-roi-verify] % rows still missing roi_multiple after fix — check total_sol_received nulls', still_null;
  END IF;

  IF airdrop_null = 0 THEN
    RAISE NOTICE '[null-roi-verify] ✓ is_airdrop_exit has no NULL values — all rows have TRUE or FALSE';
  ELSE
    RAISE WARNING '[null-roi-verify] % rows still have is_airdrop_exit = NULL (zero-investment rows — expected)', airdrop_null;
  END IF;
END $$;
