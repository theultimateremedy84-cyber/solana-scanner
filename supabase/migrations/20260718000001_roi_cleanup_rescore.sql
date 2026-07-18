-- =============================================================================
-- Migration: 20260718000001_roi_cleanup_rescore.sql
--
-- PURPOSE
--   Two-phase fix for the ROI distortion + stale scoring identified in the
--   2026-07-18 audit.
--
-- PHASE 1 — ROI cleanup
--   Nulls out `roi_multiple` and `peak_roi` on CLOSED positions where the
--   return is statistically implausible for the investment size:
--     • roi_multiple > 200 AND initial_investment < 0.10 SOL
--   This threshold (200×) covers:
--     - All rows the original 500× migrations intended to fix but missed
--       because they were created by live enrichment *after* those migrations ran
--     - The 100–200× gap that was left behind by the 500× threshold
--   A 200× return on < 0.10 SOL (< $15) is economic noise for pump.fun tokens.
--   Wallets with legitimate 200×+ returns on real-sized positions (≥ 0.10 SOL)
--   are NOT touched.
--
-- PHASE 2 — Full wallet rescore (SQL port of wallet-classifier.ts v8)
--   Re-reads from wallet_raw_tx_metrics + wallet_performance_history and
--   recomputes every scored column in the wallets table:
--     wallet_classification, intelligence_score, win_rate, average_roi,
--     total_buys, total_sells, closed_position_count, evidence_quality,
--     confidence_tier, conviction_score, score_computed_at
--
--   Mirrors the v8 classifier logic exactly:
--     • Hard gate: ≥ 1 CLOSED with initial_investment > 0.001 AND total_sol_received > 0
--     • Win rate: requires ≥ 3 real exits (min sample for statistical signal)
--     • Classification thresholds from wallet-classifier.ts constants
--     • Score formula: (win_rate×30 + capped_roi×25 + conviction×10) × 100/65
--       scaled to 0–1 with sample_confidence dampening
--
-- SAFE TO RE-RUN: phases are idempotent — re-running the cleanup finds 0 rows;
--   re-running the rescore overwrites with the same computed values.
--
-- AFTER RUNNING:
--   Call SELECT public.refresh_verified_positions(); to sync verified_positions.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- PHASE 1: ROI distortion cleanup
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE affected INTEGER;
BEGIN
  SELECT COUNT(*) INTO affected
  FROM wallet_performance_history
  WHERE position_status   = 'CLOSED'
    AND roi_multiple       > 200
    AND initial_investment > 0
    AND initial_investment < 0.10;
  RAISE NOTICE '[ROI-cleanup] Rows to null: %', affected;
END $$;

UPDATE wallet_performance_history
SET
  roi_multiple = NULL,
  peak_roi     = NULL,
  last_updated = now()
WHERE position_status   = 'CLOSED'
  AND roi_multiple       > 200
  AND initial_investment > 0
  AND initial_investment < 0.10;

DO $$
DECLARE remaining INTEGER;
BEGIN
  SELECT COUNT(*) INTO remaining
  FROM wallet_performance_history
  WHERE position_status   = 'CLOSED'
    AND roi_multiple       > 200
    AND initial_investment > 0
    AND initial_investment < 0.10;

  IF remaining > 0 THEN
    RAISE WARNING '[ROI-cleanup] % rows still distorted — investigate', remaining;
  ELSE
    RAISE NOTICE '[ROI-cleanup] ✓ 0 distorted rows remaining';
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- PHASE 2: Full wallet rescore (SQL port of wallet-classifier.ts v8)
-- ─────────────────────────────────────────────────────────────────────────────

WITH
-- ── Step 1: Aggregate raw transaction metrics (primary evidence path) ──────
raw_metrics AS (
  SELECT
    wallet_address,
    SUM(total_buy_txs)::INTEGER          AS total_buy_txs,
    SUM(total_sell_txs)::INTEGER         AS total_sell_txs,
    SUM(total_sol_invested)              AS total_sol_invested
  FROM wallet_raw_tx_metrics
  WHERE has_evidence = TRUE
  GROUP BY wallet_address
),

-- ── Step 2: Compute per-wallet stats from performance history ──────────────
perf_stats AS (
  SELECT
    wallet_address,

    -- Hard gate: at least 1 CLOSED with real investment AND real SOL received
    BOOL_OR(
      position_status   = 'CLOSED'
      AND initial_investment > 0.001
      AND total_sol_received > 0
    ) AS passes_hard_gate,

    -- Real exits used for win_rate and ROI (matches v8 filter exactly)
    COUNT(*) FILTER (
      WHERE position_status   = 'CLOSED'
        AND initial_investment > 0.001
        AND total_sol_received > 0
        AND roi_multiple       IS NOT NULL
    ) AS real_exits,

    COUNT(*) FILTER (
      WHERE position_status   = 'CLOSED'
        AND initial_investment > 0.001
        AND total_sol_received > 0
        AND roi_multiple       IS NOT NULL
        AND roi_multiple       >= 1.0
    ) AS winning_exits,

    -- Uncapped avg ROI (for classification gate)
    AVG(roi_multiple) FILTER (
      WHERE position_status   = 'CLOSED'
        AND initial_investment > 0.001
        AND total_sol_received > 0
        AND roi_multiple       IS NOT NULL
    ) AS avg_roi_raw,

    -- Capped avg ROI at 10× (for scoring — prevents outlier dominance)
    AVG(LEAST(roi_multiple, 10.0)) FILTER (
      WHERE position_status   = 'CLOSED'
        AND initial_investment > 0.001
        AND total_sol_received > 0
        AND roi_multiple       IS NOT NULL
    ) AS avg_roi_capped,

    -- Closed positions with real investment (for confidence_tier + closed_position_count)
    COUNT(*) FILTER (
      WHERE position_status   = 'CLOSED'
        AND initial_investment > 0.001
    ) AS closed_with_investment,

    -- Open position conviction signals
    COALESCE(SUM(current_position_value_sol) FILTER (
      WHERE position_status   = 'OPEN'
        AND initial_investment > 0.001
    ), 0) AS open_value_sol,

    COALESCE(SUM(initial_investment) FILTER (
      WHERE position_status   = 'OPEN'
        AND initial_investment > 0.001
    ), 0) AS open_invested_sol

  FROM wallet_performance_history
  GROUP BY wallet_address
),

-- ── Step 3: Join paths, derive win_rate and conviction ─────────────────────
combined AS (
  SELECT
    COALESCE(rm.wallet_address, ps.wallet_address)  AS wallet_address,
    CASE WHEN rm.wallet_address IS NOT NULL THEN 'raw' ELSE 'fallback' END AS evidence_quality,

    COALESCE(rm.total_buy_txs, 0)       AS total_buy_txs,
    COALESCE(rm.total_sell_txs, 0)      AS total_sell_txs,
    COALESCE(rm.total_sol_invested, 0)  AS total_sol_invested,

    COALESCE(ps.passes_hard_gate, FALSE) AS passes_hard_gate,
    COALESCE(ps.real_exits, 0)           AS real_exits,
    COALESCE(ps.winning_exits, 0)        AS winning_exits,
    ps.avg_roi_raw,
    ps.avg_roi_capped,
    COALESCE(ps.closed_with_investment, 0) AS closed_with_investment,

    -- win_rate: requires ≥3 real exits (v8 requirement — fewer is not meaningful)
    CASE
      WHEN COALESCE(ps.real_exits, 0) >= 3
        THEN ps.winning_exits::NUMERIC / NULLIF(ps.real_exits, 0)
      ELSE NULL
    END AS win_rate,

    -- Conviction: ratio of current open value to invested capital (0–100 internal)
    CASE
      WHEN COALESCE(ps.open_invested_sol, 0) > 0.001
        THEN LEAST(100.0, (ps.open_value_sol / ps.open_invested_sol) * 50.0)
      ELSE NULL
    END AS conviction_score

  FROM raw_metrics rm
  FULL OUTER JOIN perf_stats ps ON rm.wallet_address = ps.wallet_address
  WHERE COALESCE(rm.wallet_address, ps.wallet_address) IS NOT NULL
),

-- ── Step 4: Sample confidence dampening ────────────────────────────────────
with_confidence AS (
  SELECT
    c.*,
    -- raw path: confidence threshold = 5 (MIN_BUYS_FOR_SCORE_CONFIDENCE)
    -- fallback: confidence threshold = 20 (MIN_BUYS_FOR_SCORE_CONFIDENCE_FALLBACK)
    LEAST(1.0, c.total_buy_txs::NUMERIC / (
      CASE WHEN c.evidence_quality = 'fallback' THEN 20.0 ELSE 5.0 END
    )) AS sample_confidence
  FROM combined c
),

-- ── Step 5: Classify each wallet (mirrors determineClassification v8) ──────
classified AS (
  SELECT
    wc.*,
    CASE
      -- Hard gate: no real closed exit → unknown
      WHEN NOT wc.passes_hard_gate                      THEN 'unknown'
      -- Whale: total SOL invested ≥ 20 (WHALE_SOL_THRESHOLD)
      WHEN wc.total_sol_invested >= 20.0                THEN 'whale'
      -- Bot: high sell/buy ratio with ≥10 buys
      -- (BOT_SELL_BUY_RATIO = 0.8, BOT_MIN_BUYS = 10)
      WHEN wc.total_buy_txs >= 10
           AND wc.total_sell_txs::NUMERIC
               / NULLIF(wc.total_buy_txs, 0) >= 0.8   THEN 'bot'
      -- Smart money: ≥60% win rate, ≥5 buys, ≥1 exit, strong ROI
      -- (SMART_MONEY_WIN_RATE=0.60, MIN_BUYS_FOR_PREMIUM_CLASS=5,
      --  SMART_MONEY_MIN_TOKENS=1, ROI_MULTI=1.5, ROI_SINGLE=5.0)
      WHEN wc.win_rate >= 0.60
           AND wc.total_buy_txs >= 5
           AND wc.real_exits >= 1
           AND (
             (wc.real_exits >= 2 AND wc.avg_roi_raw >= 1.5)
             OR
             (wc.real_exits  = 1 AND wc.avg_roi_raw >= 5.0)
           )                                            THEN 'smart_money'
      -- Retail: everything else that passed the hard gate
      WHEN wc.passes_hard_gate                          THEN 'retail'
      ELSE 'unknown'
    END AS wallet_classification
  FROM with_confidence wc
),

-- ── Step 6: Compute intelligence_score and confidence_tier ─────────────────
final_scores AS (
  SELECT
    cl.*,

    -- intelligence_score (0–1)
    -- Formula: (win_rate×30 + capped_roi×25 + conviction×10) × (100/65) / 100
    --          all components dampened by sample_confidence except conviction
    CASE
      WHEN NOT cl.passes_hard_gate THEN NULL
      ELSE LEAST(1.0, GREATEST(0.0, ROUND(CAST((
        COALESCE(cl.win_rate * 30.0 * cl.sample_confidence, 0.0)
        + COALESCE(
            LEAST(25.0,
              (LEAST(COALESCE(cl.avg_roi_capped, 0.0), 10.0) / 10.0)
              * 25.0 * cl.sample_confidence),
            0.0)
        + COALESCE(LEAST(10.0, cl.conviction_score / 10.0), 0.0)
      ) * (100.0 / 65.0) / 100.0 AS NUMERIC), 4))
    END AS intelligence_score,

    -- confidence_tier
    CASE
      WHEN NOT cl.passes_hard_gate        THEN 'unrated'
      WHEN cl.real_exits >= 10
           AND cl.evidence_quality = 'raw' THEN 'elite'
      WHEN cl.real_exits >= 3             THEN 'high'
      WHEN cl.real_exits >= 1             THEN 'medium'
      ELSE                                     'low'
    END AS confidence_tier

  FROM classified cl
)

-- ── Step 7: Write results to wallets table ──────────────────────────────────
UPDATE public.wallets w
SET
  wallet_classification  = fs.wallet_classification,
  intelligence_score     = fs.intelligence_score,
  win_rate               = fs.win_rate,
  average_roi            = fs.avg_roi_raw,
  total_buys             = fs.total_buy_txs,
  total_sells            = fs.total_sell_txs,
  closed_position_count  = fs.closed_with_investment,
  evidence_quality       = fs.evidence_quality,
  confidence_tier        = fs.confidence_tier,
  conviction_score       = fs.conviction_score,
  score_computed_at      = now(),
  updated_at             = now()
FROM final_scores fs
WHERE w.wallet_address = fs.wallet_address;

-- ── Step 8: Sync verified_positions ────────────────────────────────────────
SELECT public.refresh_verified_positions();

-- ── Verification queries (run manually after migration) ────────────────────
-- SELECT wallet_classification, COUNT(*) FROM wallets GROUP BY 1 ORDER BY 2 DESC;
-- SELECT confidence_tier, COUNT(*) FROM wallets GROUP BY 1 ORDER BY 2 DESC;
-- SELECT COUNT(*) FROM wallets WHERE intelligence_score IS NOT NULL;
-- SELECT wallet_address, intelligence_score, wallet_classification, win_rate, average_roi
--   FROM wallets ORDER BY intelligence_score DESC NULLS LAST LIMIT 20;
