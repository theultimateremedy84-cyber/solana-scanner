-- =============================================================================
-- Migration: 20260701000001_rls_hardening_completion.sql
--
-- PURPOSE
--   Completes the RLS hardening that 20260627000001 could not finish.
--   Migration 20260627000001 stopped mid-way through Step 5 because
--   "Service role can insert wallets" already existed from a prior partial
--   run, leaving three tables incompletely hardened:
--
--     wallet_token_activity      — anon INSERT still open
--     wallet_performance_history — anon INSERT + UPDATE still open
--     wallet_collection_jobs     — anon INSERT + UPDATE still open
--
--   The wallets UPDATE policy was also in an uncertain state (may or may
--   not have been created by the prior partial run).
--
-- WHAT THIS MIGRATION DOES
--   For each of the four affected tables it:
--     1. DROPs both the old open policy and the new service_role policy
--        (using IF EXISTS so the DROP always succeeds regardless of state)
--     2. RECREATEs only the correct service_role-scoped policy
--
--   SELECT policies ("Anyone can read …") are left untouched — they are
--   correct and should remain open.
--
-- IDEMPOTENCY
--   Every DROP uses IF EXISTS.  Every CREATE is preceded by a DROP of the
--   same name.  Safe to run any number of times against any partial state.
--
-- DOES NOT TOUCH
--   scan_history      — intentionally open (frontend writes scan results)
--   wallet_raw_tx_metrics  — already correctly hardened by earlier fix
--   token_price_history    — already correctly hardened by 20260628000001
--
-- APPLY
--   Supabase Dashboard → SQL Editor: paste and click Run.
--   No data is modified.  Only policy DDL is executed.
-- =============================================================================


-- =============================================================================
-- wallets
-- Uncertain state: INSERT policy existed, UPDATE policy unknown.
-- Drop both names and recreate cleanly.
-- =============================================================================

DROP POLICY IF EXISTS "Anyone can insert wallets"        ON public.wallets;
DROP POLICY IF EXISTS "Anyone can update wallets"        ON public.wallets;
DROP POLICY IF EXISTS "Service role can insert wallets"  ON public.wallets;
DROP POLICY IF EXISTS "Service role can update wallets"  ON public.wallets;

CREATE POLICY "Service role can insert wallets"
  ON public.wallets FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Service role can update wallets"
  ON public.wallets FOR UPDATE
  USING (auth.role() = 'service_role');


-- =============================================================================
-- wallet_token_activity
-- Step 5 of 20260627000001 never reached this table.
-- Old open INSERT policy is still active; service_role INSERT was never created.
-- =============================================================================

DROP POLICY IF EXISTS "Anyone can insert wallet token activity"        ON public.wallet_token_activity;
DROP POLICY IF EXISTS "Service role can insert wallet token activity"  ON public.wallet_token_activity;

CREATE POLICY "Service role can insert wallet token activity"
  ON public.wallet_token_activity FOR INSERT
  WITH CHECK (auth.role() = 'service_role');


-- =============================================================================
-- wallet_performance_history
-- Step 5 of 20260627000001 never reached this table.
-- Old open INSERT + UPDATE policies are still active.
-- =============================================================================

DROP POLICY IF EXISTS "Anyone can insert wallet performance history"        ON public.wallet_performance_history;
DROP POLICY IF EXISTS "Anyone can update wallet performance history"        ON public.wallet_performance_history;
DROP POLICY IF EXISTS "Service role can insert wallet performance history"  ON public.wallet_performance_history;
DROP POLICY IF EXISTS "Service role can update wallet performance history"  ON public.wallet_performance_history;

CREATE POLICY "Service role can insert wallet performance history"
  ON public.wallet_performance_history FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Service role can update wallet performance history"
  ON public.wallet_performance_history FOR UPDATE
  USING (auth.role() = 'service_role');


-- =============================================================================
-- wallet_collection_jobs
-- Step 5 of 20260627000001 never reached this table.
-- Old open INSERT + UPDATE policies are still active.
-- This is the most critical table — open UPDATE is the direct cause of
-- stuck jobs (anon-key stamp UPDATEs were silently rejected after the
-- service_role-only policy was expected but never created).
-- =============================================================================

DROP POLICY IF EXISTS "Anyone can insert wallet collection jobs"        ON public.wallet_collection_jobs;
DROP POLICY IF EXISTS "Anyone can update wallet collection jobs"        ON public.wallet_collection_jobs;
DROP POLICY IF EXISTS "Service role can insert wallet collection jobs"  ON public.wallet_collection_jobs;
DROP POLICY IF EXISTS "Service role can update wallet collection jobs"  ON public.wallet_collection_jobs;

CREATE POLICY "Service role can insert wallet collection jobs"
  ON public.wallet_collection_jobs FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Service role can update wallet collection jobs"
  ON public.wallet_collection_jobs FOR UPDATE
  USING (auth.role() = 'service_role');


-- =============================================================================
-- VERIFY
-- Run this SELECT immediately after the migration to confirm the result.
-- Expected: 11 rows — SELECT open on all 4 tables, service_role INSERT/UPDATE
-- on wallets + wallet_performance_history + wallet_collection_jobs,
-- service_role INSERT only on wallet_token_activity (no UPDATE policy needed).
-- =============================================================================

SELECT
  tablename,
  policyname,
  cmd,
  COALESCE(qual, with_check, '—') AS expression
FROM pg_policies
WHERE tablename IN (
  'wallets',
  'wallet_token_activity',
  'wallet_performance_history',
  'wallet_collection_jobs'
)
ORDER BY tablename, cmd, policyname;
