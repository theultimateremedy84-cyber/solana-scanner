// ─── Supabase Client & Queries ───────────────────────────────────────────────
import { createClient } from "@supabase/supabase-js";
import { config } from "./config.ts";

export const supabase = createClient(config.supabaseUrl, config.supabaseKey, {
  auth: { persistSession: false },
});

export interface WalletActivity {
  id: string;
  wallet_address: string;
  token_address: string;
  transaction_signature: string;
  action_type: "buy" | "sell";
  amount_sol: number | null;
  amount_usd: number | null;
  token_amount: number | null;
  timestamp: string;
  entry_market_cap: number | null;
  liquidity_at_entry: number | null;
  token_age_at_entry: number | null;
}

// Fetch the top N wallets by average_roi with >= minTokensTraded projects.
// Returns their wallet addresses.
export async function fetchTopWallets(
  limit: number,
  minTokensTraded: number
): Promise<string[]> {
  const { data, error } = await supabase
    .from("wallets")
    .select("wallet_address, average_roi, win_rate, intelligence_score")
    .gt("total_tokens_traded", minTokensTraded)
    .not("average_roi", "is", null)
    .order("average_roi", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`fetchTopWallets: ${error.message}`);
  return (data ?? []).map((w) => w.wallet_address);
}

// Poll for new activity rows for the watched wallets since `since`.
// Filters to trades where amount_usd >= minTradeUsd OR amount_sol >= 0.5
// (USD amounts are sometimes unpopulated, so SOL is the fallback).
export async function fetchNewActivity(
  walletAddresses: string[],
  since: Date,
  minTradeUsd: number
): Promise<WalletActivity[]> {
  if (walletAddresses.length === 0) return [];

  const { data, error } = await supabase
    .from("wallet_token_activity")
    .select("*")
    .in("wallet_address", walletAddresses)
    .gte("timestamp", since.toISOString())
    .or(`amount_usd.gte.${minTradeUsd},amount_sol.gte.0.5`)
    .order("timestamp", { ascending: true });

  if (error) throw new Error(`fetchNewActivity: ${error.message}`);
  return (data ?? []) as WalletActivity[];
}
