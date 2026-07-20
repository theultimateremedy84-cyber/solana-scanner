-- =============================================================================
-- Migration: 20260720000009_revoke_anon_scan_history_insert.sql
--
-- PURPOSE (P2 #12 fix — Security):
--   The server-side handler checks x-cron-secret before inserting into
--   scan_history, but the RLS policies allowed the anon role (whose key is
--   publicly visible in the frontend bundle) to INSERT directly via the
--   Supabase client. Anyone with the anon key could poison the dataset.
--
--   This migration revokes direct INSERT from the anon role so all writes
--   to scan_history MUST go through your service role key (which is secret).
--
-- SAFE TO APPLY:
--   All legitimate scan_history inserts use the service role key
--   (supabaseAdmin / SUPABASE_SERVICE_ROLE_KEY). No frontend code should
--   ever INSERT into scan_history directly — it's a backend-only table.
--
-- VERIFICATION AFTER APPLY:
--   Try inserting via the anon key from a browser — should get 403/RLS denied.
--   Normal discovery pipeline inserts should continue working unchanged.
-- =============================================================================

-- Revoke direct INSERT on scan_history from the anon role.
-- All writes must go through the service role key in the backend.
REVOKE INSERT ON TABLE scan_history FROM anon;

-- Also revoke UPDATE and DELETE just in case they were granted:
REVOKE UPDATE ON TABLE scan_history FROM anon;
REVOKE DELETE ON TABLE scan_history FROM anon;

-- Keep SELECT available for the anon role so the frontend can still read
-- the leaderboard / history — only write operations are locked down.
-- (SELECT is managed by separate RLS policies and is unchanged.)

-- Log the change
DO $$
BEGIN
  RAISE NOTICE 'P2 #12: anon role INSERT/UPDATE/DELETE revoked from scan_history. '
               'All writes now require service_role key.';
END $$;
