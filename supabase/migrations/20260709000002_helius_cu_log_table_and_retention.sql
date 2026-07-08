-- =============================================================================
-- helius_cu_log — schema drift fix + index + retention (audit findings #2, #3)
--
-- Finding #2: even a plain COUNT(*) on this table times out (57014 canceling
-- statement due to statement timeout). It's written on every Helius API call
-- from token-discovery.ts (_flushCuLog, every 60s) with NO migration file and
-- NO index — so after only ~3 days of data it was already unqueryable.
--
-- Finding #3: this table (like `alerts`) exists and is written to in
-- production but has no CREATE TABLE in supabase/migrations/.
--
-- IF NOT EXISTS makes the CREATE TABLE safe to run against the existing
-- production database. The index is created CONCURRENTLY-safe via plain
-- CREATE INDEX IF NOT EXISTS (small enough table today; if it has grown
-- large by the time this runs, create the index manually with
-- CREATE INDEX CONCURRENTLY instead to avoid locking writes).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.helius_cu_log (
  id            UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  logged_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  label         TEXT        NOT NULL,
  component     TEXT        NOT NULL,
  cu_amount     NUMERIC     NOT NULL DEFAULT 0,
  hourly_used   NUMERIC     NOT NULL DEFAULT 0,
  hourly_budget NUMERIC     NOT NULL DEFAULT 0,
  daily_used    NUMERIC     NOT NULL DEFAULT 0,
  daily_budget  NUMERIC     NOT NULL DEFAULT 0
);

COMMENT ON TABLE public.helius_cu_log IS
  'Operational telemetry — one row per Helius API call, batched and flushed '
  'every 60s from token-discovery.ts. Not a data table: retention-pruned '
  'daily (see prune_helius_cu_log()). See audit findings #2/#3, 2026-07-08.';

-- The missing index — this is the direct fix for the timeout in finding #2.
-- logged_at is the only column ever filtered/ordered by (recency queries,
-- retention pruning).
CREATE INDEX IF NOT EXISTS helius_cu_log_logged_at_idx
  ON public.helius_cu_log (logged_at);

-- Grants — write-only from the server (service_role); no anon/authenticated
-- access needed, this is internal telemetry, not user-facing data.
GRANT ALL ON public.helius_cu_log TO service_role;

ALTER TABLE public.helius_cu_log ENABLE ROW LEVEL SECURITY;
-- No policies for anon/authenticated → both are denied all access by
-- default under RLS. Only service_role (which bypasses RLS) can read/write.

-- ---------------------------------------------------------------------------
-- Retention — delete rows older than 14 days.
--
-- This function is invoked daily by the in-process scheduler added in
-- src/lib/api/helius-cu-log-retention-scheduler.ts (wired into src/server.ts)
-- so no external cron/pg_cron setup is required. The SQL function is also
-- provided here so it can be run manually or wired to pg_cron/Supabase's
-- scheduled functions if preferred instead of the in-app scheduler.
-- ---------------------------------------------------------------------------
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
  'Called daily by src/lib/api/helius-cu-log-retention-scheduler.ts.';

-- SECURITY (code review, 2026-07-08): SECURITY DEFINER functions are
-- executable by PUBLIC by default in Postgres. Without this revoke, any
-- anon/authenticated caller could invoke prune_helius_cu_log() directly
-- (including with an attacker-chosen retention_days, e.g. 0, to wipe the
-- table on demand). Restrict it to service_role only, matching every other
-- privileged operation in this project.
REVOKE ALL ON FUNCTION public.prune_helius_cu_log(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prune_helius_cu_log(INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.prune_helius_cu_log(INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.prune_helius_cu_log(INTEGER) TO service_role;
