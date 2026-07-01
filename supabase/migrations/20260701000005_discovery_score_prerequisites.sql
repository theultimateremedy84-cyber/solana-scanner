-- =============================================================================
-- Migration: 20260701000005_discovery_score_prerequisites.sql
-- Purpose:   Three-part prerequisite patch for P2-B Discovery Score
--
--   PRE-1  Verify token_price_history has a unique constraint so the
--          price-refresh worker's duplicate-key guard is reliable.
--
--   PRE-2  Backfill entry_market_cap / liquidity_at_entry on
--          wallet_token_activity from wallet_collection_jobs.
--          Historical rows were written before market_cap_usd was reliably
--          populated in jobs; this one-time UPDATE closes that gap.
--          New activity rows are already written correctly by the worker
--          (persistActivity line 444: entry_market_cap: job.marketCapUsd ?? null).
--
--   PRE-3  Add discovery score support columns to the wallets table.
--          wallets.discovery_score already exists (all NULL).
--          Add: discovery_confidence, discovery_tier,
--               total_discoveries, successful_discoveries, avg_entry_market_cap.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- PRE-1 — token_price_history unique constraint
-- ─────────────────────────────────────────────────────────────────────────────
-- The price-refresh worker (insertPriceSnapshot) checks for
-- error.message.includes("duplicate key") to silently skip re-inserts.
-- This index makes that guard reliable.  IF NOT EXISTS is safe to run again.

CREATE UNIQUE INDEX IF NOT EXISTS idx_token_price_history_uniq_snapshot
  ON token_price_history (token_address, snapshotted_at);

-- Single-token lookup index used by discovery score engine
CREATE INDEX IF NOT EXISTS idx_token_price_history_token_ts
  ON token_price_history (token_address, snapshotted_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- PRE-2 — Backfill entry_market_cap from wallet_collection_jobs
-- ─────────────────────────────────────────────────────────────────────────────
-- Strategy: for each token, take the earliest completed job's market_cap_usd
-- as the proxy for scan-time market cap.  This is accurate because collection
-- runs within minutes of the user scan, so scan-time MC ≈ entry MC for most
-- wallet transactions collected in that job.
--
-- Only rows where entry_market_cap IS NULL are touched; rows already
-- populated (e.g. from recent collections) are left untouched.

UPDATE wallet_token_activity wta
SET
  entry_market_cap   = src.market_cap_usd,
  liquidity_at_entry = src.liquidity_usd
FROM (
  SELECT DISTINCT ON (token_address)
    token_address,
    market_cap_usd,
    liquidity_usd
  FROM wallet_collection_jobs
  WHERE market_cap_usd IS NOT NULL
  ORDER BY token_address, enqueued_at ASC        -- earliest job = closest to launch
) src
WHERE wta.token_address    = src.token_address
  AND wta.entry_market_cap IS NULL;

-- Verify coverage (informational — does not fail if zero rows updated)
DO $$
DECLARE
  total_rows    INT;
  filled_rows   INT;
BEGIN
  SELECT COUNT(*) INTO total_rows  FROM wallet_token_activity;
  SELECT COUNT(*) INTO filled_rows FROM wallet_token_activity WHERE entry_market_cap IS NOT NULL;
  RAISE NOTICE 'PRE-2 backfill complete: %/% wallet_token_activity rows now have entry_market_cap',
    filled_rows, total_rows;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- PRE-3 — Add discovery score columns to wallets
-- ─────────────────────────────────────────────────────────────────────────────
-- discovery_score already exists (verified in live DB — all NULL, column type NUMERIC).
-- These are the supporting metadata columns the scoring engine writes.

ALTER TABLE wallets
  ADD COLUMN IF NOT EXISTS discovery_confidence   NUMERIC(4,3)  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS discovery_tier         TEXT          DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS total_discoveries      INTEGER       DEFAULT 0,
  ADD COLUMN IF NOT EXISTS successful_discoveries INTEGER       DEFAULT 0,
  ADD COLUMN IF NOT EXISTS avg_entry_market_cap   NUMERIC(18,2) DEFAULT NULL;

-- Ranking index — used by "Top Discoverers" queries and percentile calculations
CREATE INDEX IF NOT EXISTS idx_wallets_discovery_score_rank
  ON wallets (discovery_score DESC NULLS LAST)
  WHERE discovery_score IS NOT NULL;

-- Tier index for filtered queries (e.g. WHERE discovery_tier = 'elite')
CREATE INDEX IF NOT EXISTS idx_wallets_discovery_tier
  ON wallets (discovery_tier)
  WHERE discovery_tier IS NOT NULL;

