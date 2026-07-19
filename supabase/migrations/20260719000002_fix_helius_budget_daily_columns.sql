-- =============================================================================
-- fix_helius_budget_daily_columns
--
-- The helius_budget_daily table exists in production but only has three
-- columns: date, cu_used, updated_at.
--
-- The application code (helius-budget-persistence.ts, monitor-dashboard-handler.ts)
-- reads cu_budget and cu_remaining which do not exist — causing all budget
-- ceiling and headroom calculations to silently fail.
--
-- This migration adds the two missing columns with safe defaults.
-- =============================================================================

-- cu_budget: the configured daily Helius CU ceiling. Seeded from the
-- HELIUS_DAILY_BUDGET env var on server startup via helius-budget-persistence.ts.
-- Default 0 means "unconfigured" — the application treats 0 as "no limit known".
ALTER TABLE public.helius_budget_daily
  ADD COLUMN IF NOT EXISTS cu_budget    INTEGER NOT NULL DEFAULT 0 CHECK (cu_budget >= 0);

-- cu_remaining: computed headroom (cu_budget - cu_used), updated on each
-- flush. Stored as a column rather than a view so the monitor dashboard can
-- query it without arithmetic on the read path.
ALTER TABLE public.helius_budget_daily
  ADD COLUMN IF NOT EXISTS cu_remaining INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.helius_budget_daily.cu_budget IS
  'Configured daily Helius CU ceiling (from HELIUS_DAILY_BUDGET env var). '
  '0 = unconfigured / unknown.';

COMMENT ON COLUMN public.helius_budget_daily.cu_remaining IS
  'Remaining Helius CUs today (cu_budget - cu_used). Updated on each '
  '60-second flush by helius-budget-persistence.ts.';

-- Backfill cu_remaining for the two existing rows using the current cu_used.
-- cu_budget will stay 0 until the next server startup seeds it from env.
UPDATE public.helius_budget_daily
SET cu_remaining = GREATEST(0, cu_budget - cu_used);
