-- =============================================================================
-- Migration: 20260701000002_fix_data_regressions.sql
--
-- PURPOSE
--   Fixes three data quality regressions identified in the July 1 2026 audit:
--
--   A. roi_multiple regression (Audit 4)
--      172 rows lost their roi_multiple value after a partial enrichment run
--      overwrote existing computed values with NULL (never-degrade bug in
--      wallet-enricher.ts, now fixed in code).
--      This migration restores those values from the raw accounting columns
--      that were not affected: initial_investment and current_value.
--
--   B. win_rate / average_roi never populated (Audit 6)
--      The rescorer was never triggered after the patch deployed, so
--      win_rate = 0/835 and average_roi = 19/835.
--      This migration computes both directly from wallet_performance_history
--      CLOSED positions — no Helius API required.
--
--   C. intelligence_score still on 0-40 scale (Audit 6)
--      The new classifier outputs 0-100 but existing DB rows still carry the
--      old 0-40 values. This UPDATE scales them to 0-100 as a stopgap until
--      the boot rescorer (added in scoring-patch v1) finishes its first run.
--
-- IDEMPOTENCY
--   Each UPDATE is guarded by a WHERE clause that only touches rows needing
--   the fix. Safe to run more than once.
--
-- APPLY
--   Supabase Dashboard → SQL Editor: paste and click Run.
--   No DDL changes — data only. No rows are deleted.
-- =============================================================================


-- =============================================================================
-- A. Restore roi_multiple for rows that lost it (the 172-row regression)
-- =============================================================================

-- A1. CLOSED positions: roi = total_sol_received / initial_investment
--     current_value is the canonical name for total_sol_received in this table.
UPDATE public.wallet_performance_history
SET
  roi_multiple = ROUND(current_value::NUMERIC / NULLIF(initial_investment, 0), 4),
  last_updated = now()
WHERE position_status = 'CLOSED'
  AND initial_investment > 0
  AND current_value      > 0
  AND (roi_multiple IS NULL OR roi_multiple = 0);

-- A2. PARTIALLY_CLOSED positions: use realized_profit to back-calculate ROI
--     where realized_profit > 0 and initial_investment > 0.
--     ROI = (realized_profit + initial_investment) / initial_investment = 1 + r/i
UPDATE public.wallet_performance_history
SET
  roi_multiple = ROUND((realized_profit + initial_investment)::NUMERIC / NULLIF(initial_investment, 0), 4),
  last_updated = now()
WHERE position_status = 'PARTIALLY_CLOSED'
  AND initial_investment > 0
  AND realized_profit    > 0
  AND (roi_multiple IS NULL OR roi_multiple = 0);

-- A3. OPEN positions with unrealized P&L: estimate from unrealized_profit
--     Only set when initial_investment and unrealized_profit are both positive.
UPDATE public.wallet_performance_history
SET
  roi_multiple = ROUND((unrealized_profit + initial_investment)::NUMERIC / NULLIF(initial_investment, 0), 4),
  last_updated = now()
WHERE position_status = 'OPEN'
  AND initial_investment  > 0
  AND unrealized_profit   > 0
  AND (roi_multiple IS NULL OR roi_multiple = 0);


-- =============================================================================
-- B. Backfill win_rate and average_roi on the wallets table
--    Computed from CLOSED positions in wallet_performance_history.
--    Requires >= 1 closed position (same threshold as scoring-patch v1).
-- =============================================================================

WITH closed_stats AS (
  SELECT
    wallet_address,
    COUNT(*)                                                              AS closed_count,
    COUNT(*) FILTER (WHERE realized_profit > 0)                          AS profitable_count,
    AVG(roi_multiple) FILTER (WHERE roi_multiple IS NOT NULL)            AS avg_roi_closed,
    -- Include OPEN + PARTIALLY_CLOSED unrealized ROI for a richer average
    AVG(roi_multiple) FILTER (
      WHERE roi_multiple IS NOT NULL
        AND position_status IN ('OPEN', 'PARTIALLY_CLOSED', 'CLOSED')
    )                                                                     AS avg_roi_all
  FROM public.wallet_performance_history
  WHERE position_status IN ('CLOSED', 'OPEN', 'PARTIALLY_CLOSED')
  GROUP BY wallet_address
)
UPDATE public.wallets w
SET
  win_rate    = CASE
                  WHEN cs.closed_count >= 1
                  THEN ROUND(cs.profitable_count::NUMERIC / cs.closed_count, 4)
                  ELSE w.win_rate
                END,
  average_roi = COALESCE(cs.avg_roi_closed, cs.avg_roi_all),
  updated_at  = now()
FROM closed_stats cs
WHERE w.wallet_address = cs.wallet_address
  AND cs.closed_count >= 1;


-- =============================================================================
-- C. Scale existing intelligence_score from 0-40 to 0-100 as a stopgap
--    The old scorer used a 40-point max; the new scorer uses 100.
--    Rows with score > 40 are already on the new scale — skip them.
--    Rows with score = 0 (no evidence) are left alone.
--    The boot rescorer will overwrite all of these with properly computed
--    values within 10 seconds of the next server deploy; this UPDATE just
--    prevents the UI from showing incorrectly deflated scores in the meantime.
-- =============================================================================

UPDATE public.wallets
SET
  intelligence_score = LEAST(100, ROUND(intelligence_score * 2.5)),
  updated_at         = now()
WHERE intelligence_score IS NOT NULL
  AND intelligence_score > 0
  AND intelligence_score <= 40;


-- =============================================================================
-- VERIFY — run these after applying to confirm the fix
-- =============================================================================

-- 1. roi_multiple coverage (expect > 37%, ideally ~50%+):
--    SELECT
--      COUNT(*)                                        AS total,
--      COUNT(*) FILTER (WHERE roi_multiple IS NOT NULL
--                         AND roi_multiple > 0)        AS roi_populated,
--      ROUND(100.0 * COUNT(*) FILTER (WHERE roi_multiple IS NOT NULL
--                                       AND roi_multiple > 0) / COUNT(*), 1) AS pct
--    FROM public.wallet_performance_history;

-- 2. win_rate coverage (expect > 0):
--    SELECT
--      COUNT(*)                                    AS total_wallets,
--      COUNT(*) FILTER (WHERE win_rate IS NOT NULL) AS win_rate_set
--    FROM public.wallets;

-- 3. intelligence_score range (expect max > 40, avg > 2):
--    SELECT MIN(intelligence_score), MAX(intelligence_score), AVG(intelligence_score)
--    FROM public.wallets
--    WHERE intelligence_score IS NOT NULL;
