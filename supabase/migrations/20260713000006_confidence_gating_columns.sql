-- =============================================================================
-- Migration: 20260713000006_confidence_gating_columns
--
-- PURPOSE
--   Architecture review (2026-07-13): adds the minimal set of persisted
--   columns needed to gate leaderboard eligibility on confidence/evidence
--   quality, and to audit the upcoming production rescore, WITHOUT changing
--   any existing score values. Purely additive — no backfill of scores,
--   no formula change in this migration.
--
-- WHAT THIS MIGRATION DOES
--   1. confidence_tier      text   — coarse trust label ('elite'|'high'|
--                                    'medium'|'low'|'unrated'), computed and
--                                    persisted by classifyWallets() going
--                                    forward. NULL until a wallet is
--                                    (re)classified after this migration.
--   2. closed_position_count int   — number of CLOSED positions backing the
--                                    wallet's win_rate/average_roi, so the
--                                    leaderboard and future tooling don't
--                                    have to recompute it from raw tx data
--                                    on every read.
--   3. evidence_quality     text   — 'raw' if computed from real per-tx
--                                    evidence, 'fallback' if derived from
--                                    wallet_performance_history (validated
--                                    this session to sometimes disagree with
--                                    real evidence), 'none' if unclassified.
--   4. score_computed_at    timestamptz — when intelligence_score was last
--                                    (re)computed; lets us tell, after the
--                                    upcoming rescore, which rows were
--                                    actually touched vs. still stale.
--
--   last_trade_at was considered and deliberately NOT added: it would be
--   redundant with the existing last_seen_timestamp column, which is
--   already populated from position.lastTradeTs in wallet-enricher.ts.
--
-- SAFE TO RE-RUN: all four ADD COLUMN statements use IF NOT EXISTS.
-- NO EXISTING DATA IS MODIFIED. NO EXISTING COLUMN IS ALTERED OR DROPPED.
-- =============================================================================

ALTER TABLE public.wallets
  ADD COLUMN IF NOT EXISTS confidence_tier text,
  ADD COLUMN IF NOT EXISTS closed_position_count integer,
  ADD COLUMN IF NOT EXISTS evidence_quality text,
  ADD COLUMN IF NOT EXISTS score_computed_at timestamptz;

COMMENT ON COLUMN public.wallets.confidence_tier IS
  'Coarse trust label for the intelligence_score: elite|high|medium|low|unrated. '
  'Persisted by classifyWallets(); NULL = not yet (re)computed under this scheme.';

COMMENT ON COLUMN public.wallets.closed_position_count IS
  'Count of CLOSED positions backing win_rate/average_roi at score computation time.';

COMMENT ON COLUMN public.wallets.evidence_quality IS
  'raw = computed from real per-tx evidence; fallback = derived from '
  'wallet_performance_history; none = unclassified/no evidence.';

COMMENT ON COLUMN public.wallets.score_computed_at IS
  'Timestamp of the last intelligence_score computation for this wallet. '
  'Used to audit which rows were touched by a given rescore pass.';

-- Optional: index confidence_tier since the leaderboard will filter on it
-- once classifyWallets() starts populating it.
CREATE INDEX IF NOT EXISTS idx_wallets_confidence_tier
  ON public.wallets (confidence_tier)
  WHERE confidence_tier IS NOT NULL;
