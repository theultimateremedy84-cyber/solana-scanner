-- =============================================================================
-- get_helius_cu_totals() — server-side SUM aggregation for helius_cu_log.
--
-- ROOT CAUSE: the Pipeline Control panel (backlog-status-handler.ts) summed
-- cu_amount in JS after a plain `.select("cu_amount")` fetch. PostgREST caps
-- REST/JS-client responses at 1000 rows (db-max-rows) regardless of the time
-- window requested, so any window with >1000 log rows (this table is written
-- on every Helius API call, batched every 60s) silently undercounted CU
-- usage instead of erroring — a correctness bug, not just a scale concern.
--
-- This computes SUM(cu_amount) entirely in Postgres for the 1h/24h/7d
-- windows, so the row cap never applies to the aggregate.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_helius_cu_totals()
RETURNS TABLE (cu_last_1h NUMERIC, cu_last_24h NUMERIC, cu_last_7d NUMERIC)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COALESCE(SUM(cu_amount) FILTER (WHERE logged_at >= now() - interval '1 hour'), 0)  AS cu_last_1h,
    COALESCE(SUM(cu_amount) FILTER (WHERE logged_at >= now() - interval '24 hours'), 0) AS cu_last_24h,
    COALESCE(SUM(cu_amount) FILTER (WHERE logged_at >= now() - interval '7 days'), 0)   AS cu_last_7d
  FROM public.helius_cu_log
  WHERE logged_at >= now() - interval '7 days';
$$;

COMMENT ON FUNCTION public.get_helius_cu_totals() IS
  'Returns SUM(cu_amount) over the 1h/24h/7d windows, computed in Postgres so '
  'the PostgREST 1000-row response cap never truncates the aggregate. Used by '
  'GET /api/backlog-status (Pipeline Control panel).';

-- =============================================================================
-- get_helius_cu_top_components() — top components by CU usage in last 24h,
-- also aggregated in Postgres for the same reason as above.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_helius_cu_top_components(p_limit INTEGER DEFAULT 8)
RETURNS TABLE (component TEXT, cu_last_24h NUMERIC)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT component, SUM(cu_amount) AS cu_last_24h
  FROM public.helius_cu_log
  WHERE logged_at >= now() - interval '24 hours'
  GROUP BY component
  ORDER BY cu_last_24h DESC
  LIMIT p_limit;
$$;

COMMENT ON FUNCTION public.get_helius_cu_top_components(INTEGER) IS
  'Top Helius CU consumers over the last 24h, grouped and summed in Postgres. '
  'Used by GET /api/backlog-status (Pipeline Control panel).';

-- SECURITY DEFINER functions are executable by PUBLIC by default — restrict
-- to service_role only, matching find_hollow_pairs() and prune_helius_cu_log().
REVOKE ALL ON FUNCTION public.get_helius_cu_totals() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_helius_cu_totals() FROM anon;
REVOKE ALL ON FUNCTION public.get_helius_cu_totals() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_helius_cu_totals() TO service_role;

REVOKE ALL ON FUNCTION public.get_helius_cu_top_components(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_helius_cu_top_components(INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.get_helius_cu_top_components(INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_helius_cu_top_components(INTEGER) TO service_role;
