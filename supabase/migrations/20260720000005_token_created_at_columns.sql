-- =============================================================================
-- Migration: 20260720000005_token_created_at_columns.sql
--
-- PURPOSE
--   Adds token_created_at to wallet_collection_jobs and scan_history.
--
-- ROOT CAUSE
--   wallet-enricher.ts:fetchTokenCreatedAt() queries:
--     Attempt 1: wallet_collection_jobs.select("token_created_at, created_at")
--     Attempt 2: scan_history.select("token_created_at, created_at")
--
--   Neither table had a token_created_at column, and neither has a generic
--   created_at column (wallet_collection_jobs uses enqueued_at; scan_history
--   uses scanned_at). Supabase silently returns null for missing columns
--   instead of throwing, so both attempts returned null → tokenCreatedAt is
--   always null → every enrichment log prints "tokenCreatedAt: unknown".
--
--   Impact: token_age_at_entry is never calculated (stays 0 or null),
--   distorting early-buyer detection for all enriched wallets.
--
-- FIX
--   1. Add token_created_at (Unix seconds, TEXT → BIGINT) to both tables.
--      token-discovery.ts can now populate this when inserting a job, using
--      the timestamp from the Pump.fun WebSocket bonding-curve event.
--   2. Add created_at alias columns (same value as enqueued_at / scanned_at)
--      so the existing fallback paths in fetchTokenCreatedAt also work without
--      a code change, providing defence-in-depth.
--
-- IDEMPOTENT — all DDL uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
-- =============================================================================

-- ── wallet_collection_jobs ────────────────────────────────────────────────────

-- The on-chain Unix timestamp (seconds) when the token was created/launched.
-- Populated by token-discovery.ts from the Pump.fun bonding-curve event.
-- Nullable: older jobs pre-dating this column will have NULL here.
ALTER TABLE public.wallet_collection_jobs
  ADD COLUMN IF NOT EXISTS token_created_at BIGINT;

COMMENT ON COLUMN public.wallet_collection_jobs.token_created_at IS
  'Unix timestamp (seconds) of the token''s on-chain creation/launch event. '
  'Populated by token-discovery.ts from the Pump.fun WebSocket message. '
  'Used by wallet-enricher.ts to compute token_age_at_entry for each trade.';

-- created_at alias — the fetchTokenCreatedAt fallback path uses "created_at"
-- but wallet_collection_jobs uses enqueued_at. Add a generated column so the
-- existing query works without a code change.
ALTER TABLE public.wallet_collection_jobs
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ
    GENERATED ALWAYS AS (enqueued_at) STORED;

COMMENT ON COLUMN public.wallet_collection_jobs.created_at IS
  'Alias for enqueued_at. Added so wallet-enricher.ts:fetchTokenCreatedAt '
  'fallback path (.select("token_created_at, created_at")) returns a '
  'non-null value instead of silently null when token_created_at is not set.';

-- ── scan_history ──────────────────────────────────────────────────────────────

ALTER TABLE public.scan_history
  ADD COLUMN IF NOT EXISTS token_created_at BIGINT;

COMMENT ON COLUMN public.scan_history.token_created_at IS
  'Unix timestamp (seconds) of the token''s on-chain creation. '
  'Populated by token-discovery.ts for pipeline-discovered tokens. '
  'Used as a secondary lookup by wallet-enricher.ts:fetchTokenCreatedAt.';

-- created_at alias — scan_history uses scanned_at but fetchTokenCreatedAt
-- falls back to "created_at". Generated column avoids a code change.
ALTER TABLE public.scan_history
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ
    GENERATED ALWAYS AS (scanned_at) STORED;

COMMENT ON COLUMN public.scan_history.created_at IS
  'Alias for scanned_at. Added so wallet-enricher.ts:fetchTokenCreatedAt '
  'fallback path returns a useful timestamp instead of null.';

-- ── Index: fast lookup by token_address when token_created_at is set ──────────
CREATE INDEX IF NOT EXISTS wcj_token_created_at_idx
  ON public.wallet_collection_jobs (token_address)
  WHERE token_created_at IS NOT NULL;
