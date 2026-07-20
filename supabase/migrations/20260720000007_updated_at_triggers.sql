-- =============================================================================
-- Migration: 20260720000007_updated_at_triggers.sql
--
-- PURPOSE
--   Adds automatic updated_at maintenance triggers to all tables that have
--   an updated_at column but no trigger to refresh it on UPDATE.
--
-- WITHOUT THIS
--   updated_at only reflects the value explicitly set by application code.
--   Any UPDATE that omits the updated_at column (e.g. a targeted partial
--   update, a direct SQL fix, or a future code path that forgets to set it)
--   leaves a stale timestamp. The monitoring dashboard "last updated" display
--   and any cache-invalidation logic that reads updated_at become unreliable.
--
-- TABLES PATCHED
--   wallets, wallet_performance_history, agent_settings
--   (scan_history and wallet_collection_jobs use scanned_at/enqueued_at
--    as their canonical "written at" timestamps, not updated_at)
--
-- IDEMPOTENT — CREATE OR REPLACE + DROP IF EXISTS guards.
-- =============================================================================

-- ── Shared trigger function ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.set_updated_at() IS
  'Generic trigger function that sets updated_at = now() on every UPDATE. '
  'Attach to any table that has an updated_at TIMESTAMPTZ column.';

-- ── wallets ───────────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS trg_wallets_updated_at ON public.wallets;
CREATE TRIGGER trg_wallets_updated_at
  BEFORE UPDATE ON public.wallets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TRIGGER trg_wallets_updated_at ON public.wallets IS
  'Auto-refreshes updated_at on every row UPDATE.';

-- ── wallet_performance_history ────────────────────────────────────────────────

DROP TRIGGER IF EXISTS trg_wph_updated_at ON public.wallet_performance_history;
CREATE TRIGGER trg_wph_updated_at
  BEFORE UPDATE ON public.wallet_performance_history
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TRIGGER trg_wph_updated_at ON public.wallet_performance_history IS
  'Auto-refreshes updated_at on every row UPDATE.';

-- ── agent_settings ────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS trg_agent_settings_updated_at ON public.agent_settings;
CREATE TRIGGER trg_agent_settings_updated_at
  BEFORE UPDATE ON public.agent_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TRIGGER trg_agent_settings_updated_at ON public.agent_settings IS
  'Auto-refreshes updated_at on every row UPDATE.';
