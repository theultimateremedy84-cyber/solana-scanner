-- =============================================================================
-- Migration: 20260716000012_discovery_rescore_columns.sql
--
-- PURPOSE
--   Support the discovery re-score pipeline:
--   - Track when a discovery token was last re-scored (for the 24h scheduler)
--   - Store authority/freeze/mint state at discovery time (available without
--     a full scan, just from on-chain account data)
--   - Add a "needs_rescore" flag so the scheduler can efficiently find stale rows
--
-- CONTEXT
--   RugCheck scores for newly launched pump.fun tokens are always LOW (score~1)
--   because RugCheck needs trading history to detect manipulation patterns. After
--   24-48 hours of trading, the score becomes meaningful. The rescore scheduler
--   reads scan_history WHERE source='discovery' AND needs_rescore=true AND
--   scanned_at < NOW() - INTERVAL '24 hours', batches them, calls RugCheck again,
--   and updates the row with the fresh score.
--
-- SAFE TO RE-RUN: all statements use IF NOT EXISTS.
-- =============================================================================

-- Track when the last RugCheck rescore was run for this token
ALTER TABLE public.scan_history
  ADD COLUMN IF NOT EXISTS last_rescored_at TIMESTAMPTZ;

COMMENT ON COLUMN public.scan_history.last_rescored_at IS
  'Timestamp of the most recent RugCheck rescore for this token. '
  'NULL = never rescored (initial discovery score only).';

-- Flag to drive the rescore scheduler efficiently
ALTER TABLE public.scan_history
  ADD COLUMN IF NOT EXISTS needs_rescore BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN public.scan_history.needs_rescore IS
  'TRUE = this token has not been rescored after discovery and is eligible. '
  'Set to FALSE after the rescore scheduler updates the risk score. '
  'Default TRUE so all new discovery rows enter the rescore queue automatically.';

-- Mark existing rows that already have real risk data as not needing rescore
-- (those scanned manually already have full analysis)
UPDATE public.scan_history
SET needs_rescore = FALSE
WHERE source = 'manual'
   OR (source = 'discovery' AND last_rescored_at IS NOT NULL);

-- Mark discovery rows that graduated as done (graduation is a positive signal,
-- no further rescore needed unless a security event is detected post-graduation)
UPDATE public.scan_history
SET needs_rescore = FALSE
WHERE source = 'discovery'
  AND graduated_at IS NOT NULL
  AND needs_rescore = TRUE;

-- Index for the rescore scheduler's primary query:
--   WHERE source = 'discovery'
--     AND needs_rescore = TRUE
--     AND scanned_at < NOW() - INTERVAL '24 hours'
--   ORDER BY scanned_at ASC
CREATE INDEX IF NOT EXISTS scan_history_rescore_idx
  ON public.scan_history (scanned_at ASC)
  WHERE source = 'discovery' AND needs_rescore = TRUE;

-- Verification:
-- SELECT needs_rescore, COUNT(*) FROM scan_history GROUP BY needs_rescore;
-- Expected: needs_rescore=true  ~8000 (discovery rows awaiting rescore)
--           needs_rescore=false ~151  (manual scans) + graduated discovery rows
