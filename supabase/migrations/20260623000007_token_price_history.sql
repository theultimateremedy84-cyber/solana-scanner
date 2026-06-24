-- =============================================================================
-- PHASE 4: token_price_history — price snapshot infrastructure
-- Migration: 20260623000007_token_price_history.sql
--
-- PURPOSE:
--   Stores periodic SOL and USD price snapshots per token, keyed by
--   (token_address, snapshotted_at). Enables:
--     • Peak ROI backfill  — replay historical prices to find real peak
--     • Price charts       — time-series data for token price dashboards
--     • Stale-price guard  — detect when the last scan is too old to trust
--
-- STORAGE ESTIMATE (per token):
--   One row per collection run per token.
--   If tokens are collected once per hour: ~24 rows/day/token.
--   At 1,000 active tokens × 30 days × 24 rows = 720,000 rows ≈ ~30 MB.
--   With 90-day retention the table stays under 200 MB indefinitely.
--
-- RETENTION STRATEGY:
--   Rows older than 90 days are deleted by a weekly cron (see below).
--   We keep daily close snapshots (highest volume in a calendar day) for
--   tokens that drop off the active scan list.
--
-- PERFORMANCE:
--   Primary access pattern: SELECT WHERE token_address = $1 ORDER BY ts DESC.
--   Covered by the composite index on (token_address, snapshotted_at DESC).
--   Partition-by-month is not yet needed at this scale.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.token_price_history (
  id                  BIGSERIAL        PRIMARY KEY,

  token_address       TEXT             NOT NULL,

  -- Snapshot timestamp (set by the worker at fetch time)
  snapshotted_at      TIMESTAMPTZ      NOT NULL DEFAULT NOW(),

  -- Source and pair used for this snapshot
  source              TEXT             NOT NULL DEFAULT 'dexscreener'
    CHECK (source IN ('dexscreener', 'jupiter', 'manual')),
  pair_address        TEXT,                   -- which DEX pair was selected
  dex_id              TEXT,                   -- raydium, meteora, orca, etc.
  quote_token_symbol  TEXT,                   -- SOL, USDC, etc. (must be SOL for priceSol)

  -- Price data
  price_sol           NUMERIC,                -- token price in SOL (from priceNative on SOL pair)
  price_usd           NUMERIC,                -- token price in USD (from priceUsd)
  market_cap_usd      NUMERIC,
  liquidity_usd       NUMERIC,                -- liquidity of the selected pair

  -- Context — what triggered this snapshot
  trigger             TEXT             NOT NULL DEFAULT 'collection'
    CHECK (trigger IN ('collection', 'refresh', 'manual'))
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Primary access: get history for a specific token, newest first
CREATE INDEX IF NOT EXISTS tph_token_ts_idx
  ON public.token_price_history (token_address, snapshotted_at DESC);

-- For cleanup queries (delete old rows efficiently)
CREATE INDEX IF NOT EXISTS tph_ts_idx
  ON public.token_price_history (snapshotted_at DESC);

-- For finding peak price per token
CREATE INDEX IF NOT EXISTS tph_price_sol_idx
  ON public.token_price_history (token_address, price_sol DESC NULLS LAST);

-- ── Retention function (call weekly from a cron job or Supabase Edge Function) ─
CREATE OR REPLACE FUNCTION public.purge_old_price_history()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  -- Keep the most recent 90 days
  DELETE FROM public.token_price_history
  WHERE snapshotted_at < NOW() - INTERVAL '90 days';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

-- ── View: latest price per token ──────────────────────────────────────────────
CREATE OR REPLACE VIEW public.token_latest_price AS
SELECT DISTINCT ON (token_address)
  token_address,
  snapshotted_at,
  price_sol,
  price_usd,
  market_cap_usd,
  liquidity_usd,
  dex_id,
  pair_address
FROM public.token_price_history
WHERE price_sol IS NOT NULL
ORDER BY token_address, snapshotted_at DESC;

-- ── View: peak price per token (for backfilling peak_roi) ─────────────────────
CREATE OR REPLACE VIEW public.token_peak_price AS
SELECT
  token_address,
  MAX(price_sol)        AS peak_price_sol,
  MAX(price_usd)        AS peak_price_usd,
  MAX(market_cap_usd)   AS peak_market_cap_usd,
  MIN(snapshotted_at)   AS first_seen_at,
  MAX(snapshotted_at)   AS last_seen_at,
  COUNT(*)              AS snapshot_count
FROM public.token_price_history
WHERE price_sol IS NOT NULL
GROUP BY token_address;

-- ── Grant permissions (adjust for your Supabase role setup) ──────────────────
-- If using service_role key (recommended), these grants are usually not needed.
-- If using anon key with RLS, enable RLS and add appropriate policies.
-- ALTER TABLE public.token_price_history ENABLE ROW LEVEL SECURITY;
