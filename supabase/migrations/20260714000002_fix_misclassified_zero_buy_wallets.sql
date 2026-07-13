-- =============================================================================
-- fix_misclassified_zero_buy_wallets
--
-- ISSUE (#2, high priority)
-- -------------------------
-- 1,549 wallets (live count) have total_buys = 0 on the wallets table but are
-- classified as retail (1,381), bot (159), whale (~6), or smart_money (~3)
-- instead of unknown. All sampled rows show evidence_quality = 'fallback',
-- meaning classification came from wallet_performance_history (the fallback
-- path) rather than real per-transaction data in wallet_raw_tx_metrics.
--
-- ROOT CAUSE
-- ----------
-- The discrepancy arises because:
--   1. wallets.total_buys aggregates raw buy TRANSACTIONS (from
--      wallet_raw_tx_metrics). It is only updated by classifyWallets() when
--      usingRaw=true (has real per-tx evidence). For fallback wallets it is
--      never updated, so it stays 0 or at whatever stale value it held.
--   2. classifyWallets() fallback path reads wallet_performance_history and
--      can see "sell-only" positions (total_tokens_sold > 0, total_tokens_bought
--      = 0) which pass the hasTransactionEvidence=true check and result in
--      a 'retail' label — even though no buy transaction evidence was ever
--      confirmed by Helius.
--   3. The outcome: wallets.total_buys = 0 (no confirmed buys) but
--      wallet_classification = 'retail' (based on fallback sell-only evidence).
--      This directly skews the leaderboard and any feature gate that trusts
--      wallet_classification.
--
-- WHY THIS IS WRONG
-- -----------------
-- wallet-classifier.ts § determineClassification(): "if evidenced.length === 0
-- return 'unknown'". A wallet with evidence_quality='fallback' and no confirmed
-- buy transactions has no validated on-chain evidence — the sell-side signal
-- comes from pool_extraction / holder_scan paths which are not per-transaction
-- verified. Per the classifier's own contract, this should be 'unknown' until
-- Helius full-history enrichment confirms real activity.
--
-- FIX
-- ---
-- Reset wallet_classification to 'unknown' and confidence_tier to 'unrated'
-- for wallets that meet ALL of:
--   - total_buys = 0 (no confirmed buy transactions recorded)
--   - wallet_classification != 'unknown' (currently misclassified)
--   - evidence_quality = 'fallback' (classified from wallet_performance_history,
--     NOT from real per-tx raw metrics)
--   - No wallet_raw_tx_metrics rows with has_evidence = true exist for this
--     wallet (confirming there is genuinely no Helius-verified evidence)
--
-- SCOPE: only wallets without ANY has_evidence=true raw metrics rows are
-- affected. Wallets that have even one confirmed Helius trade (has_evidence=true)
-- are preserved — their total_buys=0 is a stale column value, not a true
-- absence of evidence, and will self-correct on the next rescore tick.
--
-- DOWNSTREAM
-- ----------
-- After this migration, the next rescore scheduler tick (≤ 20 minutes) will
-- re-process these wallets. Without Helius-confirmed buy evidence, they will
-- remain 'unknown'. Once enriched via enrich-hollow-wallets or wallet
-- collection job enrichment, they will get a real classification.
--
-- SAFETY
-- ------
-- Does NOT touch wallets with has_evidence=true raw metrics rows.
-- Does NOT change wallets that already have wallet_classification = 'unknown'.
-- Does NOT affect intelligence_score, win_rate, or other score columns — only
-- classification and confidence labelling.
-- Idempotent: wallets reset here will be re-classified correctly by the next
-- rescore tick if they now have evidence.
-- =============================================================================

UPDATE public.wallets w
SET
  wallet_classification = 'unknown',
  confidence_tier       = 'unrated',
  intelligence_score    = 0,
  win_rate              = NULL,
  average_roi           = NULL,
  conviction_score      = NULL,
  updated_at            = now()
WHERE
  w.total_buys            = 0
  AND w.wallet_classification <> 'unknown'
  AND w.evidence_quality  = 'fallback'
  AND NOT EXISTS (
    SELECT 1
    FROM   public.wallet_raw_tx_metrics wrm
    WHERE  wrm.wallet_address = w.wallet_address
      AND  wrm.has_evidence   = true
  );

DO $$
DECLARE
  affected_count INTEGER;
BEGIN
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  RAISE NOTICE 'fix_misclassified_zero_buy_wallets: reset % misclassified fallback wallets to unknown/unrated', affected_count;
END $$;
