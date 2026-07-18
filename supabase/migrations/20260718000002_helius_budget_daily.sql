-- =============================================================================
-- helius_budget_daily — persist daily Helius CU usage across Railway restarts
--
-- PROBLEM (audit finding):
--   The Helius daily CU budget counter lives in globalThis (process memory).
--   Every Railway restart / redeploy zeros it, allowing the pipeline to burn
--   the full daily quota again immediately — causing unexpected Helius billing
--   overruns during active discovery.
--
-- FIX:
--   This table stores one row per UTC calendar day. On startup, server.ts
--   calls initHeliusBudgetPersistence() which reads today's row and seeds the
--   in-memory counter with the already-consumed amount. A 60-second flush
--   interval keeps the row up to date so restarts lose at most ~60s of history.
--
-- SCHEMA:
--   date       — UTC calendar date (YYYY-MM-DD), primary key
--   cu_used    — cumulative Helius CUs consumed so far today
--   updated_at — last flush timestamp (for observability)
--
-- RETENTION:
--   Rows older than 90 days are pruned by the existing helius-cu-log-retention-
--   scheduler to keep the table small. Alternatively add a pg_cron job:
--     SELECT cron.schedule('helius-budget-daily-prune', '0 3 * * *',
--       $$DELETE FROM helius_budget_daily WHERE date < CURRENT_DATE - 90$$);
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.helius_budget_daily (
  date        DATE        PRIMARY KEY,
  cu_used     INTEGER     NOT NULL DEFAULT 0 CHECK (cu_used >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.helius_budget_daily IS
  'Persists daily Helius CU usage across Railway restarts. '
  'One row per UTC calendar day. Seeded on server startup, flushed every 60s.';

-- Only the server (service_role) writes this table.
-- No read access for anon/authenticated — it exposes billing internals.
ALTER TABLE public.helius_budget_daily ENABLE ROW LEVEL SECURITY;

GRANT ALL ON public.helius_budget_daily TO service_role;

DROP POLICY IF EXISTS "Service role manages budget" ON public.helius_budget_daily;
CREATE POLICY "Service role manages budget"
  ON public.helius_budget_daily FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Index for the retention prune query (WHERE date < CURRENT_DATE - 90).
CREATE INDEX IF NOT EXISTS helius_budget_daily_date_idx
  ON public.helius_budget_daily (date DESC);
