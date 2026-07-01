-- =============================================================================
-- Migration: 20260701000004_normalize_intelligence_score
--
-- PURPOSE
--   Converts intelligence_score from a 0–100 integer scale to a 0–1 NUMERIC
--   (normalised decimal). All future writes from wallet-enricher.ts
--   (classifyWallets) divide the raw 0–100 classifier output by 100 before
--   upserting, so the stored value is always between 0 and 1.
--
-- WHY
--   The original schema comment said "0–100" but the data pipeline now outputs
--   a normalised 0–1 float that is cleaner for API consumers, ML features, and
--   frontend percentage display (multiply by 100 to show "75%" etc.).
--   Dividing at the write boundary keeps the classifier internals readable
--   (integer math 0–100) while standardising the DB column to a compact,
--   scale-agnostic decimal.
--
-- WHAT THIS MIGRATION DOES
--   1. Backfills all existing rows where intelligence_score > 1 by dividing
--      by 100, converting old 0–100 integers to 0–1 decimals.
--      Rows already ≤ 1 are left untouched (they were written by a prior
--      normalised path or are genuinely zero-scored wallets).
--   2. Updates the column comment to reflect the new 0–1 semantics.
--   3. Clamps any edge-case values outside [0, 1] to the valid range.
--
-- SAFE TO RE-RUN: the WHERE intelligence_score > 1 guard makes it idempotent.
-- =============================================================================

-- Step 1: backfill existing 0–100 scores → 0–1
UPDATE public.wallets
SET    intelligence_score = ROUND((intelligence_score / 100.0)::NUMERIC, 6)
WHERE  intelligence_score > 1;

-- Step 2: clamp anything still outside [0, 1] (defensive)
UPDATE public.wallets
SET    intelligence_score = GREATEST(0, LEAST(1, intelligence_score))
WHERE  intelligence_score IS NOT NULL
  AND  (intelligence_score < 0 OR intelligence_score > 1);

-- Step 3: update column comment
COMMENT ON COLUMN public.wallets.intelligence_score IS
  'Composite 0–1 normalised score (raw 0–100 classifier output divided by 100). '
  'Combines win_rate, average_roi, conviction_score, and classification bonus. '
  'Primary ranking signal. Multiply by 100 to display as a percentage.';
