-- =============================================================================
-- Migration: 20260716000001_scan_history_discovery_columns.sql
--
-- PURPOSE
--   Adds three columns to scan_history that enable developer graduation-rate
--   tracking (plan Tasks A10 + A12) and auto-population from the token
--   discovery pipeline:
--
--     source TEXT NOT NULL DEFAULT 'manual'
--       'manual'    — user scanned a token through the scanner UI
--       'discovery' — token discovered by the Pump.fun WebSocket pipeline
--                     and auto-inserted by token-discovery.ts
--
--     graduated_at TIMESTAMPTZ (nullable)
--       Set by graduation-tracker.ts when DexScreener shows a Raydium/Meteora
--       pair for this token (i.e. it graduated from the Pump.fun bonding curve).
--
--     graduation_market_cap_usd NUMERIC (nullable)
--       Market cap recorded at graduation time from DexScreener.
--
-- INDEXES ADDED
--   scan_history_discovery_token_unique — partial unique index on token_address
--     WHERE source = 'discovery', preventing duplicate discovery entries while
--     allowing multiple manual-scan rows per token.
--
--   scan_history_graduation_idx — covers the graduation tracker's query:
--     WHERE source = 'discovery' AND graduated_at IS NULL
--     ORDER BY scanned_at ASC
--
-- SAFE TO RUN AGAINST PRODUCTION
--   All DDL uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS guards.
--   No DROP TABLE, no DELETE, no destructive statements.
--   Existing manual-scan rows get source = 'manual' via DEFAULT.
--
-- APPLY BEFORE deploying the accompanying code changes:
--   src/lib/api/token-discovery.ts  (writes source='discovery' on insert)
--   src/lib/api/graduation-tracker.ts (reads graduated_at, writes graduated_at)
--   src/server.ts (wires GraduationTracker scheduler)
-- =============================================================================

-- ── 1. Add source column ──────────────────────────────────────────────────────
ALTER TABLE public.scan_history
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';

COMMENT ON COLUMN public.scan_history.source IS
  '''manual'' = user-initiated scan via the scanner UI; '
  '''discovery'' = auto-inserted by the Pump.fun WebSocket pipeline '
  '(token-discovery.ts) when a new token passes the bonding-curve quality filter.';

-- ── 2. Add graduation tracking columns ───────────────────────────────────────
ALTER TABLE public.scan_history
  ADD COLUMN IF NOT EXISTS graduated_at TIMESTAMPTZ;

COMMENT ON COLUMN public.scan_history.graduated_at IS
  'Timestamp when graduation-tracker.ts confirmed this token graduated from '
  'the Pump.fun bonding curve to Raydium/Meteora (DexScreener shows a non-pumpfun pair). '
  'NULL = not yet graduated or not yet checked.';

ALTER TABLE public.scan_history
  ADD COLUMN IF NOT EXISTS graduation_market_cap_usd NUMERIC;

COMMENT ON COLUMN public.scan_history.graduation_market_cap_usd IS
  'Market cap in USD at graduation time (from DexScreener). '
  'Used to compute developer quality signals: high-graduation-mcap devs are '
  'stronger positive signals than devs whose tokens barely graduate.';

-- ── 3. Partial unique index: one discovery entry per token ────────────────────
-- Prevents duplicate auto-insertions from the discovery pipeline while
-- allowing multiple manual-scan rows per token (users can re-scan).
CREATE UNIQUE INDEX IF NOT EXISTS scan_history_discovery_token_unique
  ON public.scan_history (token_address)
  WHERE (source = 'discovery');

-- ── 4. Graduation tracker query index ─────────────────────────────────────────
-- Covers graduation-tracker.ts's main query:
--   WHERE source = 'discovery' AND graduated_at IS NULL ORDER BY scanned_at ASC
CREATE INDEX IF NOT EXISTS scan_history_graduation_idx
  ON public.scan_history (source, scanned_at ASC)
  WHERE (source = 'discovery' AND graduated_at IS NULL);

-- ── 5. Developer wallet lookup index ─────────────────────────────────────────
-- Covers the developer reputation query used by plan Task A10/A12:
--   WHERE developer_wallet = $1 AND source = 'discovery'
CREATE INDEX IF NOT EXISTS scan_history_developer_wallet_idx
  ON public.scan_history (developer_wallet, source)
  WHERE (developer_wallet IS NOT NULL);

-- ── Verification queries (run manually after applying) ────────────────────────
--
-- 1. Confirm new columns exist:
--    SELECT column_name, data_type, is_nullable, column_default
--    FROM information_schema.columns
--    WHERE table_name = 'scan_history'
--      AND column_name IN ('source', 'graduated_at', 'graduation_market_cap_usd')
--    ORDER BY ordinal_position;
--
-- 2. Confirm indexes:
--    SELECT indexname, indexdef
--    FROM pg_indexes
--    WHERE tablename = 'scan_history'
--      AND indexname IN (
--        'scan_history_discovery_token_unique',
--        'scan_history_graduation_idx',
--        'scan_history_developer_wallet_idx'
--      );
--
-- 3. Verify existing rows got the default:
--    SELECT source, COUNT(*) FROM scan_history GROUP BY source;
--    -- Expected: source='manual' COUNT=151 (all existing rows)
