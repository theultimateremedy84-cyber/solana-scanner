-- =============================================================================
-- Wallet Intelligence Infrastructure
-- Migration: 20260623000001_wallet_intelligence_infrastructure.sql
--
-- Creates three brand-new tables. Does NOT touch scan_history or any
-- existing tables.
--
-- Apply via:
--   Option A — Supabase Dashboard SQL Editor: paste and run.
--   Option B — CLI: supabase db push  (after supabase link)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. wallets — one row per unique wallet address
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wallets (
  id                        UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  wallet_address            TEXT        NOT NULL,
  first_seen_timestamp      TIMESTAMPTZ,
  last_seen_timestamp       TIMESTAMPTZ,

  -- Trading activity counters
  total_tokens_traded       INTEGER     NOT NULL DEFAULT 0,
  total_buys                INTEGER     NOT NULL DEFAULT 0,
  total_sells               INTEGER     NOT NULL DEFAULT 0,

  -- Volume in USD
  total_volume_bought_usd   NUMERIC     NOT NULL DEFAULT 0,
  total_volume_sold_usd     NUMERIC     NOT NULL DEFAULT 0,

  -- P&L
  realized_pnl              NUMERIC     NOT NULL DEFAULT 0,
  unrealized_pnl            NUMERIC     NOT NULL DEFAULT 0,

  -- Performance metrics (0-1 for rates, multiplier for ROI)
  win_rate                  NUMERIC,
  average_roi               NUMERIC,

  -- Intelligence scoring
  discovery_score           NUMERIC,    -- how early the wallet enters tokens
  conviction_score          NUMERIC,    -- holding behaviour / diamond-hands signal
  intelligence_score        NUMERIC,    -- composite score (0-100)

  -- Classification label (e.g. 'smart_money', 'bot', 'retail', 'whale', 'sniper')
  wallet_classification     TEXT,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT wallets_wallet_address_unique UNIQUE (wallet_address)
);

COMMENT ON TABLE  public.wallets IS
  'One row per unique Solana wallet observed trading meme coins. '
  'Aggregated stats, P&L, and intelligence scores. '
  'Do not alter existing scan_history / token tables.';

COMMENT ON COLUMN public.wallets.discovery_score IS
  'Score reflecting how early the wallet enters tokens relative to market-cap '
  'at entry. Higher = consistently earlier.';

COMMENT ON COLUMN public.wallets.conviction_score IS
  'Score reflecting holding behaviour — wallets that hold through volatility '
  'receive a higher conviction score.';

COMMENT ON COLUMN public.wallets.intelligence_score IS
  'Composite 0–100 score combining win_rate, average_roi, discovery_score, '
  'and conviction_score. Primary ranking signal.';

COMMENT ON COLUMN public.wallets.wallet_classification IS
  'Classification label: smart_money | sniper | bot | whale | retail | unknown.';

-- ---------------------------------------------------------------------------
-- 2. wallet_token_activity — one row per transaction event
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wallet_token_activity (
  id                      UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  wallet_address          TEXT        NOT NULL,
  token_address           TEXT        NOT NULL,
  transaction_signature   TEXT        NOT NULL,

  -- Trade direction
  action_type             TEXT        NOT NULL CHECK (action_type IN ('buy', 'sell')),

  -- Trade size
  amount_sol              NUMERIC,
  amount_usd              NUMERIC,
  token_amount            NUMERIC,

  -- Timestamp of the on-chain transaction
  timestamp               TIMESTAMPTZ NOT NULL,

  -- Market context at the time of the trade
  entry_market_cap        NUMERIC,
  liquidity_at_entry      NUMERIC,
  holder_count_at_entry   INTEGER,
  token_age_at_entry      INTEGER     -- seconds since token mint

  -- NOTE: no FK to wallets or scan_history — avoids coupling to
  --       existing tables and allows insert order independence.
);

COMMENT ON TABLE  public.wallet_token_activity IS
  'Individual buy/sell events observed for a wallet × token pair. '
  'Each row corresponds to a single on-chain transaction.';

COMMENT ON COLUMN public.wallet_token_activity.transaction_signature IS
  'Solana transaction signature (base58). Used for deduplication.';

COMMENT ON COLUMN public.wallet_token_activity.token_age_at_entry IS
  'Seconds elapsed between the token mint timestamp and this transaction. '
  'Low values indicate a sniper / early-entry wallet.';

-- ---------------------------------------------------------------------------
-- 3. wallet_performance_history — per-wallet × per-token P&L breakdown
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wallet_performance_history (
  id                  UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  wallet_address      TEXT        NOT NULL,
  token_address       TEXT        NOT NULL,

  -- Investment tracking
  initial_investment  NUMERIC     NOT NULL DEFAULT 0,
  current_value       NUMERIC     NOT NULL DEFAULT 0,
  realized_profit     NUMERIC     NOT NULL DEFAULT 0,
  unrealized_profit   NUMERIC     NOT NULL DEFAULT 0,

  -- Return metrics
  roi_multiple        NUMERIC,    -- e.g. 3.5 = 3.5×
  peak_roi            NUMERIC,    -- highest roi_multiple ever observed

  -- Market-cap milestone flags (TRUE when token crossed that cap
  --   while the wallet still held a position)
  reached_100k_mc     BOOLEAN     NOT NULL DEFAULT FALSE,
  reached_500k_mc     BOOLEAN     NOT NULL DEFAULT FALSE,
  reached_1m_mc       BOOLEAN     NOT NULL DEFAULT FALSE,
  reached_5m_mc       BOOLEAN     NOT NULL DEFAULT FALSE,
  reached_10m_mc      BOOLEAN     NOT NULL DEFAULT FALSE,
  reached_50m_mc      BOOLEAN     NOT NULL DEFAULT FALSE,

  last_updated        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.wallet_performance_history IS
  'Per-wallet × per-token P&L and market-cap milestone tracking. '
  'One row per (wallet_address, token_address) pair; upserted on each update.';

COMMENT ON COLUMN public.wallet_performance_history.roi_multiple IS
  'Current return multiple on the initial_investment. '
  'Calculated as (current_value + realized_profit) / initial_investment.';

COMMENT ON COLUMN public.wallet_performance_history.peak_roi IS
  'Highest roi_multiple ever observed for this position. '
  'Useful for understanding max-gain potential of a wallet''s strategy.';


-- =============================================================================
-- INDEXES
-- =============================================================================

-- wallets: look up by address (covered by unique constraint) + sort by score
CREATE INDEX IF NOT EXISTS wallets_intelligence_score_idx
  ON public.wallets (intelligence_score DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS wallets_classification_idx
  ON public.wallets (wallet_classification, intelligence_score DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS wallets_win_rate_idx
  ON public.wallets (win_rate DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS wallets_last_seen_idx
  ON public.wallets (last_seen_timestamp DESC NULLS LAST);

-- wallet_token_activity: the two most common query shapes
CREATE INDEX IF NOT EXISTS wta_wallet_time_idx
  ON public.wallet_token_activity (wallet_address, timestamp DESC);

CREATE INDEX IF NOT EXISTS wta_token_time_idx
  ON public.wallet_token_activity (token_address, timestamp DESC);

CREATE INDEX IF NOT EXISTS wta_wallet_token_idx
  ON public.wallet_token_activity (wallet_address, token_address, timestamp DESC);

CREATE UNIQUE INDEX IF NOT EXISTS wta_signature_unique_idx
  ON public.wallet_token_activity (transaction_signature);

-- wallet_performance_history: primary look-up patterns
CREATE UNIQUE INDEX IF NOT EXISTS wph_wallet_token_idx
  ON public.wallet_performance_history (wallet_address, token_address);

CREATE INDEX IF NOT EXISTS wph_wallet_roi_idx
  ON public.wallet_performance_history (wallet_address, roi_multiple DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS wph_last_updated_idx
  ON public.wallet_performance_history (last_updated DESC);


-- =============================================================================
-- GRANTS
-- =============================================================================

GRANT SELECT, INSERT, UPDATE ON public.wallets TO anon;
GRANT SELECT, INSERT, UPDATE ON public.wallets TO authenticated;
GRANT ALL                     ON public.wallets TO service_role;

GRANT SELECT, INSERT          ON public.wallet_token_activity TO anon;
GRANT SELECT, INSERT          ON public.wallet_token_activity TO authenticated;
GRANT ALL                     ON public.wallet_token_activity TO service_role;

GRANT SELECT, INSERT, UPDATE  ON public.wallet_performance_history TO anon;
GRANT SELECT, INSERT, UPDATE  ON public.wallet_performance_history TO authenticated;
GRANT ALL                     ON public.wallet_performance_history TO service_role;


-- =============================================================================
-- ROW LEVEL SECURITY
-- =============================================================================

ALTER TABLE public.wallets                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_token_activity    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_performance_history ENABLE ROW LEVEL SECURITY;

-- wallets
CREATE POLICY "Anyone can read wallets"
  ON public.wallets FOR SELECT USING (true);

CREATE POLICY "Anyone can insert wallets"
  ON public.wallets FOR INSERT WITH CHECK (true);

CREATE POLICY "Anyone can update wallets"
  ON public.wallets FOR UPDATE USING (true);

-- wallet_token_activity
CREATE POLICY "Anyone can read wallet token activity"
  ON public.wallet_token_activity FOR SELECT USING (true);

CREATE POLICY "Anyone can insert wallet token activity"
  ON public.wallet_token_activity FOR INSERT WITH CHECK (true);

-- wallet_performance_history
CREATE POLICY "Anyone can read wallet performance history"
  ON public.wallet_performance_history FOR SELECT USING (true);

CREATE POLICY "Anyone can insert wallet performance history"
  ON public.wallet_performance_history FOR INSERT WITH CHECK (true);

CREATE POLICY "Anyone can update wallet performance history"
  ON public.wallet_performance_history FOR UPDATE USING (true);
