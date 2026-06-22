// =============================================================================
// Wallet Intelligence Infrastructure — shared TypeScript types
// =============================================================================

/** Classification labels for a wallet's trading behaviour. */
export type WalletClassification =
  | "smart_money"
  | "sniper"
  | "bot"
  | "whale"
  | "retail"
  | "unknown";

/** Trade direction. */
export type ActionType = "buy" | "sell";

// ---------------------------------------------------------------------------
// wallets
// ---------------------------------------------------------------------------

export interface WalletRow {
  id: string;
  wallet_address: string;
  first_seen_timestamp: string | null;
  last_seen_timestamp: string | null;
  total_tokens_traded: number;
  total_buys: number;
  total_sells: number;
  total_volume_bought_usd: number;
  total_volume_sold_usd: number;
  realized_pnl: number;
  unrealized_pnl: number;
  win_rate: number | null;
  average_roi: number | null;
  discovery_score: number | null;
  conviction_score: number | null;
  intelligence_score: number | null;
  wallet_classification: WalletClassification | null;
  created_at: string;
  updated_at: string;
}

export interface WalletInsert {
  wallet_address: string;
  first_seen_timestamp?: string | null;
  last_seen_timestamp?: string | null;
  total_tokens_traded?: number;
  total_buys?: number;
  total_sells?: number;
  total_volume_bought_usd?: number;
  total_volume_sold_usd?: number;
  realized_pnl?: number;
  unrealized_pnl?: number;
  win_rate?: number | null;
  average_roi?: number | null;
  discovery_score?: number | null;
  conviction_score?: number | null;
  intelligence_score?: number | null;
  wallet_classification?: WalletClassification | null;
}

export type WalletUpdate = Partial<WalletInsert>;

// ---------------------------------------------------------------------------
// wallet_token_activity
// ---------------------------------------------------------------------------

export interface WalletTokenActivityRow {
  id: string;
  wallet_address: string;
  token_address: string;
  transaction_signature: string;
  action_type: ActionType;
  amount_sol: number | null;
  amount_usd: number | null;
  token_amount: number | null;
  timestamp: string;
  entry_market_cap: number | null;
  liquidity_at_entry: number | null;
  holder_count_at_entry: number | null;
  token_age_at_entry: number | null;
}

export interface WalletTokenActivityInsert {
  wallet_address: string;
  token_address: string;
  transaction_signature: string;
  action_type: ActionType;
  amount_sol?: number | null;
  amount_usd?: number | null;
  token_amount?: number | null;
  timestamp: string;
  entry_market_cap?: number | null;
  liquidity_at_entry?: number | null;
  holder_count_at_entry?: number | null;
  token_age_at_entry?: number | null;
}

// ---------------------------------------------------------------------------
// wallet_performance_history
// ---------------------------------------------------------------------------

export interface WalletPerformanceRow {
  id: string;
  wallet_address: string;
  token_address: string;
  initial_investment: number;
  current_value: number;
  realized_profit: number;
  unrealized_profit: number;
  roi_multiple: number | null;
  peak_roi: number | null;
  reached_100k_mc: boolean;
  reached_500k_mc: boolean;
  reached_1m_mc: boolean;
  reached_5m_mc: boolean;
  reached_10m_mc: boolean;
  reached_50m_mc: boolean;
  last_updated: string;
}

export interface WalletPerformanceUpsert {
  wallet_address: string;
  token_address: string;
  initial_investment?: number;
  current_value?: number;
  realized_profit?: number;
  unrealized_profit?: number;
  roi_multiple?: number | null;
  peak_roi?: number | null;
  reached_100k_mc?: boolean;
  reached_500k_mc?: boolean;
  reached_1m_mc?: boolean;
  reached_5m_mc?: boolean;
  reached_10m_mc?: boolean;
  reached_50m_mc?: boolean;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Pagination params used by list endpoints. */
export interface PaginationParams {
  limit?: number;
  offset?: number;
}

/** Standard service-layer response wrapper. */
export interface ServiceResult<T> {
  data: T | null;
  error: string | null;
}
