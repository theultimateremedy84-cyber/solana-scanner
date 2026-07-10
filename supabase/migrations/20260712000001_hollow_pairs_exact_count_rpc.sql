-- =============================================================================
-- count_hollow_pairs() — exact count for the Pipeline Control dashboard,
-- without re-introducing the row-shipping cost find_hollow_pairs(p_limit)
-- was deliberately capped to avoid (see 20260711000001_find_hollow_pairs_add_limit.sql).
--
-- WHY: backlog-status-handler.ts previously derived hollowPairsPending from
-- find_hollow_pairs(p_limit: 1000).data.length, which can only ever report
-- "1000+" once the real backlog exceeds the cap (hollowPairsPendingIsFloor).
-- Raising that cap would ship thousands of full wallet/token rows over the
-- network on every dashboard poll (every 8s) -- the exact problem the cap
-- was added to prevent.
--
-- FIX: this function runs the same indexed anti-join as find_hollow_pairs()
-- but returns a single COUNT(*) instead of the matching rows. Postgres can
-- satisfy this from the same composite indexes
-- (wph_wallet_token_idx, wrm_wallet_token_idx) without materializing or
-- transferring row data, so it stays cheap regardless of backlog size.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.count_hollow_pairs()
RETURNS BIGINT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*)
  FROM public.wallet_performance_history wph
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.wallet_raw_tx_metrics wrm
    WHERE wrm.wallet_address = wph.wallet_address
      AND wrm.token_address  = wph.token_address
      AND wrm.data_source    = 'helius_full_history'
  );
$$;

COMMENT ON FUNCTION public.count_hollow_pairs() IS
  'Exact count of wallet/token pairs pending Helius full-history enrichment. '
  'Used by /api/backlog-status for an accurate hollowPairsPending number '
  'without the row-transfer cost of find_hollow_pairs(). Safe to call on '
  'every dashboard poll since Postgres satisfies it from existing indexes.';

-- Restrict to service_role only, matching find_hollow_pairs() and every
-- other privileged operation in this project.
REVOKE ALL ON FUNCTION public.count_hollow_pairs() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.count_hollow_pairs() FROM anon;
REVOKE ALL ON FUNCTION public.count_hollow_pairs() FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.count_hollow_pairs() TO service_role;
