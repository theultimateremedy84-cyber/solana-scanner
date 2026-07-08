-- =============================================================================
-- find_hollow_pairs() — replace the full-table-scan diff in
-- enrich-unenriched-scheduler.ts with a single indexed SQL anti-join.
--
-- ROOT CAUSE (Supabase compute-exhaustion investigation, 2026-07-08):
--   Every 30 minutes, findHollowPairs() in enrich-unenriched-scheduler.ts
--   paginated through the ENTIRE wallet_performance_history table AND the
--   ENTIRE wallet_raw_tx_metrics table (1,000 rows per round trip each,
--   sequential), pulled every row into Node memory, and diffed them there
--   with a JS Set. Both tables are unbounded and grow over time
--   (wallet_performance_history was already 42k+ rows) — this is a full
--   table transfer, twice, every 30 minutes, forever, with no filtering
--   done in the database. Combined with 6 other schedulers all querying
--   Supabase on their own intervals, this was a plausible contributor to
--   the "nano" compute tier being pegged.
--
--   Both tables already have the composite indexes needed to do this
--   as a single indexed anti-join entirely in Postgres:
--     - wph_wallet_token_idx (UNIQUE) on wallet_performance_history
--       (wallet_address, token_address)
--     - wrm_wallet_token_idx on wallet_raw_tx_metrics
--       (wallet_address, token_address)
--
--   This function returns only the "hollow" pairs (in wallet_performance_
--   history but not yet enriched in wallet_raw_tx_metrics), computed
--   server-side, so the app only ever receives the rows it actually needs
--   instead of transferring and re-deriving the same diff in JS every tick.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.find_hollow_pairs()
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
  );
$$;

COMMENT ON FUNCTION public.find_hollow_pairs() IS
  'Returns wallet/token pairs from wallet_performance_history that have not '
  'yet been enriched with Helius full transaction history in '
  'wallet_raw_tx_metrics. Replaces the old client-side full-table-scan diff '
  'in enrich-unenriched-scheduler.ts with a single indexed anti-join. '
  'Called every 30 minutes by src/lib/api/enrich-unenriched-scheduler.ts.';

-- SECURITY DEFINER functions are executable by PUBLIC by default — restrict
-- to service_role only, matching every other privileged operation in this
-- project (see prune_helius_cu_log() in the helius_cu_log migration).
REVOKE ALL ON FUNCTION public.find_hollow_pairs() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.find_hollow_pairs() FROM anon;
REVOKE ALL ON FUNCTION public.find_hollow_pairs() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.find_hollow_pairs() TO service_role;
