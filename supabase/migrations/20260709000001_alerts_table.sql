-- =============================================================================
-- alerts table — schema drift fix (audit finding #3, 2026-07-08)
--
-- This table has been live and actively written to since PostLaunchWatcher's
-- resize/metadata-hijack/path-obfuscation alert handlers went in, but it was
-- never captured in a migration — its only "schema" was a comment in
-- src/lib/postLaunchWatcher.ts. If this project is ever rebuilt from
-- migrations alone, this table (and its RLS) would silently be missing.
--
-- IF NOT EXISTS makes this safe to run against the existing production
-- database — it will not touch the live table or its data.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.alerts (
  id           UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  alert_type   TEXT        NOT NULL,
  severity     TEXT        NOT NULL,
  mint_address TEXT,
  account      TEXT,
  signature    TEXT,
  payload      JSONB       NOT NULL DEFAULT '{}'::jsonb
);

COMMENT ON TABLE public.alerts IS
  'Dashboard/notification-facing alerts written by PostLaunchWatcher '
  '(account resize, metadata hijack, path obfuscation, etc.). '
  'Formerly undocumented — see audit finding #3, 2026-07-08.';

-- Every current writer/reader hits this table by mint_address or recency —
-- index both since the table has no other access pattern today.
CREATE INDEX IF NOT EXISTS alerts_mint_address_idx
  ON public.alerts (mint_address, created_at DESC);

CREATE INDEX IF NOT EXISTS alerts_created_at_idx
  ON public.alerts (created_at DESC);

CREATE INDEX IF NOT EXISTS alerts_alert_type_idx
  ON public.alerts (alert_type, created_at DESC);

-- Grants — same pattern as every other table except scan_history:
-- public SELECT (dashboard reads), service_role-only writes.
GRANT SELECT           ON public.alerts TO anon;
GRANT SELECT           ON public.alerts TO authenticated;
GRANT ALL              ON public.alerts TO service_role;

ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read alerts" ON public.alerts;
CREATE POLICY "Anyone can read alerts"
  ON public.alerts FOR SELECT
  USING (true);

-- No anon/authenticated INSERT/UPDATE/DELETE policy is created, so those
-- roles are denied by default under RLS. Only service_role (which bypasses
-- RLS) can write — matching how PostLaunchWatcher writes today via
-- supabaseAdmin.
