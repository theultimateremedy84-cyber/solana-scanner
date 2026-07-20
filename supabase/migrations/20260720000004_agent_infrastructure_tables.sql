-- =============================================================================
-- Migration: 20260720000004_agent_infrastructure_tables.sql
--
-- PURPOSE
--   Creates three tables that the agent runner, circuit breaker, and fixer
--   reference in code but that were NEVER added to the database schema.
--   Every DB call from these subsystems has been silently failing since the
--   agent was introduced, causing:
--
--     • agent_settings   — settings always fall back to hardcoded defaults;
--                          no UI configuration persisted to DB.
--     • agent_circuit_state — circuit breaker queries fail → always returns
--                          false (circuit "open" = false) meaning the circuit
--                          NEVER trips; bad fix chains can hammer Helius/endpoints
--                          indefinitely instead of backing off after 3 failures.
--     • agent_fix_log    — every fix attempt fails to log → the "Recent fixes"
--                          section on the monitoring dashboard always shows empty;
--                          circuit-breaker failure counting also broken.
--
-- TABLES CREATED
--   agent_settings      — singleton row (id = 'default') for all agent config.
--   agent_circuit_state — one row per open circuit (category PK).
--   agent_fix_log       — append-only log of every auto-fix attempt.
--
-- IDEMPOTENT — all DDL uses IF NOT EXISTS guards. Safe to re-run.
-- =============================================================================

-- =============================================================================
-- 1. agent_settings
--    Singleton config row. Code reads with .eq("id", "default").single().
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.agent_settings (
  id                        TEXT        PRIMARY KEY DEFAULT 'default',

  -- Core agent behaviour
  monitoring_enabled        BOOLEAN     NOT NULL DEFAULT true,
  interval_minutes          INTEGER     NOT NULL DEFAULT 5
                              CHECK (interval_minutes BETWEEN 1 AND 60),
  auto_fix                  BOOLEAN     NOT NULL DEFAULT true,

  -- Fixer cooldown + circuit config
  fix_cooldown_minutes      INTEGER     NOT NULL DEFAULT 15
                              CHECK (fix_cooldown_minutes BETWEEN 1 AND 120),
  verify_fix_delay_seconds  INTEGER     NOT NULL DEFAULT 30
                              CHECK (verify_fix_delay_seconds BETWEEN 0 AND 300),
  circuit_failure_threshold INTEGER     NOT NULL DEFAULT 3
                              CHECK (circuit_failure_threshold BETWEEN 1 AND 20),
  circuit_window_minutes    INTEGER     NOT NULL DEFAULT 90
                              CHECK (circuit_window_minutes BETWEEN 5 AND 1440),
  circuit_reset_hours       INTEGER     NOT NULL DEFAULT 2
                              CHECK (circuit_reset_hours BETWEEN 1 AND 48),

  -- Optional Helius agent API key (overrides env var when set)
  helius_agent_api_key      TEXT,

  -- Email alert config
  alert_email               TEXT,
  smtp_host                 TEXT,
  smtp_port                 INTEGER     DEFAULT 587,
  smtp_user                 TEXT,
  smtp_pass                 TEXT,        -- store encrypted at app layer
  smtp_from                 TEXT,

  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.agent_settings IS
  'Singleton configuration row for the autonomous agent runner. '
  'Always query with .eq("id", "default"). '
  'Fallback defaults are hardcoded in agent-fixer.ts and agent-runner.ts '
  'so the agent runs even if this row is missing.';

-- Seed the default row so reads immediately return data
INSERT INTO public.agent_settings (id)
VALUES ('default')
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- 2. agent_circuit_state
--    One row per currently-open circuit. Deleted when circuit closes.
--    Code: agent-circuit-breaker.ts
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.agent_circuit_state (
  category              TEXT        PRIMARY KEY,
  opened_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  consecutive_failures  INTEGER     NOT NULL DEFAULT 0,
  last_metric           TEXT,
  reset_after           TIMESTAMPTZ NOT NULL,
  notes                 TEXT
);

COMMENT ON TABLE public.agent_circuit_state IS
  'Tracks open circuit-breaker circuits for the agent fixer. '
  'One row per open circuit; row is deleted when the circuit closes '
  '(metric improves or reset_after passes). '
  'Managed by src/lib/api/agent-circuit-breaker.ts.';

CREATE INDEX IF NOT EXISTS acs_reset_after_idx
  ON public.agent_circuit_state (reset_after);

-- =============================================================================
-- 3. agent_fix_log
--    Append-only log of every auto-fix attempt. Drives circuit-breaker
--    consecutive-failure counting and the dashboard "Recent fixes" view.
--    Code: agent-circuit-breaker.ts, agent-handler.ts
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.agent_fix_log (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  applied_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  category        TEXT        NOT NULL,
  action          TEXT        NOT NULL,
  success         BOOLEAN     NOT NULL,
  metric_key      TEXT,
  metric_before   TEXT,
  metric_after    TEXT,
  improved        BOOLEAN,
  circuit_opened  BOOLEAN     NOT NULL DEFAULT false,
  error_detail    TEXT
);

COMMENT ON TABLE public.agent_fix_log IS
  'Append-only log of every automated fix attempt by the agent runner. '
  'Used by the circuit breaker to count consecutive non-improving fixes '
  'and by the monitoring dashboard Recent Fixes panel. '
  'Managed by src/lib/api/agent-circuit-breaker.ts.';

CREATE INDEX IF NOT EXISTS afl_applied_at_idx
  ON public.agent_fix_log (applied_at DESC);

CREATE INDEX IF NOT EXISTS afl_category_applied_idx
  ON public.agent_fix_log (category, applied_at DESC);

-- =============================================================================
-- 4. RLS — restrict writes to service_role; allow reads to authenticated
-- =============================================================================

-- agent_settings
ALTER TABLE public.agent_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role can manage agent_settings"   ON public.agent_settings;
DROP POLICY IF EXISTS "authenticated can read agent_settings"    ON public.agent_settings;

CREATE POLICY "service_role can manage agent_settings"
  ON public.agent_settings FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "authenticated can read agent_settings"
  ON public.agent_settings FOR SELECT TO authenticated USING (true);

-- agent_circuit_state
ALTER TABLE public.agent_circuit_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role can manage agent_circuit_state" ON public.agent_circuit_state;
DROP POLICY IF EXISTS "authenticated can read agent_circuit_state"  ON public.agent_circuit_state;

CREATE POLICY "service_role can manage agent_circuit_state"
  ON public.agent_circuit_state FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "authenticated can read agent_circuit_state"
  ON public.agent_circuit_state FOR SELECT TO authenticated USING (true);

-- agent_fix_log
ALTER TABLE public.agent_fix_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role can manage agent_fix_log" ON public.agent_fix_log;
DROP POLICY IF EXISTS "authenticated can read agent_fix_log"  ON public.agent_fix_log;

CREATE POLICY "service_role can manage agent_fix_log"
  ON public.agent_fix_log FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "authenticated can read agent_fix_log"
  ON public.agent_fix_log FOR SELECT TO authenticated USING (true);
