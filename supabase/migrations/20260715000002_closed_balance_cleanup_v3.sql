-- =============================================================================
-- Migration: 20260715000002_closed_balance_cleanup_v3.sql
-- Phase 1 — Task 3
--
-- PURPOSE
--   Previous cleanup migrations (20260713000002 and 20260714000004) used a
--   2% residual threshold to zero balances on CLOSED positions.  However, the
--   CLOSED classification gate in wallet-enricher.ts uses a 95% sold threshold
--   (tokensSold >= tokensBought * 0.95), meaning up to 5% of tokens can remain
--   in a "CLOSED" position.  For tokens with large supplies, 5% easily exceeds
--   1 token — so the 2% cleanup missed the entire 2–5% residual band.
--
--   Live audit result: 29,559 CLOSED positions still have current_token_balance > 1
--   (33% of all CLOSED positions), versus the 11 rows the previous migrations fixed.
--
-- WHAT THIS DOES
--   Zeros current_token_balance for CLOSED positions where the remaining balance
--   is within the 5% tolerance of the CLOSED gate — i.e. the wallet has genuinely
--   exited the position and the residual is dust relative to their total purchase.
--
--   SCOPE:  current_token_balance <= total_tokens_bought * 0.05
--           This precisely matches the upper bound of the CLOSED classification
--           threshold (95% sold → ≤5% remaining), ensuring the cleanup covers
--           exactly the rows that should be CLOSED with zero balance.
--
--   SAFETY: rows where current_token_balance > total_tokens_bought * 0.05
--           are NOT touched — those may be genuine PARTIALLY_CLOSED positions
--           that were mis-flagged as CLOSED and need separate investigation.
--
-- IDEMPOTENT: re-running returns 0 rows affected (already zero).
-- =============================================================================

-- Step 1: log scope before applying
DO $$
DECLARE
  band_2_to_5_pct  INTEGER;
  band_lt_2_pct    INTEGER;
  band_no_buy_data INTEGER;
BEGIN
  -- Rows in the 2–5% band (missed by v1 + v2 cleanups)
  SELECT COUNT(*) INTO band_2_to_5_pct
  FROM wallet_performance_history
  WHERE position_status          = 'CLOSED'
    AND current_token_balance     > 0
    AND total_tokens_bought       > 0
    AND current_token_balance     >  total_tokens_bought * 0.02
    AND current_token_balance     <= total_tokens_bought * 0.05;

  -- Rows in the < 2% band (should already be zero from v1 + v2)
  SELECT COUNT(*) INTO band_lt_2_pct
  FROM wallet_performance_history
  WHERE position_status          = 'CLOSED'
    AND current_token_balance     > 0
    AND total_tokens_bought       > 0
    AND current_token_balance     <= total_tokens_bought * 0.02;

  -- Rows with no buy data (total_tokens_bought = 0) — safe to zero balance
  SELECT COUNT(*) INTO band_no_buy_data
  FROM wallet_performance_history
  WHERE position_status      = 'CLOSED'
    AND current_token_balance > 0
    AND total_tokens_bought   = 0;

  RAISE NOTICE '[balance-cleanup-v3] Rows in 2–5%% band (new): %', band_2_to_5_pct;
  RAISE NOTICE '[balance-cleanup-v3] Rows in <2%% band (v1+v2 residual): %', band_lt_2_pct;
  RAISE NOTICE '[balance-cleanup-v3] Rows with no buy data: %', band_no_buy_data;
END $$;

-- Step 2: apply the fix — zero balances within the 5% CLOSED gate
UPDATE wallet_performance_history
SET
  current_token_balance = 0,
  updated_at            = now()
WHERE position_status   = 'CLOSED'
  AND current_token_balance > 0
  AND (
    -- No buy data recorded — position is CLOSED so balance should be zero
    total_tokens_bought = 0
    OR
    -- Balance is within the 5% tolerance of the 95%-sold CLOSED threshold
    current_token_balance <= total_tokens_bought * 0.05
  );

-- Step 3: verify — report remaining rows outside the cleanup band
DO $$
DECLARE
  cleaned    INTEGER;
  over_5pct  INTEGER;
BEGIN
  -- Rows we cleaned (should now be 0 balance)
  SELECT COUNT(*) INTO cleaned
  FROM wallet_performance_history
  WHERE position_status   = 'CLOSED'
    AND current_token_balance = 0;

  -- Rows untouched by intent — balance > 5% of bought (possible mis-classification)
  SELECT COUNT(*) INTO over_5pct
  FROM wallet_performance_history
  WHERE position_status          = 'CLOSED'
    AND current_token_balance     > 0
    AND total_tokens_bought       > 0
    AND current_token_balance     > total_tokens_bought * 0.05;

  RAISE NOTICE '[balance-cleanup-v3] ✓ CLOSED positions now with zero balance: %', cleaned;
  RAISE NOTICE '[balance-cleanup-v3] CLOSED positions with balance > 5%% of bought: % (investigate for mis-classification)', over_5pct;
END $$;
