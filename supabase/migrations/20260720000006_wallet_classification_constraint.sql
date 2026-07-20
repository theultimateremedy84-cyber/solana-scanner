-- =============================================================================
-- Migration: 20260720000006_wallet_classification_constraint.sql
--
-- PURPOSE
--   Adds a CHECK constraint to wallets.wallet_classification enforcing the
--   enum values the application actually writes. Without this constraint,
--   typos (e.g. 'SMART_MONEY' instead of 'smart_money'), empty strings, or
--   arbitrary values can be persisted without error, silently breaking
--   leaderboard filtering and wallet type display in the UI.
--
-- CURRENT STATE
--   wallets.wallet_classification is TEXT with no constraint.
--   Application writes: 'smart_money', 'sniper', 'bot', 'whale', 'retail',
--   'unknown'. NULL is allowed (un-classified wallets).
--
-- APPROACH
--   Uses NOT VALID to avoid scanning existing rows (which could fail the
--   migration if bad data already exists), then VALIDATE separately with
--   a graceful fallback NOTICE if historical data violates the constraint.
-- =============================================================================

DO $body$
BEGIN
  ALTER TABLE public.wallets
    DROP CONSTRAINT IF EXISTS wallets_classification_enum,
    ADD  CONSTRAINT wallets_classification_enum
      CHECK (
        wallet_classification IS NULL OR
        wallet_classification IN (
          'smart_money', 'sniper', 'bot', 'whale', 'retail', 'unknown'
        )
      ) NOT VALID;

  BEGIN
    ALTER TABLE public.wallets
      VALIDATE CONSTRAINT wallets_classification_enum;
    RAISE NOTICE 'wallets_classification_enum: all existing rows pass — constraint fully enforced.';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE
      'wallets_classification_enum: existing rows contain out-of-range values. '
      'Constraint is enforced for all NEW inserts/updates. '
      'Run: SELECT DISTINCT wallet_classification FROM wallets '
      'WHERE wallet_classification NOT IN (''smart_money'',''sniper'',''bot'',''whale'',''retail'',''unknown'') '
      'AND wallet_classification IS NOT NULL; '
      'to find bad rows, clean them, then: '
      'ALTER TABLE wallets VALIDATE CONSTRAINT wallets_classification_enum;';
  END;
END $body$;

COMMENT ON CONSTRAINT wallets_classification_enum ON public.wallets IS
  'Enforces the wallet_classification vocabulary used by wallet-classifier.ts. '
  'Valid values: smart_money, sniper, bot, whale, retail, unknown (or NULL for unclassified).';
