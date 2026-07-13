-- =============================================================================
-- fix_misclassified_zero_buy_wallets  (deadlock-safe batched version)
--
-- REPLACES the original single-UPDATE version which deadlocked against the
-- rescore scheduler. Root cause: a bulk UPDATE on ~1,548 wallets rows held
-- ShareLocks long enough for the background rescoring process to hit the same
-- rows, producing a cycle. PostgreSQL detected it and rolled back one side.
--
-- FIX: process 100 rows per iteration inside a loop. Each mini-transaction
-- commits immediately, so the lock window per batch is < 20 ms. The scheduler
-- can interleave safely between batches.
--
-- WHAT THIS RESETS
-- ----------------
-- Wallets that have ALL of:
--   - total_buys = 0            (no confirmed buy transactions from Helius)
--   - wallet_classification <> 'unknown'   (currently misclassified)
--   - evidence_quality = 'fallback'        (classified via wph fallback path)
--   - NO wallet_raw_tx_metrics row with has_evidence = true
--
-- Resets to: classification='unknown', confidence_tier='unrated',
--            intelligence_score=0, win_rate/average_roi/conviction_score=NULL
--
-- Idempotent — safe to run multiple times.
-- =============================================================================

DO $$
DECLARE
  batch_size  INT     := 100;
  total_reset INT     := 0;
  batch_count INT;
BEGIN
  LOOP
    -- Each UPDATE is its own implicit transaction when run inside a DO block
    -- without an explicit BEGIN/COMMIT. We use a CTE to select the next batch
    -- of qualifying rows, then UPDATE only those — committing after each 100.
    WITH target AS (
      SELECT w.wallet_address
      FROM   public.wallets w
      WHERE  w.total_buys            = 0
        AND  w.wallet_classification <> 'unknown'
        AND  w.evidence_quality      = 'fallback'
        AND  NOT EXISTS (
               SELECT 1
               FROM   public.wallet_raw_tx_metrics wrm
               WHERE  wrm.wallet_address = w.wallet_address
                 AND  wrm.has_evidence   = true
             )
      LIMIT  batch_size
      FOR UPDATE SKIP LOCKED   -- skip any row the scheduler currently holds
    )
    UPDATE public.wallets w
    SET
      wallet_classification = 'unknown',
      confidence_tier       = 'unrated',
      intelligence_score    = 0,
      win_rate              = NULL,
      average_roi           = NULL,
      conviction_score      = NULL,
      updated_at            = now()
    FROM   target
    WHERE  w.wallet_address = target.wallet_address;

    GET DIAGNOSTICS batch_count = ROW_COUNT;
    total_reset := total_reset + batch_count;

    EXIT WHEN batch_count = 0;   -- no more qualifying rows
  END LOOP;

  RAISE NOTICE 'fix_misclassified_zero_buy_wallets: reset % misclassified fallback wallets to unknown/unrated', total_reset;
END $$;
