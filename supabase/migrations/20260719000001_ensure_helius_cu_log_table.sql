-- =============================================================================
-- ensure_helius_cu_log_table
--
-- The helius_cu_log table was defined in migration 20260709000002 but was not
-- applied to production — querying it returns HTTP 404. This migration
-- re-creates it safely with IF NOT EXISTS so it can be applied to any
-- environment regardless of current state.
--
-- Audit finding: helius_cu_log missing in production → monitor dashboard §19
-- returns empty and the retention scheduler throws on every run.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.helius_cu_log (
  id            UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  logged_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  label         TEXT        NOT NULL DEFAULT '',
  component     TEXT        NOT NULL DEFAULT '',
  cu_amount     NUMERIC     NOT NULL DEFAULT 0,
  hourly_used   NUMERIC     NOT NULL DEFAULT 0,
  hourly_budget NUMERIC     NOT NULL DEFAULT 0,
  daily_used    NUMERIC     NOT NULL DEFAULT 0,
  daily_budget  NUMERIC     NOT NULL DEFAULT 0
);

COMMENT ON TABLE public.helius_cu_log IS
  'Operational telemetry — one row per Helius API call batch, flushed every 60s '
  'from token-discovery.ts. Retention-pruned daily via prune_helius_cu_log(). '
  'Not a data table — internal billing visibility only.';

-- Primary access pattern: recency queries and retention pruning.
CREATE INDEX IF NOT EXISTS helius_cu_log_logged_at_idx
  ON public.helius_cu_log (logged_at DESC);

-- RLS: only service_role can read/write — this is internal telemetry.
ALTER TABLE public.helius_cu_log ENABLE ROW LEVEL SECURITY;

GRANT ALL ON public.helius_cu_log TO service_role;

-- Retention function — deletes rows older than retention_days (default 14).
-- Called daily by helius-cu-log-retention-scheduler.ts; can also be invoked
-- manually from the Supabase SQL editor or pg_cron.
CREATE OR REPLACE FUNCTION public.prune_helius_cu_log(retention_days INTEGER DEFAULT 14)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM public.helius_cu_log
  WHERE logged_at < now() - (retention_days || ' days')::interval;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

COMMENT ON FUNCTION public.prune_helius_cu_log(INTEGER) IS
  'Deletes helius_cu_log rows older than retention_days (default 14). '
  'Called daily by helius-cu-log-retention-scheduler.ts.';

-- Lock down the SECURITY DEFINER function — without these revokes, any
-- anon/authenticated caller could invoke it directly (e.g. with retention_days=0
-- to wipe the table). Restrict to service_role only.
REVOKE ALL ON FUNCTION public.prune_helius_cu_log(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prune_helius_cu_log(INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.prune_helius_cu_log(INTEGER) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.prune_helius_cu_log(INTEGER) TO service_role;
