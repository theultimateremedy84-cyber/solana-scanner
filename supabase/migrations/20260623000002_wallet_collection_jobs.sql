-- =============================================================================
-- Wallet Collection Jobs Table
-- Migration: 20260623000002_wallet_collection_jobs.sql
--
-- Persists in-memory queue state to Postgres so job history is durable
-- and queryable even after a server restart.
--
-- Apply via Supabase Dashboard SQL Editor or CLI:
--   supabase db push
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.wallet_collection_jobs (
  id                  UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  token_address       TEXT        NOT NULL,
  pool_address        TEXT,

  -- Job lifecycle
  status              TEXT        NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  attempts            INTEGER     NOT NULL DEFAULT 0,

  -- Collection results (populated on completion)
  traders_collected   INTEGER,
  buyers_collected    INTEGER,
  sellers_collected   INTEGER,
  skipped_dust        INTEGER,

  -- Error details
  errors              TEXT[],
  last_error          TEXT,

  -- Market context captured at scan time
  market_cap_usd      NUMERIC,
  liquidity_usd       NUMERIC,
  holder_count        INTEGER,

  -- Timestamps
  enqueued_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ
);

COMMENT ON TABLE public.wallet_collection_jobs IS
  'Durable record of every wallet collection job. '
  'Mirrors the in-memory WalletCollectionQueue state to Postgres. '
  'Does NOT alter scan_history or any existing tables.';

-- Indexes
CREATE INDEX IF NOT EXISTS wcj_token_address_idx
  ON public.wallet_collection_jobs (token_address, enqueued_at DESC);

CREATE INDEX IF NOT EXISTS wcj_status_idx
  ON public.wallet_collection_jobs (status, enqueued_at DESC);

CREATE INDEX IF NOT EXISTS wcj_enqueued_at_idx
  ON public.wallet_collection_jobs (enqueued_at DESC);

-- Grants
GRANT SELECT, INSERT, UPDATE ON public.wallet_collection_jobs TO anon;
GRANT SELECT, INSERT, UPDATE ON public.wallet_collection_jobs TO authenticated;
GRANT ALL                     ON public.wallet_collection_jobs TO service_role;

-- RLS
ALTER TABLE public.wallet_collection_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read wallet collection jobs"
  ON public.wallet_collection_jobs FOR SELECT USING (true);

CREATE POLICY "Anyone can insert wallet collection jobs"
  ON public.wallet_collection_jobs FOR INSERT WITH CHECK (true);

CREATE POLICY "Anyone can update wallet collection jobs"
  ON public.wallet_collection_jobs FOR UPDATE USING (true);
