-- =============================================================================
-- Migration: 20260715000004_wrm_tombstone_pruning_index.sql
-- Phase 3 — Task 7
--
-- PURPOSE
--   Support the daily tombstone pruning job added to
--   helius-cu-log-retention-scheduler.ts. Without this index, the DELETE
--   WHERE has_evidence = false AND created_at < cutoff requires a full
--   sequential scan of wallet_raw_tx_metrics (103k rows today, growing).
--   With the partial index it becomes a fast index-only scan covering only
--   the tombstone subset.
--
-- WHAT THIS DOES
--   Adds a partial index on (has_evidence, created_at) filtered to
--   has_evidence = false — the exact predicate the pruning DELETE uses.
--   Partial index so it only covers the 68k tombstone rows, not the full table.
--
-- IDEMPOTENT: CREATE INDEX IF NOT EXISTS — safe to re-run.
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_wrm_evidence_created
  ON wallet_raw_tx_metrics (has_evidence, created_at)
  WHERE has_evidence = false;

-- Verify index was created
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'wallet_raw_tx_metrics'
      AND indexname  = 'idx_wrm_evidence_created'
  ) THEN
    RAISE NOTICE '[wrm-tombstone-index] ✓ idx_wrm_evidence_created is present';
  ELSE
    RAISE WARNING '[wrm-tombstone-index] Index not found — check for errors above';
  END IF;
END $$;
