
CREATE TABLE public.scan_history (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  token_address TEXT NOT NULL,
  token_name TEXT,
  token_symbol TEXT,
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  risk_score INTEGER NOT NULL,
  risk_level TEXT NOT NULL,
  honey_pot_status TEXT NOT NULL,
  mint_authority TEXT,
  freeze_authority TEXT,
  liquidity NUMERIC,
  lp_status TEXT,
  lp_lock_days INTEGER,
  market_cap NUMERIC,
  fdv NUMERIC,
  volume_24h NUMERIC,
  holder_count INTEGER,
  top_holder_pct NUMERIC,
  sniper_wallets INTEGER,
  sniper_pct NUMERIC,
  image_url TEXT,
  raw JSONB
);

CREATE INDEX scan_history_token_idx ON public.scan_history(token_address, scanned_at DESC);
CREATE INDEX scan_history_recent_idx ON public.scan_history(scanned_at DESC);

GRANT SELECT, INSERT ON public.scan_history TO anon;
GRANT SELECT, INSERT ON public.scan_history TO authenticated;
GRANT ALL ON public.scan_history TO service_role;

ALTER TABLE public.scan_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read scan history"
  ON public.scan_history FOR SELECT
  USING (true);

CREATE POLICY "Anyone can append scans"
  ON public.scan_history FOR INSERT
  WITH CHECK (true);
