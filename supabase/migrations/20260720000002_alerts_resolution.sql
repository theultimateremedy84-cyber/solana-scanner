-- =============================================================================
-- alerts_resolution.sql
--
-- P2 audit fix: the alerts table had no resolved_at or resolved_by columns,
-- so the 559+ critical alerts accumulated forever with no resolution workflow.
--
-- Changes:
--   1. Add resolved_at TIMESTAMPTZ (NULL = open, non-null = resolved)
--   2. Add resolved_by TEXT (who/what resolved the alert — e.g. wallet address
--      or system identifier)
--   3. Add a partial index on (severity, created_at) WHERE resolved_at IS NULL
--      so "open alerts" queries remain fast even as the table grows.
-- =============================================================================

-- 1. Add resolution columns (idempotent — IF NOT EXISTS guards re-runs)
ALTER TABLE alerts
  ADD COLUMN IF NOT EXISTS resolved_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolved_by  TEXT;

-- 2. Partial index: fast lookups for open alerts only.
--    NULL resolved_at = open; non-null = resolved.
--    Drop first so re-running the migration doesn't error on a duplicate name.
DROP INDEX IF EXISTS alerts_open_idx;
CREATE INDEX alerts_open_idx
  ON alerts (severity, created_at)
  WHERE resolved_at IS NULL;
