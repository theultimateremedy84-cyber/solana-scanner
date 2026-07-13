-- =============================================================================
-- airdrop_exit_flag
--
-- ISSUE (#6, serious gap — monetization audit 2026-07-14)
-- --------------------------------------------------------
-- 21,530 CLOSED positions in wallet_performance_history have:
--   - initial_investment = 0  (no buy recorded — token received via airdrop or transfer)
--   - roi_multiple = NULL     (ROI cannot be computed without a cost basis)
--   - position_status = CLOSED (wallet sold the tokens and received SOL proceeds)
--
-- These positions contribute nothing to average_roi or win_rate but they DO
-- inflate total_tokens_traded, total_discoveries (discovery score denominator),
-- and the wallet's CLOSED position count that feeds computeConfidenceTier().
-- A wallet that received 50 airdropped tokens and sold them all appears to have
-- 50 "trades" of evidence — but zero real capital was ever at risk.
--
-- FIX
-- ---
-- 1. Add is_airdrop_exit boolean column (default FALSE, nullable→non-null with
--    coalesce in queries until a full backfill is confirmed).
-- 2. Flag existing zero-investment CLOSED positions.
-- 3. The TypeScript scoring layer (wallet-classifier.ts, wallet-discovery-score.ts)
--    already filters by initialInvestment > 0.001 for win_rate and ROI
--    computation after the companion code change in this release.  The DB flag
--    enables the UI to display "airdrop exit" labels and lets future queries
--    exclude these positions explicitly without relying on the NULL investment
--    proxy.
--
-- SAFETY
-- ------
-- Only flags CLOSED positions with initial_investment = 0.  Open positions,
-- partially-closed positions, and any closed position with a non-zero investment
-- are untouched.  Idempotent: rows already flagged (is_airdrop_exit = true) are
-- unchanged by re-running.
-- =============================================================================

-- Step 1: add the column
ALTER TABLE public.wallet_performance_history
  ADD COLUMN IF NOT EXISTS is_airdrop_exit BOOLEAN NOT NULL DEFAULT FALSE;

-- Step 2: flag existing airdrop exits
-- A position is an airdrop exit when:
--   (a) position_status = CLOSED — the wallet actually sold the tokens
--   (b) initial_investment = 0   — no buy SOL recorded (token was received, not purchased)
--   (c) roi_multiple IS NULL     — as expected: ROI cannot be computed without cost basis
-- Condition (c) is redundant (already implied by (b) + the guardRoiMultiple logic)
-- but adds a safety check to avoid flagging edge-case rows that were miscalculated.
UPDATE public.wallet_performance_history
SET
  is_airdrop_exit = TRUE,
  updated_at      = now()
WHERE
  position_status    = 'CLOSED'
  AND initial_investment = 0
  AND roi_multiple IS NULL
  AND is_airdrop_exit = FALSE;  -- idempotency guard

DO $$
DECLARE
  affected_count INTEGER;
BEGIN
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  RAISE NOTICE 'airdrop_exit_flag: flagged % zero-investment CLOSED positions as is_airdrop_exit=true', affected_count;
END $$;

-- Step 3: create an index for fast filtering in leaderboard / scoring queries
CREATE INDEX IF NOT EXISTS idx_wph_airdrop_exit
  ON public.wallet_performance_history (wallet_address)
  WHERE is_airdrop_exit = TRUE;

-- Verification query (informational — shows breakdown after migration):
-- SELECT
--   is_airdrop_exit,
--   position_status,
--   COUNT(*) AS row_count,
--   SUM(CASE WHEN roi_multiple IS NULL THEN 1 ELSE 0 END) AS null_roi_count
-- FROM public.wallet_performance_history
-- GROUP BY is_airdrop_exit, position_status
-- ORDER BY is_airdrop_exit, position_status;
