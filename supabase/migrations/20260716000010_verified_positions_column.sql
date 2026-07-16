-- =============================================================================
-- Migration: 20260716000010_verified_positions_column.sql
--
-- PURPOSE
--   Add `verified_positions` to the wallets table — a count of wallet_performance_history
--   rows where the wallet actually put real SOL at risk (initial_investment > 0.001)
--   and the position is not an airdrop exit.
--
--   This replaces the misleading `total_buys` metric on the leaderboard.
--   `total_buys` counts individual buy *transactions* in wallet_token_activity,
--   which is 0 for wallets enriched from pool-extraction/holder-scan data (the
--   majority of the database). `verified_positions` counts actual investment
--   positions regardless of how the data was sourced, giving an honest picture.
--
-- WHAT THIS DOES
--   1. Adds verified_positions INTEGER column to wallets (nullable, default NULL).
--   2. Backfills verified_positions for all wallets from wallet_performance_history.
--   3. Creates an index for leaderboard sorting and filtering.
--   4. Creates a PostgreSQL function refresh_verified_positions() that can be
--      called after enrichment runs to keep the column current.
--
-- SAFE TO RE-RUN: all statements use IF NOT EXISTS or handle conflicts.
-- =============================================================================

-- Step 1: Add the column
ALTER TABLE public.wallets
  ADD COLUMN IF NOT EXISTS verified_positions INTEGER;

COMMENT ON COLUMN public.wallets.verified_positions IS
  'Count of wallet_performance_history positions with initial_investment > 0.001 SOL '
  'and is_airdrop_exit = false. Reflects how many real trades the wallet has made, '
  'regardless of evidence source. Replaces total_buys on the leaderboard.';

-- Step 2: Backfill from wallet_performance_history
-- Uses a CTE to aggregate per-wallet counts, then updates in bulk.
-- Runs in a single UPDATE so it is safe even on large tables.
UPDATE public.wallets w
SET verified_positions = agg.pos_count
FROM (
  SELECT
    wallet_address,
    COUNT(*) FILTER (
      WHERE initial_investment > 0.001
        AND (is_airdrop_exit IS NULL OR is_airdrop_exit = FALSE)
    ) AS pos_count
  FROM public.wallet_performance_history
  GROUP BY wallet_address
) agg
WHERE w.wallet_address = agg.wallet_address;

-- Step 3: Index for leaderboard queries
CREATE INDEX IF NOT EXISTS idx_wallets_verified_positions
  ON public.wallets (verified_positions DESC NULLS LAST)
  WHERE verified_positions IS NOT NULL;

-- Step 4: Refresh function — call after enrichment to keep column current
CREATE OR REPLACE FUNCTION public.refresh_verified_positions()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.wallets w
  SET verified_positions = agg.pos_count
  FROM (
    SELECT
      wallet_address,
      COUNT(*) FILTER (
        WHERE initial_investment > 0.001
          AND (is_airdrop_exit IS NULL OR is_airdrop_exit = FALSE)
      ) AS pos_count
    FROM public.wallet_performance_history
    GROUP BY wallet_address
  ) agg
  WHERE w.wallet_address = agg.wallet_address
    AND (w.verified_positions IS DISTINCT FROM agg.pos_count);

  RAISE NOTICE 'refresh_verified_positions: complete';
END;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_verified_positions() TO service_role;

-- Verification (run manually after applying):
-- SELECT
--   wallet_address,
--   total_buys,
--   verified_positions,
--   wallet_classification,
--   intelligence_score
-- FROM wallets
-- ORDER BY intelligence_score DESC NULLS LAST
-- LIMIT 20;
-- Expected: verified_positions > 0 for top wallets even when total_buys = 0
