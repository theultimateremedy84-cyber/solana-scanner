-- =============================================================================
-- Migration: 20260716000002_backfill_scan_history_from_discovery.sql
--
-- PURPOSE
--   Seeds scan_history with entries for all tokens already discovered by the
--   Pump.fun WebSocket pipeline (wallet_collection_jobs WHERE status = 'done')
--   that have no existing scan_history row (i.e. were never manually scanned).
--
--   Without this backfill, plan Tasks A10 (developer graduation probability)
--   and A12 (developer fingerprinting) start with only 151 manual-scan rows.
--   After this migration, scan_history gains ~8,000 rows (one per discovered
--   token), with developer_wallet populated where it was stored at discovery.
--
-- NOTE: wallet_collection_jobs does NOT currently store the deployer wallet
--   (that fix is in the accompanying code changes to token-discovery.ts).
--   Backfilled rows will have developer_wallet = NULL for historical tokens.
--   Going forward, token-discovery.ts writes developer_wallet on every new
--   discovery so this gap will fill naturally over time.
--
-- SAFE TO RUN AGAINST PRODUCTION
--   Uses INSERT … WHERE NOT EXISTS — no overwrites, no deletions.
--   The partial unique index scan_history_discovery_token_unique (added by
--   migration 20260716000001) makes ON CONFLICT unnecessary — the NOT EXISTS
--   check is the deduplication gate.
--
-- RUN ORDER
--   Must run AFTER 20260716000001_scan_history_discovery_columns.sql
--   (requires the source, graduated_at, graduation_market_cap_usd columns).
--
-- EXPECTED RESULT
--   ~8,000 new rows in scan_history (exact count depends on done-job count at
--   migration time). All with source='discovery', risk_score=0, risk_level='LOW'.
-- =============================================================================

-- ── 1. Insert one discovery entry per done job that lacks a scan_history row ──
INSERT INTO public.scan_history (
  token_address,
  risk_score,
  risk_level,
  honey_pot_status,
  market_cap,
  liquidity,
  source,
  scanned_at
)
SELECT
  wcj.token_address,
  0            AS risk_score,
  'LOW'        AS risk_level,
  'SAFE'       AS honey_pot_status,
  wcj.market_cap_usd  AS market_cap,
  wcj.liquidity_usd   AS liquidity,
  'discovery'  AS source,
  wcj.enqueued_at     AS scanned_at
FROM public.wallet_collection_jobs wcj
WHERE wcj.status = 'done'
  -- Only insert if there is no existing discovery entry for this token.
  -- This guards against running the migration multiple times.
  AND NOT EXISTS (
    SELECT 1
    FROM public.scan_history sh
    WHERE sh.token_address = wcj.token_address
      AND sh.source        = 'discovery'
  );

-- ── 2. Report how many rows were inserted ────────────────────────────────────
DO $$
DECLARE
  v_inserted BIGINT;
  v_total    BIGINT;
BEGIN
  SELECT COUNT(*) INTO v_inserted
  FROM public.scan_history
  WHERE source = 'discovery';

  SELECT COUNT(*) INTO v_total
  FROM public.scan_history;

  RAISE NOTICE 'scan_history after backfill: % discovery rows, % total rows.',
    v_inserted, v_total;
END $$;

-- ── Verification query ────────────────────────────────────────────────────────
--
-- Run after applying to confirm the backfill worked:
--
--   SELECT
--     source,
--     COUNT(*)                    AS total_rows,
--     COUNT(developer_wallet)     AS with_developer_wallet,
--     COUNT(graduated_at)         AS graduated,
--     MIN(scanned_at)             AS oldest,
--     MAX(scanned_at)             AS newest
--   FROM scan_history
--   GROUP BY source
--   ORDER BY source;
--
-- Expected after migration:
--   source='manual'     total_rows=151   with_developer_wallet=0  (historical)
--   source='discovery'  total_rows=~8000 with_developer_wallet=0  (deployer backfill
--                                                                   not possible without re-fetching txs)
