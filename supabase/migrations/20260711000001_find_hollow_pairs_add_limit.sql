-- =============================================================================
-- find_hollow_pairs() — add p_limit parameter to stop shipping 38k+ rows to
-- Node.js on every 30-minute enrichment tick.
--
-- ROOT CAUSE (Supabase data-health audit, 2026-07-08):
--   The existing find_hollow_pairs() has no LIMIT clause and no parameter.
--   With 38,598 hollow wallet-token pairs in the DB, every scheduler tick
--   transferred the full result set (~3 MB) to Node.js just so it could
--   select 50 rows (TOKENS_PER_RUN=5 × WALLETS_PER_TOKEN=10).  Now that
--   throughput constants are raised to TOKENS_PER_RUN=10 × WALLETS_PER_TOKEN=25,
--   the tick's max consumption is 250 pairs, yet without this fix it would
--   still download 38k rows every 30 minutes.
--
-- FIX:
--   DROP the old no-param overload and replace with a version that accepts an
--   optional p_limit (DEFAULT 500).  Callers using no arguments still work
--   unchanged — they now get at most 500 rows instead of unbounded.
--   enrich-unenriched-scheduler.ts passes an explicit p_limit calculated as
--   TOKENS_PER_RUN * WALLETS_PER_TOKEN * 5 (5× headroom for anti-starvation
--   token selection), so as constants are tuned the limit adjusts automatically.
-- =============================================================================

-- Drop the existing no-parameter overload first so CREATE OR REPLACE can
-- change the function signature cleanly.
DROP FUNCTION IF EXISTS public.find_hollow_pairs();

CREATE OR REPLACE FUNCTION public.find_hollow_pairs(p_limit INT DEFAULT 500)
RETURNS TABLE (wallet_address TEXT, token_address TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT wph.wallet_address, wph.token_address
  FROM public.wallet_performance_history wph
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.wallet_raw_tx_metrics wrm
    WHERE wrm.wallet_address = wph.wallet_address
      AND wrm.token_address  = wph.token_address
      AND wrm.data_source    = 'helius_full_history'
  )
  LIMIT p_limit;
$$;

COMMENT ON FUNCTION public.find_hollow_pairs(INT) IS
  'Returns at most p_limit wallet/token pairs from wallet_performance_history '
  'that have not yet been enriched with Helius full transaction history. '
  'p_limit defaults to 500; callers should pass TOKENS_PER_RUN * WALLETS_PER_TOKEN * 5 '
  'so the DB only ships rows the tick will actually consume. '
  'Replaces the original no-param version which returned all hollow pairs '
  '(38k+ rows) on every 30-minute scheduler tick.';

-- Restrict to service_role only (same policy as the original function).
REVOKE ALL ON FUNCTION public.find_hollow_pairs(INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.find_hollow_pairs(INT) FROM anon;
REVOKE ALL ON FUNCTION public.find_hollow_pairs(INT) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.find_hollow_pairs(INT) TO service_role;
