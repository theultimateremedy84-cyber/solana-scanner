-- =============================================================================
-- Corruption Audit — Safe Validation (READ-ONLY — zero UPDATEs in this file)
-- Migration: 20260623000008_corruption_audit.sql
--
-- ──────────────────────────────────────────────────────────────────────────────
-- HOW THE CORRUPTION FINGERPRINT WORKS
-- ──────────────────────────────────────────────────────────────────────────────
-- For a CORRECTLY stored row (SOL-quoted pair used):
--   current_token_price_sol = 0.2012         ← price in SOL
--   current_token_price_usd = 14.016         ← price in USD
--   ratio = price_usd / price_sol = 69.66    ← implied SOL/USD rate (correct)
--
-- For a CORRUPTED row (USDC-quoted pair mistakenly used as SOL pair):
--   current_token_price_sol = 14.036         ← actually USDC price, not SOL
--   current_token_price_usd = 14.036         ← same USDC price stored twice
--   ratio = price_usd / price_sol = 1.0      ← both fields have same value (corrupted)
--
-- DETECTION RULE:
--   ratio < 5   → CORRUPTED  (SOL/USD can't be below $5)
--   ratio 5–15  → AMBIGUOUS  (investigate individually)
--   ratio > 15  → CORRECT    (SOL/USD has never been below $15 historically)
--
-- This is independent of the token's actual price and works for ALL tokens.
-- A $500 token correctly stored still has ratio ≈ 60-200.
-- A $0.001 token incorrectly stored still has ratio ≈ 1.0.
--
-- ──────────────────────────────────────────────────────────────────────────────
-- RUN ORDER: A → B → C → D — review each section before proceeding.
-- ──────────────────────────────────────────────────────────────────────────────


-- =============================================================================
-- SECTION A — Classification of all rows by corruption signal
-- =============================================================================

-- A1: Overall breakdown by corruption tier
SELECT
  CASE
    WHEN current_token_price_sol IS NULL
      OR current_token_price_usd IS NULL              THEN 'NO_PRICE_DATA'
    WHEN current_token_price_sol <= 0
      OR current_token_price_usd <= 0                 THEN 'ZERO_PRICE'
    WHEN (current_token_price_usd / current_token_price_sol) < 2
                                                       THEN 'CORRUPTED — ratio<2 (certain)'
    WHEN (current_token_price_usd / current_token_price_sol) < 5
                                                       THEN 'CORRUPTED — ratio<5 (very likely)'
    WHEN (current_token_price_usd / current_token_price_sol) < 15
                                                       THEN 'AMBIGUOUS — ratio 5–15'
    ELSE                                               'CORRECT  — ratio>15'
  END                                  AS classification,
  COUNT(*)                             AS row_count,
  COUNT(DISTINCT token_address)        AS unique_tokens,
  COUNT(DISTINCT wallet_address)       AS unique_wallets,
  ROUND(AVG(current_token_price_usd / NULLIF(current_token_price_sol,0))::numeric, 2)
                                       AS avg_ratio,
  ROUND(MIN(current_token_price_usd / NULLIF(current_token_price_sol,0))::numeric, 4)
                                       AS min_ratio,
  ROUND(MAX(current_token_price_usd / NULLIF(current_token_price_sol,0))::numeric, 2)
                                       AS max_ratio
FROM public.wallet_performance_history
WHERE current_token_price_sol IS NOT NULL
  AND current_token_price_usd IS NOT NULL
GROUP BY 1
ORDER BY 2 DESC;


-- A2: Distribution histogram — implied SOL/USD rates actually stored
-- (Shows exactly what exchange rate was implied when each row was written)
SELECT
  width_bucket(
    (current_token_price_usd / NULLIF(current_token_price_sol, 0))::numeric,
    0, 200, 20
  )                                    AS bucket_number,
  CONCAT(
    ROUND(((width_bucket(
      (current_token_price_usd / NULLIF(current_token_price_sol, 0))::numeric,
      0, 200, 20
    ) - 1) * 10)::numeric, 0),
    '–',
    ROUND(((width_bucket(
      (current_token_price_usd / NULLIF(current_token_price_sol, 0))::numeric,
      0, 200, 20
    )) * 10)::numeric, 0)
  )                                    AS implied_sol_usd_range,
  COUNT(*)                             AS row_count
FROM public.wallet_performance_history
WHERE current_token_price_sol > 0
  AND current_token_price_usd > 0
GROUP BY 1, 2
ORDER BY 1;
-- EXPECT: two clusters — one near 0–10 (corrupted) and one near 50–200 (correct)


-- =============================================================================
-- SECTION B — Dry-run report
-- =============================================================================

-- B1: Total affected tokens and wallets (corrupted only)
SELECT
  COUNT(DISTINCT token_address)  AS corrupted_tokens,
  COUNT(DISTINCT wallet_address) AS corrupted_wallets,
  COUNT(*)                       AS corrupted_rows,
  ROUND(SUM(current_position_value_sol)::numeric, 4) AS total_inflated_position_sol,
  ROUND(SUM(unrealized_profit)::numeric, 4)          AS total_inflated_unrealized_sol,
  ROUND(AVG(current_token_price_usd /
    NULLIF(current_token_price_sol, 0))::numeric, 4) AS avg_implied_ratio
FROM public.wallet_performance_history
WHERE current_token_price_sol > 0
  AND current_token_price_usd > 0
  AND (current_token_price_usd / current_token_price_sol) < 5;


-- B2: Top 20 most inflated ROI records
-- Shows wallet, token, what was stored, and the implied corruption ratio.
SELECT
  w.wallet_address,
  w.token_address,
  w.position_status,
  w.roi_multiple                                        AS stored_roi_multiple,
  w.peak_roi                                            AS stored_peak_roi,
  w.current_token_price_sol                             AS stored_price_sol,
  w.current_token_price_usd                             AS stored_price_usd,
  ROUND((w.current_token_price_usd /
    NULLIF(w.current_token_price_sol, 0))::numeric, 4)  AS implied_sol_usd_ratio,
  ROUND((w.current_token_price_sol /
    NULLIF(w.current_token_price_usd, 1))::numeric, 4)  AS corruption_multiplier,
  w.current_token_balance,
  w.current_position_value_sol                          AS stored_position_value_sol,
  -- What position value SHOULD be if price_sol was correct
  ROUND((w.current_token_balance *
    w.current_token_price_usd / 70)::numeric, 4)        AS estimated_true_position_sol,
  -- (using price_usd/70 as rough SOL/USD estimate — verify with live price)
  w.initial_investment,
  w.unrealized_profit                                   AS stored_unrealized_profit,
  w.last_updated
FROM public.wallet_performance_history w
WHERE w.current_token_price_sol > 0
  AND w.current_token_price_usd > 0
  AND (w.current_token_price_usd / w.current_token_price_sol) < 5
ORDER BY w.roi_multiple DESC NULLS LAST
LIMIT 20;


-- B3: Sample before/after dry-run for top 10 corrupted rows
-- Shows exact field values and what they would become after repair.
-- The "after" values zero out price-derived fields;
-- transaction-derived fields (realized_profit, initial_investment) are recalculated
-- from wallet_token_activity in Section D.
SELECT
  w.wallet_address,
  w.token_address,

  -- BEFORE (currently stored)
  w.current_token_price_sol        AS BEFORE_price_sol,
  w.current_token_price_usd        AS BEFORE_price_usd,
  w.current_position_value_sol     AS BEFORE_position_value,
  w.unrealized_profit              AS BEFORE_unrealized,
  w.roi_multiple                   AS BEFORE_roi,
  w.realized_profit                AS BEFORE_realized,
  w.initial_investment             AS BEFORE_investment,

  -- AFTER (what repair would write)
  NULL::NUMERIC                    AS AFTER_price_sol,
  w.current_token_price_usd        AS AFTER_price_usd,    -- preserve USD price
  0::NUMERIC                       AS AFTER_position_value,
  0::NUMERIC                       AS AFTER_unrealized,
  NULL::NUMERIC                    AS AFTER_roi,
  -- realized_profit and initial_investment come from Section D (source recalc)

  -- CORRUPTION EVIDENCE
  ROUND((w.current_token_price_usd /
    NULLIF(w.current_token_price_sol, 0))::numeric, 4) AS implied_sol_usd_ratio
    -- A healthy ratio is 60–200. A ratio near 1.0 proves the USDC price was stored.

FROM public.wallet_performance_history w
WHERE w.current_token_price_sol > 0
  AND w.current_token_price_usd > 0
  AND (w.current_token_price_usd / w.current_token_price_sol) < 5
ORDER BY w.roi_multiple DESC NULLS LAST
LIMIT 10;


-- =============================================================================
-- SECTION C — Per-token corruption report
-- =============================================================================

-- C1: Token-by-token breakdown
-- Review this before approving any repair. Each token must be assessed individually.
SELECT
  w.token_address,
  COUNT(*)                                             AS total_wallets,
  COUNT(*) FILTER (
    WHERE w.current_token_price_sol > 0
      AND w.current_token_price_usd > 0
      AND (w.current_token_price_usd / w.current_token_price_sol) < 5
  )                                                    AS corrupted_wallets,
  ROUND(
    100.0 * COUNT(*) FILTER (
      WHERE w.current_token_price_sol > 0
        AND w.current_token_price_usd > 0
        AND (w.current_token_price_usd / w.current_token_price_sol) < 5
    ) / NULLIF(COUNT(*), 0), 1
  )                                                    AS pct_corrupted,

  -- What was stored (for corrupted rows)
  ROUND(AVG(w.current_token_price_sol) FILTER (
    WHERE (w.current_token_price_usd / NULLIF(w.current_token_price_sol, 0)) < 5
  )::numeric, 6)                                       AS avg_stored_price_sol,
  ROUND(AVG(w.current_token_price_usd) FILTER (
    WHERE (w.current_token_price_usd / NULLIF(w.current_token_price_sol, 0)) < 5
  )::numeric, 6)                                       AS avg_stored_price_usd,
  ROUND(AVG(w.current_token_price_usd /
    NULLIF(w.current_token_price_sol, 0)) FILTER (
    WHERE (w.current_token_price_usd / NULLIF(w.current_token_price_sol, 0)) < 5
  )::numeric, 4)                                       AS avg_corruption_ratio,

  -- Financial impact of corruption
  ROUND(SUM(w.current_position_value_sol) FILTER (
    WHERE (w.current_token_price_usd / NULLIF(w.current_token_price_sol, 0)) < 5
  )::numeric, 4)                                       AS total_inflated_position_sol,
  ROUND(MAX(w.roi_multiple) FILTER (
    WHERE (w.current_token_price_usd / NULLIF(w.current_token_price_sol, 0)) < 5
  )::numeric, 2)                                       AS max_roi_in_corrupted_rows,

  -- Timestamp of the last corruption event
  MAX(w.last_updated) FILTER (
    WHERE (w.current_token_price_usd / NULLIF(w.current_token_price_sol, 0)) < 5
  )                                                    AS last_corruption_written_at

FROM public.wallet_performance_history w
GROUP BY w.token_address
HAVING COUNT(*) FILTER (
  WHERE w.current_token_price_sol > 0
    AND w.current_token_price_usd > 0
    AND (w.current_token_price_usd / w.current_token_price_sol) < 5
) > 0
ORDER BY corrupted_wallets DESC;


-- C2: For the top 5 most affected tokens, show a full wallet listing
-- Run this once per token — replace the token_address value as needed.
-- Example shown for ZINC; substitute your actual affected token addresses from C1.
SELECT
  wallet_address,
  position_status,
  initial_investment,
  current_token_balance,
  current_token_price_sol   AS STORED_price_sol,
  current_token_price_usd   AS STORED_price_usd,
  ROUND((current_token_price_usd /
    NULLIF(current_token_price_sol, 0))::numeric, 4) AS corruption_ratio,
  current_position_value_sol AS STORED_position_value,
  unrealized_profit          AS STORED_unrealized,
  roi_multiple               AS STORED_roi,
  realized_profit,
  last_updated
FROM public.wallet_performance_history
WHERE token_address = 'zinc155BS4mSPk8GXQj4R5hkVDQXcW253pTYq5SGyfi'  -- change per token
  AND current_token_price_sol > 0
  AND current_token_price_usd > 0
  AND (current_token_price_usd / current_token_price_sol) < 5
ORDER BY roi_multiple DESC NULLS LAST;


-- =============================================================================
-- SECTION D — Repair strategy from source transaction data (DRY RUN ONLY)
-- =============================================================================
-- This section shows EXACTLY what would change for each corrupted row,
-- recalculated from raw wallet_token_activity records — not from any heuristic.
--
-- The repair:
--   1. Re-aggregates investedSol, receivedSol, tokensBought, tokensSold
--      directly from wallet_token_activity (ground truth).
--   2. Re-derives position_status and realized_profit from those numbers
--      (no price needed for these fields).
--   3. Zeroes out price-dependent fields (position_value, unrealized, roi)
--      because correct live prices must come from the v10 worker on next scan.
--   4. Preserves current_token_price_usd (the USD price is correct even from
--      a USDC pair — it's only price_sol that was wrong).
--
-- ⚠  NO UPDATE IS EXECUTED HERE — this is a read-only dry run.
-- ──────────────────────────────────────────────────────────────────────────────

-- D1: Source recalculation preview — what repair would write
-- for each corrupted wallet×token pair
WITH source_aggregates AS (
  SELECT
    wallet_address,
    token_address,
    ROUND(SUM(CASE WHEN action_type = 'buy'  THEN COALESCE(amount_sol, 0) ELSE 0 END)::numeric, 6)
                                                          AS recalc_invested_sol,
    ROUND(SUM(CASE WHEN action_type = 'sell' THEN COALESCE(amount_sol, 0) ELSE 0 END)::numeric, 6)
                                                          AS recalc_received_sol,
    ROUND(SUM(CASE WHEN action_type = 'buy'  THEN COALESCE(token_amount, 0) ELSE 0 END)::numeric, 2)
                                                          AS recalc_tokens_bought,
    ROUND(SUM(CASE WHEN action_type = 'sell' THEN COALESCE(token_amount, 0) ELSE 0 END)::numeric, 2)
                                                          AS recalc_tokens_sold
  FROM public.wallet_token_activity
  GROUP BY wallet_address, token_address
),
corrupted AS (
  SELECT wph.*
  FROM public.wallet_performance_history wph
  WHERE wph.current_token_price_sol > 0
    AND wph.current_token_price_usd > 0
    AND (wph.current_token_price_usd / wph.current_token_price_sol) < 5
)
SELECT
  c.wallet_address,
  c.token_address,

  -- BEFORE: what is currently stored
  c.position_status                     AS BEFORE_position_status,
  c.initial_investment                  AS BEFORE_initial_investment,
  c.current_value                       AS BEFORE_current_value,
  c.realized_profit                     AS BEFORE_realized_profit,
  c.total_tokens_bought                 AS BEFORE_tokens_bought,
  c.total_tokens_sold                   AS BEFORE_tokens_sold,
  c.current_token_price_sol             AS BEFORE_price_sol_WRONG,
  c.current_position_value_sol          AS BEFORE_position_value_WRONG,
  c.unrealized_profit                   AS BEFORE_unrealized_WRONG,
  c.roi_multiple                        AS BEFORE_roi_WRONG,

  -- AFTER: what repair would write (from wallet_token_activity)
  s.recalc_invested_sol                 AS AFTER_initial_investment,
  s.recalc_received_sol                 AS AFTER_current_value,
  s.recalc_tokens_bought                AS AFTER_tokens_bought,
  s.recalc_tokens_sold                  AS AFTER_tokens_sold,
  CASE
    WHEN s.recalc_tokens_bought = 0     THEN 'UNKNOWN'
    WHEN s.recalc_tokens_sold = 0       THEN 'OPEN'
    WHEN s.recalc_tokens_sold >= s.recalc_tokens_bought * 0.95 THEN 'CLOSED'
    ELSE                                     'PARTIALLY_CLOSED'
  END                                   AS AFTER_position_status,
  CASE
    WHEN s.recalc_tokens_sold = 0
      THEN 0                                               -- OPEN: nothing realized
    WHEN s.recalc_tokens_sold >= s.recalc_tokens_bought * 0.95
      THEN s.recalc_received_sol - s.recalc_invested_sol   -- CLOSED: full P&L
    ELSE
      s.recalc_received_sol
        - (s.recalc_invested_sol
           * s.recalc_tokens_sold
           / NULLIF(s.recalc_tokens_bought, 0))            -- PARTIAL: proportional
  END                                   AS AFTER_realized_profit,
  NULL::NUMERIC                         AS AFTER_price_sol,   -- cleared; v10 will set
  0::NUMERIC                            AS AFTER_position_value,
  0::NUMERIC                            AS AFTER_unrealized,
  NULL::NUMERIC                         AS AFTER_roi,
  c.current_token_price_usd             AS AFTER_price_usd_preserved,

  -- Source data quality flags
  CASE
    WHEN s.wallet_address IS NULL THEN 'NO_ACTIVITY_RECORDS'
    WHEN s.recalc_tokens_bought = 0 AND c.initial_investment > 0
      THEN 'ACTIVITY_MISMATCH — perf has investment but no buy records'
    ELSE 'OK'
  END                                   AS data_quality_flag

FROM corrupted c
LEFT JOIN source_aggregates s
  ON s.wallet_address = c.wallet_address
  AND s.token_address = c.token_address
ORDER BY c.roi_multiple DESC NULLS LAST
LIMIT 50;


-- D2: Data quality check — how many corrupted rows have no matching activity records?
-- These rows CANNOT be repaired from source data and must be handled separately.
WITH source_aggregates AS (
  SELECT DISTINCT wallet_address, token_address
  FROM public.wallet_token_activity
),
corrupted AS (
  SELECT wallet_address, token_address
  FROM public.wallet_performance_history
  WHERE current_token_price_sol > 0
    AND current_token_price_usd > 0
    AND (current_token_price_usd / current_token_price_sol) < 5
)
SELECT
  COUNT(*)                                       AS total_corrupted_rows,
  COUNT(*) FILTER (WHERE s.wallet_address IS NOT NULL)
                                                 AS rows_with_activity_data,
  COUNT(*) FILTER (WHERE s.wallet_address IS NULL)
                                                 AS rows_without_activity_data,
  ROUND(100.0 * COUNT(*) FILTER (WHERE s.wallet_address IS NOT NULL) /
    NULLIF(COUNT(*), 0), 1)                      AS pct_repairable_from_source
FROM corrupted c
LEFT JOIN source_aggregates s
  ON s.wallet_address = c.wallet_address
  AND s.token_address = c.token_address;


-- D3: Ambiguous rows (ratio 5–15) — listed individually for manual review
-- Do NOT include these in any automated repair. Review one by one.
SELECT
  wallet_address,
  token_address,
  position_status,
  current_token_price_sol,
  current_token_price_usd,
  ROUND((current_token_price_usd /
    NULLIF(current_token_price_sol, 0))::numeric, 4) AS implied_sol_usd_ratio,
  initial_investment,
  unrealized_profit,
  roi_multiple,
  last_updated
FROM public.wallet_performance_history
WHERE current_token_price_sol > 0
  AND current_token_price_usd > 0
  AND (current_token_price_usd / current_token_price_sol) BETWEEN 5 AND 15
ORDER BY (current_token_price_usd / current_token_price_sol) ASC;
-- ↑ Rows at the bottom (ratio closer to 5) are more likely corrupted.
-- Rows near 15 may be legitimate tokens with a very low SOL/USD period.


-- =============================================================================
-- APPROVAL GATE
-- =============================================================================
-- After reviewing A1, B1, C1, D1 and D2 output:
--
-- 1. Paste the results here (in chat) for verification.
-- 2. I will confirm the repair is safe for each token.
-- 3. The actual UPDATE is in 20260623000009_repair_approved.sql
--    which will only be provided after you approve.
-- =============================================================================
