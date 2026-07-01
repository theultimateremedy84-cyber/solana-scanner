-- =============================================================================
-- Migration: 20260627000001_security_hardening_and_raw_metrics.sql
--
-- What this migration does (in order):
--
--   1.  ADD missing columns to wallet_performance_history
--         position_status, total_sol_received, total_tokens_bought,
--         total_tokens_sold, current_token_balance, current_position_value_sol,
--         current_token_price_sol, current_token_price_usd,
--         current_market_cap_usd, peak_position_value_sol,
--         reached_100k_mc_at … reached_50m_mc_at (6 timestamp columns)
--
--   2.  CREATE wallet_raw_tx_metrics
--         Raw blockchain aggregates per (wallet × token). Separated from P&L
--         so the scoring formula can change without a re-scan.
--
--   3.  CREATE refresh_wallet_token_counts() SECURITY DEFINER function
--         Called by the worker after bulk wallet upserts to compute
--         total_tokens_traded correctly from wallet_performance_history.
--
--   4.  ADD partial unique index on wallet_collection_jobs
--         Prevents duplicate pending jobs for the same token.
--
--   5.  HARDEN Row Level Security on all four intelligence tables
--         Replace open "Anyone can insert/update" policies with
--         service_role-only write access.
--         SELECT remains open (authenticated and anon can read).
--
-- Apply via Supabase Dashboard → SQL Editor: paste and click Run.
-- Idempotent — safe to run more than once (all DDL uses IF NOT EXISTS /
-- DO $$ … IF NOT EXISTS … $$ guards or DROP IF EXISTS before CREATE).
-- =============================================================================


-- =============================================================================
-- 1.  ADD MISSING COLUMNS TO wallet_performance_history
-- =============================================================================

-- Position lifecycle — only moves forward: UNKNOWN→OPEN→PARTIALLY_CLOSED→CLOSED
ALTER TABLE public.wallet_performance_history
  ADD COLUMN IF NOT EXISTS position_status TEXT
    CHECK (position_status IN ('OPEN','PARTIALLY_CLOSED','CLOSED','UNKNOWN'));

-- Raw SOL accounting (canonical names — current_value kept for compatibility)
ALTER TABLE public.wallet_performance_history
  ADD COLUMN IF NOT EXISTS total_sol_received       NUMERIC;

-- Token quantity tracking (raw blockchain counts)
ALTER TABLE public.wallet_performance_history
  ADD COLUMN IF NOT EXISTS total_tokens_bought      NUMERIC;

ALTER TABLE public.wallet_performance_history
  ADD COLUMN IF NOT EXISTS total_tokens_sold        NUMERIC;

-- Live position snapshot (recomputed on every price refresh)
ALTER TABLE public.wallet_performance_history
  ADD COLUMN IF NOT EXISTS current_token_balance    NUMERIC;

ALTER TABLE public.wallet_performance_history
  ADD COLUMN IF NOT EXISTS current_position_value_sol NUMERIC;

ALTER TABLE public.wallet_performance_history
  ADD COLUMN IF NOT EXISTS current_token_price_sol  NUMERIC;

ALTER TABLE public.wallet_performance_history
  ADD COLUMN IF NOT EXISTS current_token_price_usd  NUMERIC;

ALTER TABLE public.wallet_performance_history
  ADD COLUMN IF NOT EXISTS current_market_cap_usd   NUMERIC;

-- Peak position value (monotonically non-decreasing — never set to a lower value)
ALTER TABLE public.wallet_performance_history
  ADD COLUMN IF NOT EXISTS peak_position_value_sol  NUMERIC;

-- Market-cap milestone timestamps — stamped once, never cleared
-- Companion to the existing reached_*_mc boolean flags.
ALTER TABLE public.wallet_performance_history
  ADD COLUMN IF NOT EXISTS reached_100k_mc_at       TIMESTAMPTZ;

ALTER TABLE public.wallet_performance_history
  ADD COLUMN IF NOT EXISTS reached_500k_mc_at       TIMESTAMPTZ;

ALTER TABLE public.wallet_performance_history
  ADD COLUMN IF NOT EXISTS reached_1m_mc_at         TIMESTAMPTZ;

ALTER TABLE public.wallet_performance_history
  ADD COLUMN IF NOT EXISTS reached_5m_mc_at         TIMESTAMPTZ;

ALTER TABLE public.wallet_performance_history
  ADD COLUMN IF NOT EXISTS reached_10m_mc_at        TIMESTAMPTZ;

ALTER TABLE public.wallet_performance_history
  ADD COLUMN IF NOT EXISTS reached_50m_mc_at        TIMESTAMPTZ;

-- Backfill position_status for all existing rows with enough data to classify.
-- Rows from holder_scan have investedSol=0 → UNKNOWN.
-- Rows with sold >= 95% of bought → CLOSED.
-- Rows with some sells but not closed → PARTIALLY_CLOSED.
-- Rows with no sells but real investment → OPEN.
-- All others default to UNKNOWN.
UPDATE public.wallet_performance_history
SET position_status = CASE
  WHEN initial_investment = 0
    THEN 'UNKNOWN'
  WHEN current_value = 0 AND realized_profit = 0
    THEN 'OPEN'
  WHEN realized_profit > 0 AND unrealized_profit = 0
    THEN 'CLOSED'
  WHEN realized_profit > 0 AND unrealized_profit > 0
    THEN 'PARTIALLY_CLOSED'
  ELSE 'UNKNOWN'
END
WHERE position_status IS NULL;

-- Add supporting index for the price-refresh scheduler's primary query:
--   SELECT token_address FROM wallet_performance_history
--   WHERE position_status IN ('OPEN','PARTIALLY_CLOSED')
CREATE INDEX IF NOT EXISTS wph_position_status_idx
  ON public.wallet_performance_history (position_status, token_address)
  WHERE position_status IN ('OPEN', 'PARTIALLY_CLOSED');

COMMENT ON COLUMN public.wallet_performance_history.position_status IS
  'Lifecycle status: UNKNOWN (no evidence) → OPEN (holding) → '
  'PARTIALLY_CLOSED (some sells) → CLOSED (fully exited). '
  'Only moves forward — never set to a lower-quality status.';

COMMENT ON COLUMN public.wallet_performance_history.total_sol_received IS
  'Total SOL received from all sell transactions for this position. '
  'Semantically correct name for what current_value stores '
  '(current_value kept for backwards compatibility).';

COMMENT ON COLUMN public.wallet_performance_history.peak_position_value_sol IS
  'Highest mark-to-market value of the position ever observed, in SOL. '
  'Monotonically non-decreasing — never written with a lower value.';

COMMENT ON COLUMN public.wallet_performance_history.reached_100k_mc_at IS
  'Timestamp when the token first crossed a $100K market cap '
  'while this wallet held a position. Stamped once, never cleared.';


-- =============================================================================
-- 2.  CREATE wallet_raw_tx_metrics
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.wallet_raw_tx_metrics (
  id                        UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  wallet_address            TEXT        NOT NULL,
  token_address             TEXT        NOT NULL,

  -- Raw transaction counts (directly from blockchain — never estimated)
  total_buy_txs             INTEGER     NOT NULL DEFAULT 0,
  total_sell_txs            INTEGER     NOT NULL DEFAULT 0,

  -- Raw token quantity aggregates
  total_tokens_bought       NUMERIC     NOT NULL DEFAULT 0,
  total_tokens_sold         NUMERIC     NOT NULL DEFAULT 0,

  -- Raw SOL flow aggregates
  total_sol_invested        NUMERIC     NOT NULL DEFAULT 0,  -- SOL paid across all buys
  total_sol_received        NUMERIC     NOT NULL DEFAULT 0,  -- SOL received across all sells

  -- Derived from token quantities (max(0, bought - sold))
  current_token_balance     NUMERIC     NOT NULL DEFAULT 0,

  -- Data quality tier — monotonically increasing, never downgraded
  --   holder_scan (0) < pool_extraction (1) < helius_full_history (2)
  data_source               TEXT        NOT NULL
    CHECK (data_source IN ('holder_scan', 'pool_extraction', 'helius_full_history')),

  -- Optional: total on-chain signatures fetched during the scan
  total_signatures_scanned  INTEGER,

  -- Transaction timestamps (from on-chain data)
  first_tx_at               TIMESTAMPTZ,
  last_tx_at                TIMESTAMPTZ,

  -- Housekeeping
  last_scanned_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.wallet_raw_tx_metrics IS
  'Raw blockchain aggregates per (wallet × token). '
  'Stores ONLY what is directly computable from on-chain transactions — '
  'buy/sell counts, SOL invested/received, token amounts. '
  'P&L and intelligence scores live in separate tables. '
  'Changing the scoring formula only touches wallets — no re-scan needed.';

COMMENT ON COLUMN public.wallet_raw_tx_metrics.data_source IS
  'Quality tier of the scan that produced this row: '
  'holder_scan (lowest) | pool_extraction | helius_full_history (highest). '
  'A row is never overwritten by a lower-tier source.';

COMMENT ON COLUMN public.wallet_raw_tx_metrics.total_sol_invested IS
  'Total SOL spent buying this token across ALL buy transactions. '
  'Raw aggregate — never estimated or interpolated.';

-- Primary lookup: one row per (wallet × token)
CREATE UNIQUE INDEX IF NOT EXISTS wrm_wallet_token_idx
  ON public.wallet_raw_tx_metrics (wallet_address, token_address);

-- Support classifyWallets() which reads all tokens for a set of wallets
CREATE INDEX IF NOT EXISTS wrm_wallet_idx
  ON public.wallet_raw_tx_metrics (wallet_address);

-- Support per-token analytics queries
CREATE INDEX IF NOT EXISTS wrm_token_idx
  ON public.wallet_raw_tx_metrics (token_address);

-- Grants
GRANT SELECT, INSERT, UPDATE ON public.wallet_raw_tx_metrics TO anon;
GRANT SELECT, INSERT, UPDATE ON public.wallet_raw_tx_metrics TO authenticated;
GRANT ALL                     ON public.wallet_raw_tx_metrics TO service_role;

-- RLS (write access hardened in Step 5 below)
ALTER TABLE public.wallet_raw_tx_metrics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read wallet raw tx metrics"
  ON public.wallet_raw_tx_metrics;
DROP POLICY IF EXISTS "Service role can insert wallet raw tx metrics"
  ON public.wallet_raw_tx_metrics;
DROP POLICY IF EXISTS "Service role can update wallet raw tx metrics"
  ON public.wallet_raw_tx_metrics;

CREATE POLICY "Anyone can read wallet raw tx metrics"
  ON public.wallet_raw_tx_metrics FOR SELECT USING (true);

CREATE POLICY "Service role can insert wallet raw tx metrics"
  ON public.wallet_raw_tx_metrics FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Service role can update wallet raw tx metrics"
  ON public.wallet_raw_tx_metrics FOR UPDATE
  USING (auth.role() = 'service_role');


-- =============================================================================
-- 3.  CREATE refresh_wallet_token_counts() SECURITY DEFINER FUNCTION
--
-- Called by the worker after each bulk wallet upsert:
--   sb.rpc("refresh_wallet_token_counts", { p_wallet_addresses: [...] })
--
-- Sets wallets.total_tokens_traded to the number of distinct tokens
-- in wallet_performance_history for each wallet — the only correct source.
-- SECURITY DEFINER so it runs as the table owner regardless of caller role.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.refresh_wallet_token_counts(
  p_wallet_addresses TEXT[]
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.wallets w
  SET
    total_tokens_traded = sub.token_count,
    updated_at          = now()
  FROM (
    SELECT
      wallet_address,
      COUNT(DISTINCT token_address) AS token_count
    FROM public.wallet_performance_history
    WHERE wallet_address = ANY(p_wallet_addresses)
    GROUP BY wallet_address
  ) sub
  WHERE w.wallet_address = sub.wallet_address;
END;
$$;

COMMENT ON FUNCTION public.refresh_wallet_token_counts(TEXT[]) IS
  'Recomputes wallets.total_tokens_traded for each address in the input array '
  'by counting distinct token_address rows in wallet_performance_history. '
  'Called by the collection worker after each bulk upsert. '
  'SECURITY DEFINER — runs as table owner regardless of caller role.';

-- Grant execute to anon/authenticated so the Supabase client (even with anon key)
-- can invoke it. The function itself only updates wallets rows matching the
-- provided addresses — it cannot be abused to modify arbitrary rows.
GRANT EXECUTE ON FUNCTION public.refresh_wallet_token_counts(TEXT[]) TO anon;
GRANT EXECUTE ON FUNCTION public.refresh_wallet_token_counts(TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_wallet_token_counts(TEXT[]) TO service_role;


-- =============================================================================
-- 4.  PARTIAL UNIQUE INDEX on wallet_collection_jobs
--
-- Prevents two pending jobs for the same token from being enqueued
-- simultaneously. Only one row per token_address may have status='pending'.
-- Does not block multiple done/failed rows for the same token (history is kept).
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS wcj_token_pending_unique_idx
  ON public.wallet_collection_jobs (token_address)
  WHERE status = 'pending';

COMMENT ON INDEX public.wcj_token_pending_unique_idx IS
  'Ensures at most one pending job exists per token_address at any time. '
  'Does not prevent multiple done or failed rows for the same token.';


-- =============================================================================
-- 5.  HARDEN ROW LEVEL SECURITY
--
-- Replace the original open "Anyone can insert/update" policies on all four
-- intelligence tables with service_role-only write access.
--
-- SELECT stays open — anyone (anon/authenticated) can read intelligence data.
-- INSERT/UPDATE are restricted to service_role (the backend worker key).
--
-- Tables hardened:
--   wallets
--   wallet_token_activity
--   wallet_performance_history
--   wallet_collection_jobs
-- =============================================================================

-- ── wallets ──────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Anyone can insert wallets"         ON public.wallets;
DROP POLICY IF EXISTS "Anyone can update wallets"         ON public.wallets;

CREATE POLICY "Service role can insert wallets"
  ON public.wallets FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Service role can update wallets"
  ON public.wallets FOR UPDATE
  USING (auth.role() = 'service_role');

-- ── wallet_token_activity ────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Anyone can insert wallet token activity" ON public.wallet_token_activity;

CREATE POLICY "Service role can insert wallet token activity"
  ON public.wallet_token_activity FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

-- ── wallet_performance_history ───────────────────────────────────────────────

DROP POLICY IF EXISTS "Anyone can insert wallet performance history" ON public.wallet_performance_history;
DROP POLICY IF EXISTS "Anyone can update wallet performance history" ON public.wallet_performance_history;

CREATE POLICY "Service role can insert wallet performance history"
  ON public.wallet_performance_history FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Service role can update wallet performance history"
  ON public.wallet_performance_history FOR UPDATE
  USING (auth.role() = 'service_role');

-- ── wallet_collection_jobs ───────────────────────────────────────────────────

DROP POLICY IF EXISTS "Anyone can insert wallet collection jobs" ON public.wallet_collection_jobs;
DROP POLICY IF EXISTS "Anyone can update wallet collection jobs" ON public.wallet_collection_jobs;

CREATE POLICY "Service role can insert wallet collection jobs"
  ON public.wallet_collection_jobs FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Service role can update wallet collection jobs"
  ON public.wallet_collection_jobs FOR UPDATE
  USING (auth.role() = 'service_role');


-- =============================================================================
-- VERIFY (run these SELECT statements manually to confirm success)
-- =============================================================================

-- 1. Confirm all new columns exist on wallet_performance_history:
--    SELECT column_name, data_type
--    FROM information_schema.columns
--    WHERE table_name = 'wallet_performance_history'
--    ORDER BY ordinal_position;

-- 2. Confirm wallet_raw_tx_metrics was created:
--    SELECT COUNT(*) FROM public.wallet_raw_tx_metrics;

-- 3. Confirm the function exists:
--    SELECT proname, prosecdef FROM pg_proc WHERE proname = 'refresh_wallet_token_counts';

-- 4. Confirm partial unique index exists:
--    SELECT indexname FROM pg_indexes
--    WHERE tablename = 'wallet_collection_jobs'
--    AND indexname = 'wcj_token_pending_unique_idx';

-- 5. Confirm hardened policies (should show 'service_role' in qual/with_check):
--    SELECT tablename, policyname, cmd, qual, with_check
--    FROM pg_policies
--    WHERE tablename IN (
--      'wallets','wallet_token_activity',
--      'wallet_performance_history','wallet_collection_jobs'
--    )
--    ORDER BY tablename, cmd;
-- =============================================================================
