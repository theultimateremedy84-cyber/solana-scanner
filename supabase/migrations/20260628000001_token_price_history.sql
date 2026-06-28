-- =============================================================================
-- Migration: 20260628000001_token_price_history.sql
--
-- PURPOSE
--   Brings the token_price_history table under version control.
--   This table already exists in production (populated by the price-refresh
--   scheduler via insertPriceSnapshot()). This migration is 100% additive —
--   it creates the table only if it does not already exist, so running it
--   against the live database is safe and does NOT disturb existing rows.
--
-- WHAT THIS TABLE STORES
--   Time-series price snapshots for every Solana token with active wallet
--   positions. One row is inserted per token per price-refresh cycle
--   (scheduler fires every 15 minutes via startPriceRefreshScheduler()).
--   Snapshots are sourced from DexScreener's public API.
--
-- HOW THIS DATA IS USED
--   - Price history charts on the token detail and cluster pages
--   - Peak market-cap tracking (used to compute discovery_score)
--   - Unrealized P&L recalculation in wallet_performance_history
--   - Discovery score: how early a wallet entered relative to the token's
--     eventual peak market cap
--
-- SAFE TO RUN AGAINST PRODUCTION
--   CREATE TABLE IF NOT EXISTS — no-op if the table already exists
--   No DROP TABLE, no DELETE, no destructive DDL.
--   All index and policy creates use IF NOT EXISTS guards.
--
-- APPLY
--   Supabase Dashboard → SQL Editor: paste and click Run
--   CLI: supabase db push  (after supabase link)
-- =============================================================================


-- =============================================================================
-- TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.token_price_history (
  id                  UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,

  -- Token identity
  token_address       TEXT        NOT NULL,

  -- When this snapshot was captured (price-refresh worker clock, not DB clock)
  snapshotted_at      TIMESTAMPTZ NOT NULL,

  -- Data origin
  source              TEXT,       -- always "dexscreener" for current implementation
  refresh_source      TEXT,       -- "refresh" (scheduler) or caller-supplied label
  trigger             TEXT,       -- "price_refresh_worker" or caller-supplied label

  -- DEX pair context (from DexScreener pair response)
  pair_address        TEXT,       -- DexScreener pair address
  dex_id              TEXT,       -- e.g. "raydium", "orca", "meteora"
  quote_token_symbol  TEXT,       -- "SOL" for SOL-denominated pairs, NULL otherwise

  -- Pricing
  price_sol           NUMERIC,    -- token price denominated in SOL
  price_usd           NUMERIC,    -- token price in USD

  -- Market context
  market_cap_usd      NUMERIC,    -- fully diluted market cap in USD at snapshot time
  liquidity_usd       NUMERIC,    -- total liquidity in USD across the pair
  fdv_usd             NUMERIC,    -- fully diluted valuation in USD
  volume_24h_usd      NUMERIC     -- rolling 24-hour trading volume in USD
);

COMMENT ON TABLE public.token_price_history IS
  'Time-series price snapshots for Solana tokens with active wallet positions. '
  'One row per (token_address, snapshotted_at) inserted every 15 minutes by '
  'the price-refresh scheduler (startPriceRefreshScheduler → insertPriceSnapshot). '
  'Used for: price history charts, peak market-cap tracking, discovery_score '
  'computation, and unrealized P&L recalculation.';

COMMENT ON COLUMN public.token_price_history.snapshotted_at IS
  'Timestamp from priceData.fetchedAt — the moment DexScreener was queried, '
  'not the DB insert time. Used as the time-series axis for all charts.';

COMMENT ON COLUMN public.token_price_history.price_sol IS
  'Token price denominated in SOL. Only SOL-denominated pairs are stored; '
  'USDC/USDT pairs are filtered out in fetchTokenPrice() to avoid pollution.';

COMMENT ON COLUMN public.token_price_history.market_cap_usd IS
  'Market cap in USD at snapshot time. Used to compute discovery_score: '
  'the ratio of entry_market_cap (wallet_token_activity) to this peak value '
  'determines how early a wallet entered relative to the token''s growth.';

COMMENT ON COLUMN public.token_price_history.source IS
  'Data provider. Currently always "dexscreener". Reserved for future '
  'multi-source price aggregation (Birdeye, Helius, etc.).';

COMMENT ON COLUMN public.token_price_history.refresh_source IS
  'Caller label passed to insertPriceSnapshot(). Currently "refresh" for '
  'all scheduled runs. Can be "manual" or "backfill" for future use cases.';


-- =============================================================================
-- CONSTRAINTS
-- =============================================================================

-- Deduplicate snapshots: one row per token per refresh cycle.
-- The code in insertPriceSnapshot() catches duplicate key errors explicitly
-- (error.message.includes("duplicate key")) and silently skips them,
-- so this constraint is relied upon as the idempotency guard.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tph_token_snapshotted_unique'
      AND conrelid = 'public.token_price_history'::regclass
  ) THEN
    ALTER TABLE public.token_price_history
      ADD CONSTRAINT tph_token_snapshotted_unique
      UNIQUE (token_address, snapshotted_at);
  END IF;
END $$;


-- =============================================================================
-- INDEXES
-- =============================================================================

-- 1. Per-token time-series queries (price charts, peak-cap lookup)
--    SELECT * FROM token_price_history WHERE token_address = $1 ORDER BY snapshotted_at ASC
CREATE INDEX IF NOT EXISTS tph_token_time_idx
  ON public.token_price_history (token_address, snapshotted_at DESC);

-- 2. Global recency queries (latest snapshot across all tokens)
--    SELECT DISTINCT ON (token_address) … ORDER BY snapshotted_at DESC
CREATE INDEX IF NOT EXISTS tph_snapshotted_at_idx
  ON public.token_price_history (snapshotted_at DESC);

-- 3. Covering index for the scheduler's token lookup
--    (token_address, snapshotted_at) — covers the UNIQUE constraint lookup too
CREATE INDEX IF NOT EXISTS tph_token_address_idx
  ON public.token_price_history (token_address);


-- =============================================================================
-- GRANTS
-- =============================================================================

GRANT SELECT          ON public.token_price_history TO anon;
GRANT SELECT          ON public.token_price_history TO authenticated;
GRANT ALL             ON public.token_price_history TO service_role;


-- =============================================================================
-- ROW LEVEL SECURITY
-- =============================================================================

ALTER TABLE public.token_price_history ENABLE ROW LEVEL SECURITY;

-- Anyone can read price history (charts, public analytics)
CREATE POLICY IF NOT EXISTS "Anyone can read token price history"
  ON public.token_price_history FOR SELECT
  USING (true);

-- Only the backend (service_role key) may insert snapshots
CREATE POLICY IF NOT EXISTS "Service role can insert token price history"
  ON public.token_price_history FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

-- Only the backend may update snapshots (e.g., backfill corrections)
CREATE POLICY IF NOT EXISTS "Service role can update token price history"
  ON public.token_price_history FOR UPDATE
  USING (auth.role() = 'service_role');


-- =============================================================================
-- VERIFICATION QUERIES
-- Run these manually after applying to confirm everything is correct.
-- =============================================================================

-- 1. Confirm the table exists and show row count
--    (should be ≥ 1623 if running against production)
--
--    SELECT COUNT(*) AS total_rows FROM public.token_price_history;

-- 2. Show all columns with their types
--
--    SELECT
--      column_name,
--      data_type,
--      is_nullable,
--      column_default
--    FROM information_schema.columns
--    WHERE table_schema = 'public'
--      AND table_name   = 'token_price_history'
--    ORDER BY ordinal_position;

-- 3. Confirm the unique constraint exists
--
--    SELECT conname, contype, pg_get_constraintdef(oid)
--    FROM pg_constraint
--    WHERE conrelid = 'public.token_price_history'::regclass
--      AND contype  = 'u';

-- 4. Confirm all indexes exist
--
--    SELECT indexname, indexdef
--    FROM pg_indexes
--    WHERE tablename = 'token_price_history'
--    ORDER BY indexname;

-- 5. Confirm RLS is enabled and policies are correctly scoped
--
--    SELECT
--      policyname,
--      cmd,
--      roles,
--      qual,
--      with_check
--    FROM pg_policies
--    WHERE tablename = 'token_price_history'
--    ORDER BY cmd, policyname;

-- 6. Spot-check: latest 5 snapshots to confirm live data is flowing
--
--    SELECT
--      token_address,
--      snapshotted_at,
--      price_sol,
--      price_usd,
--      market_cap_usd,
--      source,
--      trigger
--    FROM public.token_price_history
--    ORDER BY snapshotted_at DESC
--    LIMIT 5;
