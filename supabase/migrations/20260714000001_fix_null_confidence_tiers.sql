-- =============================================================================
-- fix_null_confidence_tiers
--
-- ISSUE (#1, high priority)
-- -------------------------
-- ~289 wallets (down from 21,725 at time of initial report) still have
-- confidence_tier = NULL AND score_computed_at = NULL. The confidence_tier
-- column was added in migration 20260713000006 and the rescore scheduler
-- (rescore-scheduler.ts) processes ALL wallets every 20 minutes via
-- rescoreAllWallets() → classifyWallets(). However, classifyWallets() only
-- writes an update for wallets that appear in wallet_raw_tx_metrics OR
-- wallet_performance_history. Wallets that exist only in the `wallets` table
-- with no evidence in either source will never receive a write from the
-- TypeScript classifier — leaving them permanently NULL.
--
-- ROOT CAUSE
-- ----------
-- Two sub-cases:
--   A. Wallets with zero evidence (not in wallet_raw_tx_metrics, not in
--      wallet_performance_history): classifyWallets() skips them entirely.
--   B. Wallets recently inserted between rescore ticks: will be processed on
--      the next tick (self-healing via scheduler).
--
-- FIX
-- ---
-- For sub-case A: directly set confidence_tier = 'unrated',
-- wallet_classification = 'unknown', score_computed_at = now().
-- This matches the exact outcome that classifyWallets() would produce for
-- wallets with no evidence — so the result is semantically correct.
--
-- For sub-case B: no SQL action needed; the rescore scheduler self-heals.
--
-- SAFETY
-- ------
-- Only targets rows where BOTH confidence_tier IS NULL AND score_computed_at IS
-- NULL (wallets that have never been processed since the column was added).
-- Never touches wallets that have been scored (confidence_tier NOT NULL).
-- Idempotent: running again after the scheduler has processed remaining
-- wallets changes nothing (they will have confidence_tier set already).
-- =============================================================================

-- Sub-case A: wallets with zero evidence in both sources
-- These will never be updated by the TypeScript classifier.
UPDATE public.wallets w
SET
  confidence_tier      = 'unrated',
  wallet_classification = COALESCE(w.wallet_classification, 'unknown'),
  intelligence_score   = COALESCE(w.intelligence_score, 0),
  score_computed_at    = now(),
  updated_at           = now()
WHERE
  w.confidence_tier    IS NULL
  AND w.score_computed_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM   public.wallet_raw_tx_metrics wrm
    WHERE  wrm.wallet_address = w.wallet_address
  )
  AND NOT EXISTS (
    SELECT 1
    FROM   public.wallet_performance_history wph
    WHERE  wph.wallet_address = w.wallet_address
  );

-- Log how many rows were affected (visible in migration output / Supabase logs)
DO $$
DECLARE
  affected_count INTEGER;
BEGIN
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  RAISE NOTICE 'fix_null_confidence_tiers: marked % no-evidence wallets as unrated/unknown', affected_count;
END $$;
