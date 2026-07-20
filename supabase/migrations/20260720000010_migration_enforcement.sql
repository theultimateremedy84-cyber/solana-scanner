-- =============================================================================
-- Migration: 20260720000010_migration_enforcement.sql
--
-- PURPOSE (P2 #14 fix — Migration Order Enforcement):
--   Migrations must be applied in a specific sequence (documented in RUNBOOK.md)
--   but there was no enforcement mechanism. Applying them out of order caused
--   silent data corruption. This migration:
--     1. Creates a migrations_log table to track applied migrations in sequence.
--     2. Backfills the known migration history up to this point.
--
--   Pair with scripts/check-migrations.ts which refuses to apply migration N
--   if N-1 is not present in migrations_log.
-- =============================================================================

-- ── 1. Create migrations_log table ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS migrations_log (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  migration_name  text        NOT NULL UNIQUE,
  sequence_number int         NOT NULL UNIQUE,  -- monotonically increasing; gaps = missing migrations
  applied_at      timestamptz NOT NULL DEFAULT now(),
  applied_by      text        DEFAULT current_user,
  notes           text
);

COMMENT ON TABLE migrations_log IS
  'Tracks applied DB migrations in order. Used by scripts/check-migrations.ts to '
  'enforce correct sequence before applying new migrations.';

-- ── 2. Backfill known migration history ────────────────────────────────────────
-- Insert the known migrations in order. ON CONFLICT DO NOTHING so this is
-- idempotent — safe to re-run.
INSERT INTO migrations_log (migration_name, sequence_number, notes) VALUES
  ('20260611175415_919e5f0d-77e6-4364-ae42-eeb92060bbfb', 1,  'Initial schema'),
  ('20260617000000_phase10_developer_history',              2,  'Developer history'),
  ('20260618000000_transaction_bloat_monitor',              3,  'Transaction bloat monitor'),
  ('20260619000000_cpi_manipulation_detector',              4,  'CPI manipulation detector'),
  ('20260620000000_state_hijacking_detector',               5,  'State hijacking detector'),
  ('20260621000000_atomic_exploit_monitor',                 6,  'Atomic exploit monitor'),
  ('20260622000000_rent_exempt_monitor',                    7,  'Rent-exempt monitor'),
  ('20260623000000_overflow_monitor_v2',                    8,  'Overflow monitor v2'),
  ('20260623000001_wallet_intelligence_infrastructure',     9,  'Wallet intelligence infrastructure'),
  ('20260623000002_wallet_collection_jobs',                 10, 'Wallet collection jobs'),
  ('20260627000001_security_hardening_and_raw_metrics',     11, 'Security hardening and raw metrics'),
  ('20260628000001_token_price_history',                    12, 'Token price history'),
  ('20260701000001_rls_hardening_completion',               13, 'RLS hardening completion'),
  ('20260701000002_fix_data_regressions',                   14, 'Fix data regressions'),
  ('20260716000011_intelligence_snapshots',                 15, 'Intelligence snapshots'),
  ('20260716000012_discovery_rescore_columns',              16, 'Discovery rescore columns'),
  ('20260718000002_helius_budget_daily',                    17, 'Helius budget daily table'),
  ('20260719000001_ensure_helius_cu_log_table',             18, 'Ensure helius_cu_log table'),
  ('20260719000002_fix_helius_budget_daily_columns',        19, 'Fix helius_budget_daily columns'),
  ('20260720000001_wph_dust_balance_cleanup',               20, 'WPH dust balance cleanup'),
  ('20260720000002_alerts_resolution',                      21, 'Alerts resolution'),
  ('20260720000003_jobs_abandoned_status',                  22, 'Jobs abandoned status'),
  ('20260720000004_agent_infrastructure_tables',            23, 'Agent infrastructure tables'),
  ('20260720000005_token_created_at_columns',               24, 'Token created_at columns'),
  ('20260720000006_wallet_classification_constraint',       25, 'Wallet classification constraint'),
  ('20260720000007_updated_at_triggers',                    26, 'Updated_at triggers'),
  ('20260720000008_increment_wallet_buy_sell',              27, 'P0 #3 fix: increment wallet buy/sell counts RPC'),
  ('20260720000009_revoke_anon_scan_history_insert',        28, 'P2 #12 fix: revoke anon INSERT on scan_history'),
  ('20260720000010_migration_enforcement',                  29, 'P2 #14 fix: migration enforcement table')
ON CONFLICT (migration_name) DO NOTHING;

-- ── 3. Grant access ────────────────────────────────────────────────────────────
-- Only the service role can read/write migrations_log (no anon access)
REVOKE ALL ON TABLE migrations_log FROM anon, authenticated;
GRANT SELECT, INSERT ON TABLE migrations_log TO service_role;

DO $$
BEGIN
  RAISE NOTICE 'migrations_log table created and backfilled. '
               'Use scripts/check-migrations.ts before applying future migrations.';
END $$;
