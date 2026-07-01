-- =============================================================================
  -- OPTIONAL CLEANUP: Remove duplicate SELECT policy on wallet_collection_jobs
  --
  -- Two SELECT policies coexist after the RLS hardening:
  --   "Anyone can read collection jobs"         (older, shorter name — duplicate)
  --   "Anyone can read wallet collection jobs"  (correct name, from 20260627000001)
  --
  -- Both are USING (true) — functionally identical. The duplicate is harmless
  -- but untidy. Run in Supabase SQL Editor → Run to remove it.
  -- =============================================================================

  DROP POLICY IF EXISTS "Anyone can read collection jobs" ON public.wallet_collection_jobs;

  -- Verify: should now show only one SELECT row for wallet_collection_jobs
  SELECT tablename, policyname, cmd
  FROM pg_policies
  WHERE tablename = 'wallet_collection_jobs'
  ORDER BY cmd, policyname;
  