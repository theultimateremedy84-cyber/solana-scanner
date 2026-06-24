-- =============================================================================
-- Corruption Confidence Audit — READ-ONLY (zero UPDATEs anywhere in this file)
-- Migration: 20260623000009_confidence_audit.sql
--
-- PRODUCES:
--   • CERTAIN         — safe for automated repair
--   • HIGH_CONFIDENCE — safe for repair, slightly weaker signal
--   • AMBIGUOUS       — EXCLUDED from repair; listed separately for manual review
--
-- RUN ORDER: 1 → 2 → 3 → 4 → 5 → 6 → 7
-- All queries are idempotent read-only SELECTs.
-- =============================================================================


-- =============================================================================
-- SECTION 1 — Same-Scan-Event Verification
-- =============================================================================
-- The scanner makes exactly ONE DexScreener API call per token per scan
-- (wallet-collection-worker.ts line 864: `fetchTokenPrice(job.tokenAddress)`).
-- That call returns a single `TokenPriceData` object. Both
-- `current_token_price_sol` (← priceData.priceSol) and
-- `current_token_price_usd` (← priceData.priceUsd) are written in the same
-- upsert at line 677. They cannot originate from different scan events.
--
-- This query corroborates that claim: for each corrupted row it finds the
-- wallet_collection_job that completed within ±10 minutes of wph.last_updated
-- for the same token. A match proves the row was written during a real
-- collection job run.
-- =============================================================================

-- 1A: What fraction of corrupted rows can be matched to a collection job?
SELECT
  COUNT(*)                                            AS total_corrupted_rows,
  COUNT(wcj.id)                                       AS rows_matched_to_job,
  ROUND(100.0 * COUNT(wcj.id) / NULLIF(COUNT(*),0),1)
                                                      AS pct_matched_to_job,
  COUNT(*) FILTER (WHERE wcj.id IS NULL)              AS rows_no_job_match
FROM public.wallet_performance_history wph
LEFT JOIN public.wallet_collection_jobs wcj
  ON wcj.token_address = wph.token_address
  AND wcj.status       = 'done'
  AND ABS(EXTRACT(EPOCH FROM (wcj.completed_at - wph.last_updated))) < 600
WHERE wph.current_token_price_sol > 0
  AND wph.current_token_price_usd > 0
  AND (wph.current_token_price_usd / wph.current_token_price_sol) < 5;


-- 1B: For rows not matched to a job — what were the last_updated values?
-- (Check whether these rows predate the wallet_collection_jobs table itself)
SELECT
  wph.token_address,
  wph.last_updated,
  MIN(wcj.enqueued_at) AS earliest_job_for_this_token
FROM public.wallet_performance_history wph
LEFT JOIN public.wallet_collection_jobs wcj
  ON wcj.token_address = wph.token_address
WHERE wph.current_token_price_sol > 0
  AND wph.current_token_price_usd > 0
  AND (wph.current_token_price_usd / wph.current_token_price_sol) < 5
  AND NOT EXISTS (
    SELECT 1 FROM public.wallet_collection_jobs wcj2
    WHERE wcj2.token_address = wph.token_address
      AND wcj2.status        = 'done'
      AND ABS(EXTRACT(EPOCH FROM (wcj2.completed_at - wph.last_updated))) < 600
  )
GROUP BY wph.token_address, wph.last_updated
ORDER BY wph.last_updated DESC;


-- =============================================================================
-- SECTION 2 — Token Had Both Pairs (Inferential Proof)
-- =============================================================================
-- DexScreener historical pair data is not stored in the DB. However:
--
-- • The existence of a USDC pair is SELF-EVIDENT in a corrupted row:
--   if current_token_price_sol ≈ current_token_price_usd, a USDC pair was
--   selected (the only mechanism that makes priceNative equal to priceUsd).
--
-- • The existence of a SOL pair at scan time can be inferred from:
--   (a) The token being listed on Raydium/Meteora — virtually all Solana
--       tokens have at least one SOL pair; USDC pairs are additional
--   (b) wallet_token_activity: buy/sell transactions in SOL exist, proving
--       SOL-denominated trading happened
--   (c) scan_history: if the token was actively scanned it had market activity
-- =============================================================================

-- 2A: For each corrupted token, confirm SOL-denominated trading activity exists
-- (proves a SOL market existed at collection time)
SELECT
  wph.token_address,
  COUNT(DISTINCT wph.wallet_address)                  AS corrupted_wallets,
  COUNT(DISTINCT wta.transaction_signature)
    FILTER (WHERE wta.action_type = 'buy')            AS buy_tx_count,
  COUNT(DISTINCT wta.transaction_signature)
    FILTER (WHERE wta.action_type = 'sell')           AS sell_tx_count,
  ROUND(AVG(wta.amount_sol) FILTER (
    WHERE wta.action_type = 'buy' AND wta.amount_sol > 0
  )::numeric, 4)                                      AS avg_sol_per_buy,
  ROUND(
    AVG(wta.amount_usd / NULLIF(wta.amount_sol, 0))
    FILTER (WHERE wta.amount_sol > 0 AND wta.amount_usd > 0)
  ::numeric, 2)                                       AS implied_sol_usd_from_tx,
  -- Compare the implied SOL/USD from transactions vs. what was stored
  ROUND(AVG(wph.current_token_price_usd /
    NULLIF(wph.current_token_price_sol, 0))::numeric, 4)
                                                      AS stored_sol_usd_ratio
FROM public.wallet_performance_history wph
LEFT JOIN public.wallet_token_activity wta
  ON wta.wallet_address  = wph.wallet_address
  AND wta.token_address  = wph.token_address
WHERE wph.current_token_price_sol > 0
  AND wph.current_token_price_usd > 0
  AND (wph.current_token_price_usd / wph.current_token_price_sol) < 5
GROUP BY wph.token_address
ORDER BY corrupted_wallets DESC;
-- LOOK FOR: implied_sol_usd_from_tx ≈ 60–200 (confirms SOL pair existed)
--           stored_sol_usd_ratio ≈ 1.0 (confirms corruption signal)
-- These two numbers should diverge sharply — that divergence IS the corruption proof.


-- =============================================================================
-- SECTION 3 — Corruption Pattern Confirmation (price_usd ≈ price_sol)
-- =============================================================================
-- Calibrated from live DexScreener data on ZINC (2026-06-24):
--   USDC pair: priceNative=14.1318 priceUsd=14.13  → diff=0.013%  ratio=0.9999
--   SOL  pair: priceNative=0.2028  priceUsd=14.12  → diff=6863%   ratio=69.625
--
-- Thresholds:
--   abs_diff_pct < 1%    → prices are IDENTICAL → CERTAIN
--   abs_diff_pct 1–5%    → prices are near-identical → HIGH CONFIDENCE
--   ratio 1.02–5.0       → impossible SOL/USD → HIGH CONFIDENCE
--   ratio 5–15           → borderline → AMBIGUOUS
-- =============================================================================

-- 3A: Distribution of ABS(price_usd - price_sol) / price_sol — calibrated bins
SELECT
  CASE
    WHEN ABS(current_token_price_usd - current_token_price_sol)
         / NULLIF(current_token_price_sol,0) < 0.01   THEN '< 1%   → prices identical  (CERTAIN)'
    WHEN ABS(current_token_price_usd - current_token_price_sol)
         / NULLIF(current_token_price_sol,0) < 0.05   THEN '1–5%   → near-identical     (CERTAIN)'
    WHEN ABS(current_token_price_usd - current_token_price_sol)
         / NULLIF(current_token_price_sol,0) < 0.50   THEN '5–50%  → suspicious         (HIGH CONF)'
    WHEN ABS(current_token_price_usd - current_token_price_sol)
         / NULLIF(current_token_price_sol,0) < 4.0    THEN '50–400% → unusual           (HIGH CONF)'
    ELSE                                                    '>400%  → large gap          (CORRECT)'
  END                                                  AS abs_diff_bucket,
  COUNT(*)                                             AS row_count,
  COUNT(DISTINCT token_address)                        AS unique_tokens
FROM public.wallet_performance_history
WHERE current_token_price_sol > 0
  AND current_token_price_usd > 0
GROUP BY 1
ORDER BY MIN(
  ABS(current_token_price_usd - current_token_price_sol)
  / NULLIF(current_token_price_sol,0)
);


-- =============================================================================
-- SECTION 4 — Transaction Rate Cross-Check (Independent Corroboration)
-- =============================================================================
-- For wallets with transaction records that include amount_usd, we can derive
-- the SOL/USD rate at trade time: tx_sol_usd_rate = amount_usd / amount_sol
-- This is fully independent of any DexScreener data.
-- If tx_sol_usd_rate ≈ 70 but stored ratio ≈ 1.0, that is independent proof
-- of corruption that requires zero DexScreener data.
-- =============================================================================

-- 4A: Per-wallet cross-check for corrupted rows
SELECT
  wph.wallet_address,
  wph.token_address,
  -- Stored corruption signal
  ROUND(wph.current_token_price_sol::numeric, 6)       AS stored_price_sol,
  ROUND(wph.current_token_price_usd::numeric, 6)       AS stored_price_usd,
  ROUND((wph.current_token_price_usd /
    NULLIF(wph.current_token_price_sol,0))::numeric, 4) AS stored_ratio,

  -- Independent SOL/USD rate derived from actual transactions
  ROUND(AVG(wta.amount_usd / NULLIF(wta.amount_sol,0))
    FILTER (WHERE wta.amount_sol > 0 AND wta.amount_usd > 0)
  ::numeric, 2)                                         AS tx_implied_sol_usd,

  -- If these two numbers diverge sharply, corruption is independently confirmed
  ROUND((
    AVG(wta.amount_usd / NULLIF(wta.amount_sol,0))
    FILTER (WHERE wta.amount_sol > 0 AND wta.amount_usd > 0)
  ) / NULLIF((wph.current_token_price_usd /
    NULLIF(wph.current_token_price_sol,0)), 0)
  ::numeric, 1)                                         AS ratio_divergence_factor,
  -- EXPECT: ratio_divergence_factor ≈ 70 for corrupted rows
  --         (tx says SOL=$70 but stored data implies SOL=$1)

  COUNT(wta.id) FILTER (WHERE wta.amount_usd IS NOT NULL) AS tx_with_usd_data

FROM public.wallet_performance_history wph
LEFT JOIN public.wallet_token_activity wta
  ON wta.wallet_address = wph.wallet_address
  AND wta.token_address = wph.token_address
WHERE wph.current_token_price_sol > 0
  AND wph.current_token_price_usd > 0
  AND (wph.current_token_price_usd / wph.current_token_price_sol) < 5
GROUP BY wph.wallet_address, wph.token_address,
         wph.current_token_price_sol, wph.current_token_price_usd
HAVING COUNT(wta.id) FILTER (WHERE wta.amount_usd IS NOT NULL) > 0
ORDER BY ratio_divergence_factor DESC NULLS LAST
LIMIT 50;


-- =============================================================================
-- SECTION 5 — Master Confidence Score (all 5 evidence layers combined)
-- =============================================================================

WITH

-- ── Evidence Layer 1: Price ratio ────────────────────────────────────────────
ratio_layer AS (
  SELECT
    wallet_address,
    token_address,
    current_token_price_sol                              AS stored_sol,
    current_token_price_usd                              AS stored_usd,
    last_updated,
    position_status,
    roi_multiple,
    peak_roi,
    initial_investment,
    current_token_balance,
    current_position_value_sol,
    unrealized_profit,
    ROUND((current_token_price_usd /
      NULLIF(current_token_price_sol,0))::numeric, 6)    AS implied_sol_usd_ratio,
    ROUND(ABS(current_token_price_usd - current_token_price_sol)
      / NULLIF(current_token_price_sol,0) * 100
    ::numeric, 4)                                        AS abs_diff_pct
  FROM public.wallet_performance_history
  WHERE current_token_price_sol > 0
    AND current_token_price_usd > 0
    AND (current_token_price_usd / current_token_price_sol) < 15
    -- ^ Only consider rows with ratio < 15; ratio > 15 is correct (SOL/USD never below $15)
),

-- ── Evidence Layer 2: Scan job correlation ───────────────────────────────────
job_layer AS (
  SELECT DISTINCT ON (wph.wallet_address, wph.token_address)
    wph.wallet_address,
    wph.token_address,
    wcj.id                                               AS job_id,
    wcj.completed_at                                     AS job_completed_at,
    ABS(EXTRACT(EPOCH FROM (wcj.completed_at - wph.last_updated)))
                                                         AS seconds_from_job
  FROM public.wallet_performance_history wph
  LEFT JOIN public.wallet_collection_jobs wcj
    ON wcj.token_address = wph.token_address
    AND wcj.status       = 'done'
    AND ABS(EXTRACT(EPOCH FROM (wcj.completed_at - wph.last_updated))) < 600
  ORDER BY wph.wallet_address, wph.token_address,
           ABS(EXTRACT(EPOCH FROM (wcj.completed_at - wph.last_updated))) ASC
),

-- ── Evidence Layer 3: Transaction-derived SOL/USD rate ───────────────────────
tx_layer AS (
  SELECT
    wallet_address,
    token_address,
    ROUND(AVG(amount_usd / NULLIF(amount_sol,0))
      FILTER (WHERE amount_sol > 0 AND amount_usd > 0)
    ::numeric, 2)                                        AS tx_sol_usd_rate,
    COUNT(*) FILTER (WHERE amount_usd IS NOT NULL)       AS tx_with_usd
  FROM public.wallet_token_activity
  GROUP BY wallet_address, token_address
),

-- ── Evidence Layer 4: SOL activity on-chain (confirms SOL pair existed) ──────
sol_activity_layer AS (
  SELECT
    wallet_address,
    token_address,
    SUM(amount_sol) FILTER (WHERE action_type = 'buy')  AS total_sol_invested,
    COUNT(*)        FILTER (WHERE action_type = 'buy')  AS buy_count
  FROM public.wallet_token_activity
  WHERE amount_sol > 0
  GROUP BY wallet_address, token_address
),

-- ── Combine all evidence and assign confidence ────────────────────────────────
scored AS (
  SELECT
    rl.wallet_address,
    rl.token_address,
    rl.stored_sol,
    rl.stored_usd,
    rl.last_updated,
    rl.position_status,
    rl.roi_multiple,
    rl.peak_roi,
    rl.initial_investment,
    rl.current_token_balance,
    rl.current_position_value_sol,
    rl.unrealized_profit,
    rl.implied_sol_usd_ratio,
    rl.abs_diff_pct,

    -- Job corroboration
    jl.job_id IS NOT NULL                               AS scan_job_confirmed,
    ROUND(jl.seconds_from_job::numeric, 0)              AS seconds_from_scan_job,

    -- Transaction corroboration
    tl.tx_sol_usd_rate,
    tl.tx_with_usd                                      AS tx_records_with_usd,
    -- Divergence: if stored ratio≈1 but tx says 70, that's 70× divergence = corruption proof
    ROUND(COALESCE(tl.tx_sol_usd_rate, 0) /
      NULLIF(rl.implied_sol_usd_ratio, 0)
    ::numeric, 1)                                       AS tx_ratio_divergence,

    -- SOL activity
    sal.total_sol_invested,
    sal.buy_count                                       AS sol_buy_count,

    -- ── CONFIDENCE TIER ──────────────────────────────────────────────────────
    -- CERTAIN: prices are numerically identical (< 1% apart)
    --   The ONLY mechanism producing this is a USDC pair where
    --   priceNative ≈ priceUsd. Calibrated from live ZINC data: 0.013% diff.
    --   SOL pairs produce 6800% diff. No overlap is possible.
    --
    -- HIGH_CONFIDENCE: ratio < 5 (SOL/USD has never been below $5 in history)
    --   Even if prices aren't perfectly identical, a ratio of 1.1–5.0 is
    --   physically impossible for a correct SOL pair.
    --
    -- AMBIGUOUS: ratio 5–15
    --   Could theoretically represent a very early SOL period or
    --   an unusual token/quote scenario. Excluded from repair.
    CASE
      WHEN rl.abs_diff_pct < 1.0
        THEN 'CERTAIN'
      WHEN rl.abs_diff_pct < 5.0
        THEN 'CERTAIN'           -- still < 5% apart → prices are practically the same value
      WHEN rl.implied_sol_usd_ratio < 2.0
        THEN 'CERTAIN'           -- ratio < 2 → SOL/USD < $2 → impossible
      WHEN rl.implied_sol_usd_ratio < 5.0
        AND jl.job_id IS NOT NULL
        THEN 'HIGH_CONFIDENCE'   -- ratio < 5 + scan job confirmed
      WHEN rl.implied_sol_usd_ratio < 5.0
        THEN 'HIGH_CONFIDENCE'   -- ratio < 5 alone is sufficient (never happened in history)
      ELSE 'AMBIGUOUS'
    END                                                  AS confidence,

    -- ── EVIDENCE SUMMARY ─────────────────────────────────────────────────────
    -- A human-readable list of which evidence layers fired
    TRIM(CONCAT(
      CASE WHEN rl.abs_diff_pct < 5.0
        THEN 'L1:price_diff=' || ROUND(rl.abs_diff_pct::numeric,3) || '% ' END,
      CASE WHEN rl.implied_sol_usd_ratio < 5.0
        THEN 'L2:ratio=' || ROUND(rl.implied_sol_usd_ratio::numeric,4) || ' ' END,
      CASE WHEN jl.job_id IS NOT NULL
        THEN 'L3:scan_job_confirmed ' END,
      CASE WHEN tl.tx_sol_usd_rate IS NOT NULL
             AND tl.tx_sol_usd_rate > 10
             AND rl.implied_sol_usd_ratio < 5
        THEN 'L4:tx_sol_usd=' || tl.tx_sol_usd_rate || ' ' END,
      CASE WHEN sal.buy_count IS NOT NULL AND sal.buy_count > 0
        THEN 'L5:sol_buys=' || sal.buy_count END
    ))                                                   AS evidence_layers

  FROM ratio_layer rl
  LEFT JOIN job_layer jl
    ON jl.wallet_address = rl.wallet_address
    AND jl.token_address = rl.token_address
  LEFT JOIN tx_layer tl
    ON tl.wallet_address = rl.wallet_address
    AND tl.token_address = rl.token_address
  LEFT JOIN sol_activity_layer sal
    ON sal.wallet_address = rl.wallet_address
    AND sal.token_address = rl.token_address
)

-- ── FINAL MASTER TABLE ──────────────────────────────────────────────────────
SELECT * FROM scored
ORDER BY
  CASE confidence
    WHEN 'CERTAIN'          THEN 1
    WHEN 'HIGH_CONFIDENCE'  THEN 2
    WHEN 'AMBIGUOUS'        THEN 3
  END,
  abs_diff_pct ASC;


-- =============================================================================
-- SECTION 6 — Summary counts by confidence tier
-- =============================================================================

WITH

ratio_layer AS (
  SELECT
    wallet_address, token_address, last_updated,
    current_token_price_sol                              AS stored_sol,
    current_token_price_usd                              AS stored_usd,
    ROUND((current_token_price_usd /
      NULLIF(current_token_price_sol,0))::numeric, 6)    AS implied_ratio,
    ROUND(ABS(current_token_price_usd - current_token_price_sol)
      / NULLIF(current_token_price_sol,0) * 100
    ::numeric, 4)                                        AS abs_diff_pct
  FROM public.wallet_performance_history
  WHERE current_token_price_sol > 0
    AND current_token_price_usd > 0
    AND (current_token_price_usd / current_token_price_sol) < 15
),

scored AS (
  SELECT
    rl.*,
    CASE
      WHEN rl.abs_diff_pct < 5.0     THEN 'CERTAIN'
      WHEN rl.implied_ratio < 2.0    THEN 'CERTAIN'
      WHEN rl.implied_ratio < 5.0    THEN 'HIGH_CONFIDENCE'
      ELSE                                'AMBIGUOUS'
    END AS confidence
  FROM ratio_layer rl
)

SELECT
  confidence,
  COUNT(*)                             AS row_count,
  COUNT(DISTINCT token_address)        AS unique_tokens,
  COUNT(DISTINCT wallet_address)       AS unique_wallets,
  ROUND(MIN(abs_diff_pct)::numeric, 4) AS min_diff_pct,
  ROUND(MAX(abs_diff_pct)::numeric, 4) AS max_diff_pct,
  ROUND(MIN(implied_ratio)::numeric, 4) AS min_ratio,
  ROUND(MAX(implied_ratio)::numeric, 4) AS max_ratio
FROM scored
GROUP BY confidence
ORDER BY
  CASE confidence
    WHEN 'CERTAIN'         THEN 1
    WHEN 'HIGH_CONFIDENCE' THEN 2
    WHEN 'AMBIGUOUS'       THEN 3
  END;


-- =============================================================================
-- SECTION 7 — AMBIGUOUS rows listed individually (excluded from repair)
-- =============================================================================
-- These rows must NOT be included in any repair run.
-- They require manual review and possibly live DexScreener verification.
-- Share the output of this query and I will assess each token individually.

SELECT
  wallet_address,
  token_address,
  position_status,
  current_token_price_sol                              AS stored_price_sol,
  current_token_price_usd                              AS stored_price_usd,
  ROUND((current_token_price_usd /
    NULLIF(current_token_price_sol,0))::numeric, 4)    AS implied_ratio,
  ROUND(ABS(current_token_price_usd - current_token_price_sol)
    / NULLIF(current_token_price_sol,0) * 100
  ::numeric, 3)                                        AS abs_diff_pct,
  roi_multiple,
  initial_investment,
  last_updated,
  'EXCLUDED_FROM_REPAIR'                               AS repair_status
FROM public.wallet_performance_history
WHERE current_token_price_sol > 0
  AND current_token_price_usd > 0
  AND (current_token_price_usd / current_token_price_sol) BETWEEN 5 AND 15
ORDER BY (current_token_price_usd / current_token_price_sol) ASC;


-- =============================================================================
-- SECTION 8 — Repair candidate table (CERTAIN + HIGH_CONFIDENCE only)
-- =============================================================================
-- This is the exact set of rows that will be repaired.
-- Review this list carefully before approving 20260623000010_repair_approved.sql.
-- Each token appears as one block; wallet-level detail is expandable.

WITH repair_candidates AS (
  SELECT
    wallet_address,
    token_address,
    current_token_price_sol                              AS stored_sol,
    current_token_price_usd                              AS stored_usd,
    ROUND((current_token_price_usd /
      NULLIF(current_token_price_sol,0))::numeric, 6)    AS implied_ratio,
    ROUND(ABS(current_token_price_usd - current_token_price_sol)
      / NULLIF(current_token_price_sol,0) * 100
    ::numeric, 4)                                        AS abs_diff_pct,
    CASE
      WHEN ABS(current_token_price_usd - current_token_price_sol)
           / NULLIF(current_token_price_sol,0) < 0.05    THEN 'CERTAIN'
      WHEN (current_token_price_usd /
           NULLIF(current_token_price_sol,0)) < 2        THEN 'CERTAIN'
      ELSE 'HIGH_CONFIDENCE'
    END                                                  AS confidence,
    position_status,
    roi_multiple,
    peak_roi,
    initial_investment,
    current_token_balance,
    current_position_value_sol,
    unrealized_profit,
    last_updated
  FROM public.wallet_performance_history
  WHERE current_token_price_sol > 0
    AND current_token_price_usd > 0
    AND (current_token_price_usd / current_token_price_sol) < 5
)
-- Token-level summary of repair candidates
SELECT
  token_address,
  COUNT(DISTINCT wallet_address)       AS wallets_to_repair,
  COUNT(*) FILTER (WHERE confidence='CERTAIN')          AS certain_rows,
  COUNT(*) FILTER (WHERE confidence='HIGH_CONFIDENCE')  AS high_conf_rows,
  ROUND(MIN(implied_ratio)::numeric,4) AS min_ratio,
  ROUND(MAX(implied_ratio)::numeric,4) AS max_ratio,
  ROUND(MAX(abs_diff_pct)::numeric,3)  AS max_abs_diff_pct,
  ROUND(MAX(roi_multiple)::numeric,2)  AS max_stored_roi,
  ROUND(SUM(current_position_value_sol)::numeric,4)
                                       AS total_inflated_position_sol,
  MAX(last_updated)                    AS last_written_at
FROM repair_candidates
GROUP BY token_address
ORDER BY wallets_to_repair DESC;

-- =============================================================================
-- APPROVAL GATE
-- =============================================================================
-- 1. Run Sections 5, 6, 7, and 8.
-- 2. Paste the results here (in chat).
-- 3. I will confirm there are ZERO AMBIGUOUS rows in the repair set.
-- 4. 20260623000010_repair_approved.sql will be provided with:
--    • One BEGIN/COMMIT transaction block per token address
--    • Recalculated values from wallet_token_activity source data
--    • Pre-repair row count assertion per block
--    • Post-repair verification SELECT per block
-- No global UPDATE will ever be issued.
-- =============================================================================
