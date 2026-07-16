-- =============================================================================
-- Migration: 20260716000011_intelligence_snapshots.sql
--
-- PURPOSE
--   Create an immutable time-series table that stores daily snapshots of
--   wallet scores, confidence tiers, and developer reputation. Never overwrites
--   historical data — always appends. This is the moat asset: in 12-24 months
--   it becomes the only dataset that can answer questions like:
--     "How did this wallet's reputation evolve over 18 months?"
--     "Which developers steadily improved their graduation rate?"
--
--   No competitor can recreate this history retroactively.
--
-- TABLES CREATED
--   1. intelligence_snapshots — daily wallet score snapshots
--   2. developer_reputation_snapshots — daily developer reputation snapshots
--   3. token_risk_snapshots — daily token risk snapshots
--
-- DESIGN PRINCIPLES
--   - All rows are INSERT-only. No UPDATE or DELETE allowed via RLS.
--   - Each table has a unique constraint on (entity_id, snapshot_date) so
--     daily snapshot jobs are idempotent (ON CONFLICT DO NOTHING).
--   - snapshot_date is DATE (not TIMESTAMPTZ) so one row per day per entity.
--   - All score columns are nullable — a null means "not computed on this day",
--     which is different from a score of 0.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. intelligence_snapshots — wallet score history
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.intelligence_snapshots (
  id                    UUID          NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  wallet_address        TEXT          NOT NULL,
  snapshot_date         DATE          NOT NULL DEFAULT CURRENT_DATE,

  -- Scores at time of snapshot
  intelligence_score    NUMERIC,      -- 0-1 normalized (v8 formula)
  discovery_score       NUMERIC,      -- 0-1 normalized
  conviction_score      NUMERIC,
  win_rate              NUMERIC,      -- 0-1
  average_roi           NUMERIC,      -- multiple (e.g. 3.5 = 3.5x)

  -- Classification
  wallet_classification TEXT,
  confidence_tier       TEXT,         -- elite|high|medium|low|unrated
  evidence_quality      TEXT,         -- raw|fallback|none

  -- Activity counters at snapshot time
  total_buys            INTEGER,
  total_sells           INTEGER,
  verified_positions    INTEGER,
  closed_position_count INTEGER,

  -- Metadata
  snapshotted_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),

  CONSTRAINT intelligence_snapshots_wallet_date_unique
    UNIQUE (wallet_address, snapshot_date)
);

COMMENT ON TABLE public.intelligence_snapshots IS
  'Immutable daily snapshots of wallet intelligence scores. INSERT-only — '
  'never UPDATE or DELETE. Append new rows to build the historical timeline. '
  'Created 2026-07-16. After 12 months this becomes the moat data asset.';

CREATE INDEX IF NOT EXISTS idx_intel_snap_wallet_date
  ON public.intelligence_snapshots (wallet_address, snapshot_date DESC);

CREATE INDEX IF NOT EXISTS idx_intel_snap_date
  ON public.intelligence_snapshots (snapshot_date DESC);

-- ---------------------------------------------------------------------------
-- 2. developer_reputation_snapshots — developer reputation history
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.developer_reputation_snapshots (
  id                        UUID    NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  developer_wallet          TEXT    NOT NULL,
  snapshot_date             DATE    NOT NULL DEFAULT CURRENT_DATE,

  -- Reputation at snapshot time
  developer_classification  TEXT,   -- clean|suspicious|serial_offender|confirmed_scammer
  total_tokens_launched     INTEGER,
  graduated_count           INTEGER,
  high_risk_count           INTEGER,
  graduation_rate           NUMERIC, -- 0-1

  -- Metadata
  snapshotted_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT dev_rep_snap_wallet_date_unique
    UNIQUE (developer_wallet, snapshot_date)
);

COMMENT ON TABLE public.developer_reputation_snapshots IS
  'Immutable daily snapshots of developer reputation. INSERT-only. '
  'Enables "developer track record over time" queries for paid tiers.';

CREATE INDEX IF NOT EXISTS idx_dev_snap_wallet_date
  ON public.developer_reputation_snapshots (developer_wallet, snapshot_date DESC);

-- ---------------------------------------------------------------------------
-- 3. token_risk_snapshots — token risk score history
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.token_risk_snapshots (
  id                UUID    NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  token_address     TEXT    NOT NULL,
  snapshot_date     DATE    NOT NULL DEFAULT CURRENT_DATE,

  -- Risk at snapshot time
  risk_score        INTEGER,
  risk_level        TEXT,             -- LOW|MEDIUM|HIGH|CRITICAL
  honey_pot_status  TEXT,
  market_cap        NUMERIC,
  liquidity         NUMERIC,
  holder_count      INTEGER,
  graduated         BOOLEAN DEFAULT FALSE,

  -- Metadata
  snapshotted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT token_risk_snap_addr_date_unique
    UNIQUE (token_address, snapshot_date)
);

COMMENT ON TABLE public.token_risk_snapshots IS
  'Immutable daily snapshots of token risk scores. INSERT-only. '
  'Tracks how a token risk profile evolves from launch through graduation.';

CREATE INDEX IF NOT EXISTS idx_token_snap_addr_date
  ON public.token_risk_snapshots (token_address, snapshot_date DESC);

-- ---------------------------------------------------------------------------
-- Row Level Security — SELECT open, write restricted to service_role
-- ---------------------------------------------------------------------------

ALTER TABLE public.intelligence_snapshots          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.developer_reputation_snapshots  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.token_risk_snapshots            ENABLE ROW LEVEL SECURITY;

-- Read: anyone can read snapshots (they're the product surface)
CREATE POLICY "Anyone can read intelligence snapshots"
  ON public.intelligence_snapshots FOR SELECT USING (true);
CREATE POLICY "Anyone can read developer reputation snapshots"
  ON public.developer_reputation_snapshots FOR SELECT USING (true);
CREATE POLICY "Anyone can read token risk snapshots"
  ON public.token_risk_snapshots FOR SELECT USING (true);

-- Write: only service_role (the pipeline) can insert — no UPDATE or DELETE ever
CREATE POLICY "Only service_role can insert intelligence snapshots"
  ON public.intelligence_snapshots FOR INSERT
  WITH CHECK (auth.role() = 'service_role');
CREATE POLICY "Only service_role can insert developer reputation snapshots"
  ON public.developer_reputation_snapshots FOR INSERT
  WITH CHECK (auth.role() = 'service_role');
CREATE POLICY "Only service_role can insert token risk snapshots"
  ON public.token_risk_snapshots FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

-- Grants
GRANT SELECT ON public.intelligence_snapshots TO anon, authenticated;
GRANT INSERT ON public.intelligence_snapshots TO service_role;
GRANT SELECT ON public.developer_reputation_snapshots TO anon, authenticated;
GRANT INSERT ON public.developer_reputation_snapshots TO service_role;
GRANT SELECT ON public.token_risk_snapshots TO anon, authenticated;
GRANT INSERT ON public.token_risk_snapshots TO service_role;

-- ---------------------------------------------------------------------------
-- Seed first snapshot from current wallet data (backfill today's state)
-- Run this AFTER applying the migration to capture today's baseline.
-- ---------------------------------------------------------------------------

-- Seed intelligence_snapshots for all scored wallets
INSERT INTO public.intelligence_snapshots (
  wallet_address, snapshot_date, intelligence_score, discovery_score,
  conviction_score, win_rate, average_roi, wallet_classification,
  confidence_tier, evidence_quality, total_buys, total_sells,
  verified_positions, closed_position_count, snapshotted_at
)
SELECT
  w.wallet_address,
  CURRENT_DATE,
  w.intelligence_score,
  w.discovery_score,
  w.conviction_score,
  w.win_rate,
  w.average_roi,
  w.wallet_classification,
  w.confidence_tier,
  w.evidence_quality,
  w.total_buys,
  w.total_sells,
  w.verified_positions,
  w.closed_position_count,
  now()
FROM public.wallets w
WHERE w.intelligence_score IS NOT NULL
ON CONFLICT (wallet_address, snapshot_date) DO NOTHING;

-- Seed developer_reputation_snapshots from scan_history
INSERT INTO public.developer_reputation_snapshots (
  developer_wallet, snapshot_date, total_tokens_launched,
  graduated_count, high_risk_count, graduation_rate, snapshotted_at
)
SELECT
  developer_wallet,
  CURRENT_DATE,
  COUNT(*) AS total_tokens_launched,
  COUNT(*) FILTER (WHERE graduated_at IS NOT NULL) AS graduated_count,
  COUNT(*) FILTER (WHERE risk_level IN ('HIGH', 'CRITICAL')) AS high_risk_count,
  CASE
    WHEN COUNT(*) > 0
    THEN COUNT(*) FILTER (WHERE graduated_at IS NOT NULL)::NUMERIC / COUNT(*)
    ELSE 0
  END AS graduation_rate,
  now()
FROM public.scan_history
WHERE developer_wallet IS NOT NULL
  AND source = 'discovery'
GROUP BY developer_wallet
ON CONFLICT (developer_wallet, snapshot_date) DO NOTHING;

-- Seed token_risk_snapshots from scan_history
INSERT INTO public.token_risk_snapshots (
  token_address, snapshot_date, risk_score, risk_level,
  honey_pot_status, market_cap, liquidity, holder_count,
  graduated, snapshotted_at
)
SELECT
  token_address,
  CURRENT_DATE,
  risk_score,
  risk_level,
  honey_pot_status,
  market_cap,
  liquidity,
  holder_count,
  graduated_at IS NOT NULL,
  now()
FROM public.scan_history
ON CONFLICT (token_address, snapshot_date) DO NOTHING;

-- Verification:
-- SELECT COUNT(*) FROM intelligence_snapshots WHERE snapshot_date = CURRENT_DATE;
-- SELECT COUNT(*) FROM developer_reputation_snapshots WHERE snapshot_date = CURRENT_DATE;
-- SELECT COUNT(*) FROM token_risk_snapshots WHERE snapshot_date = CURRENT_DATE;
