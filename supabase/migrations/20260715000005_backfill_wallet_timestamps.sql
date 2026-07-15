-- =============================================================================
-- Migration: 20260715000005_backfill_wallet_timestamps.sql
-- Phase 3 — Task 9
--
-- PURPOSE
--   8 scored wallets have first_seen_timestamp = NULL and last_seen_timestamp
--   = NULL. These wallets are invisible on the leaderboard despite having valid
--   intelligence scores.
--
-- WHAT THIS DOES
--   Backfills first_seen_timestamp and last_seen_timestamp from the MIN/MAX
--   timestamp in wallet_token_activity for each affected wallet.
--
-- IDEMPOTENT: WHERE clause only touches wallets where timestamps are still NULL.
-- =============================================================================

-- Step 1: log scope
DO $$
DECLARE
  missing_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO missing_count
  FROM wallets
  WHERE intelligence_score IS NOT NULL
    AND first_seen_timestamp IS NULL;

  RAISE NOTICE '[timestamp-backfill] Wallets with null timestamps: %', missing_count;
END $$;

-- Step 2: backfill from wallet_token_activity
UPDATE wallets w
SET
  first_seen_timestamp = sub.first_ts,
  last_seen_timestamp  = sub.last_ts,
  updated_at           = now()
FROM (
  SELECT
    wallet_address,
    MIN(timestamp) AS first_ts,
    MAX(timestamp) AS last_ts
  FROM wallet_token_activity
  WHERE wallet_address IN (
    SELECT wallet_address FROM wallets
    WHERE intelligence_score IS NOT NULL
      AND first_seen_timestamp IS NULL
  )
  GROUP BY wallet_address
) sub
WHERE w.wallet_address = sub.wallet_address;

-- Step 3: verify
DO $$
DECLARE
  still_missing INTEGER;
  fixed         INTEGER;
BEGIN
  SELECT COUNT(*) INTO still_missing
  FROM wallets
  WHERE intelligence_score IS NOT NULL
    AND first_seen_timestamp IS NULL;

  IF still_missing = 0 THEN
    RAISE NOTICE '[timestamp-backfill] ✓ All scored wallets now have timestamps';
  ELSE
    RAISE WARNING '[timestamp-backfill] % wallets still have null timestamps — no wallet_token_activity rows exist for them', still_missing;
  END IF;
END $$;
