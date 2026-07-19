-- =============================================================================
-- jobs_abandoned_status.sql
--
-- P1 audit fix: mark the 59 permanently-failed collection jobs as 'abandoned'
-- so the scheduler skips them and they no longer pollute the failed-jobs view.
--
-- Root cause: all 59 are at attempts=10/10 with last_error="undefined"
-- (uncaught throw before the catch block). They will never recover.
--
-- Steps:
--   1. Drop the old status check constraint (only allowed pending/processing/done/failed)
--   2. Re-add it with 'abandoned' included
--   3. Mark all failed jobs with attempts>=10 as abandoned
-- =============================================================================

-- 1. Drop old constraint (name from migration 20260623000002)
ALTER TABLE wallet_collection_jobs
  DROP CONSTRAINT IF EXISTS wallet_collection_jobs_status_check;

-- 2. Add new constraint that includes 'abandoned'
ALTER TABLE wallet_collection_jobs
  ADD CONSTRAINT wallet_collection_jobs_status_check
  CHECK (status IN ('pending', 'processing', 'done', 'failed', 'abandoned'));

-- 3. Mark permanently-failed jobs as abandoned (idempotent)
UPDATE wallet_collection_jobs
SET status = 'abandoned'
WHERE status = 'failed'
  AND attempts >= 10;
