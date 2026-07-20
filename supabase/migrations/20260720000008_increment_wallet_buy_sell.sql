-- =============================================================================
-- Migration: 20260720000008_increment_wallet_buy_sell.sql
--
-- PURPOSE (P0 #3 fix):
--   The wallet-collection-worker previously overwrote total_buys and
--   total_sells on every upsert with just the current job's counts. This
--   meant returning wallets lost their cumulative history. The rescore
--   eventually corrected the values from wallet_raw_tx_metrics, but there
--   was always a stale window where leaderboard scores were wrong.
--
--   This migration adds a single atomic RPC function that the collection
--   worker now calls instead of setting total_buys/total_sells directly.
--   The function uses ON CONFLICT ... DO UPDATE SET total_buys = wallets.total_buys + EXCLUDED.total_buys
--   so counts accumulate correctly across multiple scans.
--
-- USAGE (TypeScript):
--   await sb.rpc("increment_wallet_buy_sell_counts", { wallet_rows: [...] });
--
-- APPLY BEFORE: deploying the wallet-collection-worker.ts Phase 1 patch.
-- =============================================================================

CREATE OR REPLACE FUNCTION increment_wallet_buy_sell_counts(
  wallet_rows jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  row_data jsonb;
BEGIN
  FOR row_data IN SELECT jsonb_array_elements(wallet_rows)
  LOOP
    INSERT INTO wallets (
      wallet_address,
      total_buys,
      total_sells,
      first_seen_timestamp,
      last_seen_timestamp
    )
    VALUES (
      row_data->>'wallet_address',
      COALESCE((row_data->>'buys')::int, 0),
      COALESCE((row_data->>'sells')::int, 0),
      (row_data->>'first_seen')::timestamptz,
      (row_data->>'last_seen')::timestamptz
    )
    ON CONFLICT (wallet_address) DO UPDATE
    SET
      total_buys            = wallets.total_buys  + COALESCE((row_data->>'buys')::int, 0),
      total_sells           = wallets.total_sells + COALESCE((row_data->>'sells')::int, 0),
      first_seen_timestamp  = LEAST(wallets.first_seen_timestamp, EXCLUDED.first_seen_timestamp),
      last_seen_timestamp   = GREATEST(wallets.last_seen_timestamp, EXCLUDED.last_seen_timestamp),
      updated_at            = now()
    -- NOTE: wallet_classification is intentionally NOT touched here (P0 #1 fix).
    -- Any existing classification (whale, smart_money, sniper, etc.) is preserved.
    ;
  END LOOP;
END;
$$;

-- Grant execute to the service role used by the backend
GRANT EXECUTE ON FUNCTION increment_wallet_buy_sell_counts(jsonb) TO service_role;

COMMENT ON FUNCTION increment_wallet_buy_sell_counts(jsonb) IS
  'P0 #3 fix: atomically increments total_buys/total_sells for wallet records, '
  'accumulating counts across multiple collection scans instead of overwriting them. '
  'Also preserves wallet_classification (P0 #1 fix). '
  'Applied by migration 20260720000008.';
