-- =============================================================================
-- Migration: 20260705000001_sol_transfer_indexer.sql
--
-- PURPOSE
--   Adds a raw wallet-to-wallet SOL transfer graph. This is the missing data
--   source needed for:
--     - Chapter 8 (Discovery Clusters) — detecting wallets controlled by the
--       same entity via common funding sources / behavioral fingerprinting.
--     - Whale fund-distribution tracing — detecting a profitable wallet
--       distributing proceeds across 10-15 new wallets before a CEX hop.
--
--   Token trades were already tracked in wallet_token_activity. This table
--   captures the OTHER half: bare SOL transfers between wallets, which is
--   what a whale actually does when moving/laundering funds.
--
-- SAFE TO RUN AGAINST PRODUCTION
--   CREATE TABLE IF NOT EXISTS — no-op if the table already exists.
--   No DROP TABLE, no DELETE, no destructive DDL.
--
-- APPLY
--   Supabase Dashboard → SQL Editor: paste and click Run
--   CLI: supabase db push  (after supabase link)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.wallet_sol_transfers (
  id                    UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,

  transaction_signature TEXT        NOT NULL,
  from_wallet           TEXT        NOT NULL,
  to_wallet             TEXT        NOT NULL,

  amount_sol            NUMERIC     NOT NULL,
  amount_usd            NUMERIC,

  -- On-chain transaction time (Unix seconds → timestamptz).
  transferred_at        TIMESTAMPTZ NOT NULL,

  -- Which wallet's transaction history this row was discovered through.
  -- A single transfer can be discovered from either side; we record the
  -- wallet we were indexing when we found it for auditability.
  discovered_via_wallet TEXT        NOT NULL,

  -- "helius_enhanced_tx" today; leaves room for future sources.
  data_source           TEXT        NOT NULL DEFAULT 'helius_enhanced_tx',

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT wallet_sol_transfers_signature_pair_unique
    UNIQUE (transaction_signature, from_wallet, to_wallet)
);

COMMENT ON TABLE public.wallet_sol_transfers IS
  'Raw wallet-to-wallet native SOL transfer graph, excluding known DEX/program '
  'accounts. Populated by sol-transfer-indexer.ts. Used for common-funding-source '
  'detection (Chapter 8 / whale fund-distribution tracing). Does NOT capture '
  'CEX-routed transfers — those are invisible on-chain by design.';

COMMENT ON COLUMN public.wallet_sol_transfers.discovered_via_wallet IS
  'The wallet address whose transaction history produced this row. Useful for '
  'debugging indexing coverage — does not imply directionality.';

-- ── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_wallet_sol_transfers_from
  ON public.wallet_sol_transfers (from_wallet);

CREATE INDEX IF NOT EXISTS idx_wallet_sol_transfers_to
  ON public.wallet_sol_transfers (to_wallet);

CREATE INDEX IF NOT EXISTS idx_wallet_sol_transfers_transferred_at
  ON public.wallet_sol_transfers (transferred_at);

-- Speeds up "who funded these N wallets first" queries.
CREATE INDEX IF NOT EXISTS idx_wallet_sol_transfers_to_transferred_at
  ON public.wallet_sol_transfers (to_wallet, transferred_at);

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Matches the read-only-by-default posture used elsewhere in this schema:
-- service-role (server) can read/write, anon/authenticated can read only.

ALTER TABLE public.wallet_sol_transfers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wallet_sol_transfers_select_all" ON public.wallet_sol_transfers;
CREATE POLICY "wallet_sol_transfers_select_all"
  ON public.wallet_sol_transfers
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- No INSERT/UPDATE/DELETE policy for anon/authenticated — only the
-- service-role key (used server-side by sol-transfer-indexer.ts) can write,
-- since service-role bypasses RLS entirely.

-- =============================================================================
-- FUNDING CLUSTER VIEW
--
-- Groups wallets by "first funder" — the earliest wallet that sent them SOL.
-- Wallets sharing the same first funder within a tight time window are very
-- likely controlled by the same entity. This is Signal 1 from the whale
-- fund-distribution discussion: cheap, high-confidence, low false-positive
-- rate (unlike full behavioral fingerprinting).
-- =============================================================================

CREATE OR REPLACE VIEW public.wallet_first_funder AS
SELECT DISTINCT ON (to_wallet)
  to_wallet          AS wallet_address,
  from_wallet        AS first_funder,
  transferred_at     AS first_funded_at,
  amount_sol         AS first_funding_amount_sol
FROM public.wallet_sol_transfers
ORDER BY to_wallet, transferred_at ASC;

COMMENT ON VIEW public.wallet_first_funder IS
  'One row per wallet: the earliest SOL transfer it received and who sent it. '
  'Wallets sharing the same first_funder within a short time window of each '
  'other are candidates for a common-funding-source cluster.';
