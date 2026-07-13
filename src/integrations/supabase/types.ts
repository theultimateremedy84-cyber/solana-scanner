export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      // -----------------------------------------------------------------------
      // scan_history — token risk scans + post-launch watcher flags
      // -----------------------------------------------------------------------
      scan_history: {
        Row: {
          id: string
          token_address: string
          token_name: string | null
          token_symbol: string | null
          scanned_at: string
          risk_score: number
          risk_level: string
          honey_pot_status: string
          mint_authority: string | null
          freeze_authority: string | null
          liquidity: number | null
          lp_status: string | null
          lp_lock_days: number | null
          market_cap: number | null
          fdv: number | null
          volume_24h: number | null
          holder_count: number | null
          top_holder_pct: number | null
          sniper_wallets: number | null
          sniper_pct: number | null
          image_url: string | null
          raw: Json | null
          // Developer / phase-10 columns
          developer_wallet: string | null
          developer_classification: string | null
          // Metadata authority (post-launch watcher)
          metadata_update_authority: string | null
          /** TRUE when the token's metadata update_authority is live (not burned). */
          is_metadata_mutable: boolean
          /** TRUE when PostLaunchWatcher detected a post-launch metadata update. */
          is_metadata_hijacked: boolean
          /** TRUE when PostLaunchWatcher detected a SetAuthority instruction after launch. */
          is_authority_transitioned: boolean
          /** TRUE when PostLaunchWatcher detected an account-data-length modification. */
          is_account_resized: boolean
          // CPI manipulation detector
          is_path_obfuscated: boolean
          cpi_depth: number
          is_cpi_manipulated: boolean
          cpi_risk_details: string | null
          // State hijacking detector
          is_state_hijacked: boolean
          state_hijack_details: string | null
          // Atomic exploit monitor
          is_atomic_exploit: boolean
          atomic_exploit_details: string | null
          // Rent-exempt monitor
          has_non_rent_exempt_accounts: boolean
        }
        Insert: {
          id?: string
          token_address: string
          token_name?: string | null
          token_symbol?: string | null
          scanned_at?: string
          risk_score: number
          risk_level: string
          honey_pot_status: string
          mint_authority?: string | null
          freeze_authority?: string | null
          liquidity?: number | null
          lp_status?: string | null
          lp_lock_days?: number | null
          market_cap?: number | null
          fdv?: number | null
          volume_24h?: number | null
          holder_count?: number | null
          top_holder_pct?: number | null
          sniper_wallets?: number | null
          sniper_pct?: number | null
          image_url?: string | null
          raw?: Json | null
          developer_wallet?: string | null
          developer_classification?: string | null
          metadata_update_authority?: string | null
          is_metadata_mutable?: boolean
          is_metadata_hijacked?: boolean
          is_authority_transitioned?: boolean
          is_account_resized?: boolean
          is_path_obfuscated?: boolean
          cpi_depth?: number
          is_cpi_manipulated?: boolean
          cpi_risk_details?: string | null
          is_state_hijacked?: boolean
          state_hijack_details?: string | null
          is_atomic_exploit?: boolean
          atomic_exploit_details?: string | null
          has_non_rent_exempt_accounts?: boolean
        }
        Update: {
          id?: string
          token_address?: string
          token_name?: string | null
          token_symbol?: string | null
          scanned_at?: string
          risk_score?: number
          risk_level?: string
          honey_pot_status?: string
          mint_authority?: string | null
          freeze_authority?: string | null
          liquidity?: number | null
          lp_status?: string | null
          lp_lock_days?: number | null
          market_cap?: number | null
          fdv?: number | null
          volume_24h?: number | null
          holder_count?: number | null
          top_holder_pct?: number | null
          sniper_wallets?: number | null
          sniper_pct?: number | null
          image_url?: string | null
          raw?: Json | null
          developer_wallet?: string | null
          developer_classification?: string | null
          metadata_update_authority?: string | null
          is_metadata_mutable?: boolean
          is_metadata_hijacked?: boolean
          is_authority_transitioned?: boolean
          is_account_resized?: boolean
          is_path_obfuscated?: boolean
          cpi_depth?: number
          is_cpi_manipulated?: boolean
          cpi_risk_details?: string | null
          is_state_hijacked?: boolean
          state_hijack_details?: string | null
          is_atomic_exploit?: boolean
          atomic_exploit_details?: string | null
          has_non_rent_exempt_accounts?: boolean
        }
        Relationships: []
      }
      // -----------------------------------------------------------------------
      // wallets — master wallet intelligence record (one row per wallet)
      // -----------------------------------------------------------------------
      wallets: {
        Row: {
          id: string
          wallet_address: string
          first_seen_timestamp: string | null
          last_seen_timestamp: string | null
          total_tokens_traded: number
          total_buys: number
          total_sells: number
          total_volume_bought_usd: number
          total_volume_sold_usd: number
          realized_pnl: number
          unrealized_pnl: number
          win_rate: number | null
          average_roi: number | null
          /** 0–100 early-entry quality score. */
          discovery_score: number | null
          /** Bayesian confidence in the discovery_score (0–1). */
          discovery_confidence: number | null
          /** 'elite' | 'strong' | 'developing' | 'unproven' | 'low_sample' */
          discovery_tier: string | null
          /** Count of tokens the wallet was an early buyer of. */
          total_discoveries: number | null
          /** Count of early-buy positions that reached the 5× MC milestone. */
          successful_discoveries: number | null
          /** Average entry market cap across all positions with MC data. */
          avg_entry_market_cap: number | null
          conviction_score: number | null
          intelligence_score: number | null
          /** 'retail' | 'whale' | 'smart_money' | 'bot' | 'sniper' | 'unknown' */
          wallet_classification: string | null
          /** 'elite' | 'high' | 'medium' | 'low' | 'unrated' — gated on evidence quality. */
          confidence_tier: string | null
          /** Count of CLOSED positions used to compute win_rate. */
          closed_position_count: number | null
          /** 'raw' (WRM helius data) | 'fallback' (wph-only). */
          evidence_quality: string | null
          score_computed_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          wallet_address: string
          first_seen_timestamp?: string | null
          last_seen_timestamp?: string | null
          total_tokens_traded?: number
          total_buys?: number
          total_sells?: number
          total_volume_bought_usd?: number
          total_volume_sold_usd?: number
          realized_pnl?: number
          unrealized_pnl?: number
          win_rate?: number | null
          average_roi?: number | null
          discovery_score?: number | null
          discovery_confidence?: number | null
          discovery_tier?: string | null
          total_discoveries?: number | null
          successful_discoveries?: number | null
          avg_entry_market_cap?: number | null
          conviction_score?: number | null
          intelligence_score?: number | null
          wallet_classification?: string | null
          confidence_tier?: string | null
          closed_position_count?: number | null
          evidence_quality?: string | null
          score_computed_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          wallet_address?: string
          first_seen_timestamp?: string | null
          last_seen_timestamp?: string | null
          total_tokens_traded?: number
          total_buys?: number
          total_sells?: number
          total_volume_bought_usd?: number
          total_volume_sold_usd?: number
          realized_pnl?: number
          unrealized_pnl?: number
          win_rate?: number | null
          average_roi?: number | null
          discovery_score?: number | null
          discovery_confidence?: number | null
          discovery_tier?: string | null
          total_discoveries?: number | null
          successful_discoveries?: number | null
          avg_entry_market_cap?: number | null
          conviction_score?: number | null
          intelligence_score?: number | null
          wallet_classification?: string | null
          confidence_tier?: string | null
          closed_position_count?: number | null
          evidence_quality?: string | null
          score_computed_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      // -----------------------------------------------------------------------
      // wallet_token_activity — individual buy/sell transactions per wallet
      // -----------------------------------------------------------------------
      wallet_token_activity: {
        Row: {
          id: string
          wallet_address: string
          token_address: string
          transaction_signature: string
          action_type: "buy" | "sell"
          amount_sol: number | null
          amount_usd: number | null
          token_amount: number | null
          timestamp: string
          entry_market_cap: number | null
          liquidity_at_entry: number | null
          /** Nearly always NULL — cannot be backfilled from Helius wallet history. */
          holder_count_at_entry: number | null
          /** Nearly always NULL — cannot be backfilled from Helius wallet history. */
          token_age_at_entry: number | null
        }
        Insert: {
          id?: string
          wallet_address: string
          token_address: string
          transaction_signature: string
          action_type: "buy" | "sell"
          amount_sol?: number | null
          amount_usd?: number | null
          token_amount?: number | null
          timestamp: string
          entry_market_cap?: number | null
          liquidity_at_entry?: number | null
          holder_count_at_entry?: number | null
          token_age_at_entry?: number | null
        }
        Update: {
          id?: string
          wallet_address?: string
          token_address?: string
          transaction_signature?: string
          action_type?: "buy" | "sell"
          amount_sol?: number | null
          amount_usd?: number | null
          token_amount?: number | null
          timestamp?: string
          entry_market_cap?: number | null
          liquidity_at_entry?: number | null
          holder_count_at_entry?: number | null
          token_age_at_entry?: number | null
        }
        Relationships: []
      }
      // -----------------------------------------------------------------------
      // wallet_performance_history — per-wallet per-token position summary
      // UNIQUE(wallet_address, token_address)
      // -----------------------------------------------------------------------
      wallet_performance_history: {
        Row: {
          id: string
          wallet_address: string
          token_address: string
          initial_investment: number
          current_value: number
          realized_profit: number
          unrealized_profit: number
          roi_multiple: number | null
          peak_roi: number | null
          /** 'OPEN' | 'CLOSED' | 'PARTIALLY_CLOSED' | 'UNKNOWN' */
          position_status: string
          /** Total SOL received from sells on this position. */
          total_sol_received: number
          total_tokens_bought: number
          total_tokens_sold: number
          current_token_balance: number
          current_position_value_sol: number | null
          current_token_price_sol: number | null
          current_token_price_usd: number | null
          current_market_cap_usd: number | null
          peak_position_value_sol: number | null
          reached_100k_mc: boolean
          reached_500k_mc: boolean
          reached_1m_mc: boolean
          reached_5m_mc: boolean
          reached_10m_mc: boolean
          reached_50m_mc: boolean
          reached_100k_mc_at: string | null
          reached_500k_mc_at: string | null
          reached_1m_mc_at: string | null
          reached_5m_mc_at: string | null
          reached_10m_mc_at: string | null
          reached_50m_mc_at: string | null
          /** TRUE when initial_investment=0 and the position was sold — indicates airdrop exit. */
          is_airdrop_exit: boolean
          last_updated: string
        }
        Insert: {
          id?: string
          wallet_address: string
          token_address: string
          initial_investment?: number
          current_value?: number
          realized_profit?: number
          unrealized_profit?: number
          roi_multiple?: number | null
          peak_roi?: number | null
          position_status?: string
          total_sol_received?: number
          total_tokens_bought?: number
          total_tokens_sold?: number
          current_token_balance?: number
          current_position_value_sol?: number | null
          current_token_price_sol?: number | null
          current_token_price_usd?: number | null
          current_market_cap_usd?: number | null
          peak_position_value_sol?: number | null
          reached_100k_mc?: boolean
          reached_500k_mc?: boolean
          reached_1m_mc?: boolean
          reached_5m_mc?: boolean
          reached_10m_mc?: boolean
          reached_50m_mc?: boolean
          reached_100k_mc_at?: string | null
          reached_500k_mc_at?: string | null
          reached_1m_mc_at?: string | null
          reached_5m_mc_at?: string | null
          reached_10m_mc_at?: string | null
          reached_50m_mc_at?: string | null
          is_airdrop_exit?: boolean
          last_updated?: string
        }
        Update: {
          id?: string
          wallet_address?: string
          token_address?: string
          initial_investment?: number
          current_value?: number
          realized_profit?: number
          unrealized_profit?: number
          roi_multiple?: number | null
          peak_roi?: number | null
          position_status?: string
          total_sol_received?: number
          total_tokens_bought?: number
          total_tokens_sold?: number
          current_token_balance?: number
          current_position_value_sol?: number | null
          current_token_price_sol?: number | null
          current_token_price_usd?: number | null
          current_market_cap_usd?: number | null
          peak_position_value_sol?: number | null
          reached_100k_mc?: boolean
          reached_500k_mc?: boolean
          reached_1m_mc?: boolean
          reached_5m_mc?: boolean
          reached_10m_mc?: boolean
          reached_50m_mc?: boolean
          reached_100k_mc_at?: string | null
          reached_500k_mc_at?: string | null
          reached_1m_mc_at?: string | null
          reached_5m_mc_at?: string | null
          reached_10m_mc_at?: string | null
          reached_50m_mc_at?: string | null
          is_airdrop_exit?: boolean
          last_updated?: string
        }
        Relationships: []
      }
      // -----------------------------------------------------------------------
      // wallet_raw_tx_metrics — helius full-history per-wallet-token tx summary
      // NOTE: NO id column — primary key is UNIQUE(wallet_address, token_address)
      // -----------------------------------------------------------------------
      wallet_raw_tx_metrics: {
        Row: {
          wallet_address: string
          token_address: string
          total_buy_txs: number
          total_sell_txs: number
          total_tokens_bought: number
          total_tokens_sold: number
          total_sol_invested: number
          total_sol_received: number
          current_token_balance: number
          /** 'holder_scan' | 'pool_extraction' | 'helius_full_history' */
          data_source: string
          total_signatures_scanned: number | null
          first_tx_at: string | null
          last_tx_at: string | null
          last_scanned_at: string
          /** FALSE when Helius returned no transactions for this pair (ghost enrichment). */
          has_evidence: boolean
        }
        Insert: {
          wallet_address: string
          token_address: string
          total_buy_txs?: number
          total_sell_txs?: number
          total_tokens_bought?: number
          total_tokens_sold?: number
          total_sol_invested?: number
          total_sol_received?: number
          current_token_balance?: number
          data_source: string
          total_signatures_scanned?: number | null
          first_tx_at?: string | null
          last_tx_at?: string | null
          last_scanned_at?: string
          has_evidence?: boolean
        }
        Update: {
          wallet_address?: string
          token_address?: string
          total_buy_txs?: number
          total_sell_txs?: number
          total_tokens_bought?: number
          total_tokens_sold?: number
          total_sol_invested?: number
          total_sol_received?: number
          current_token_balance?: number
          data_source?: string
          total_signatures_scanned?: number | null
          first_tx_at?: string | null
          last_tx_at?: string | null
          last_scanned_at?: string
          has_evidence?: boolean
        }
        Relationships: []
      }
      // -----------------------------------------------------------------------
      // wallet_collection_jobs — queue for helius wallet-history collection
      // -----------------------------------------------------------------------
      wallet_collection_jobs: {
        Row: {
          id: string
          token_address: string
          /** 'pending' | 'processing' | 'done' | 'failed' */
          status: string
          attempts: number
          traders_collected: number | null
          buyers_collected: number | null
          sellers_collected: number | null
          skipped_dust: number | null
          errors: number | null
          last_error: string | null
          market_cap_usd: number | null
          liquidity_usd: number | null
          holder_count: number | null
          enqueued_at: string
          started_at: string | null
          completed_at: string | null
        }
        Insert: {
          id?: string
          token_address: string
          status?: string
          attempts?: number
          traders_collected?: number | null
          buyers_collected?: number | null
          sellers_collected?: number | null
          skipped_dust?: number | null
          errors?: number | null
          last_error?: string | null
          market_cap_usd?: number | null
          liquidity_usd?: number | null
          holder_count?: number | null
          enqueued_at?: string
          started_at?: string | null
          completed_at?: string | null
        }
        Update: {
          id?: string
          token_address?: string
          status?: string
          attempts?: number
          traders_collected?: number | null
          buyers_collected?: number | null
          sellers_collected?: number | null
          skipped_dust?: number | null
          errors?: number | null
          last_error?: string | null
          market_cap_usd?: number | null
          liquidity_usd?: number | null
          holder_count?: number | null
          enqueued_at?: string
          started_at?: string | null
          completed_at?: string | null
        }
        Relationships: []
      }
      // -----------------------------------------------------------------------
      // token_price_history — DexScreener price snapshots per token
      // -----------------------------------------------------------------------
      token_price_history: {
        Row: {
          id: string
          token_address: string
          snapshotted_at: string
          /** 'dexscreener' */
          source: string | null
          /** 'manual' | 'refresh' | 'enrichment' */
          refresh_source: string | null
          /** e.g. 'price_refresh_worker' */
          trigger: string | null
          pair_address: string | null
          /** e.g. 'pumpswap' | 'raydium' */
          dex_id: string | null
          quote_token_symbol: string | null
          price_sol: number | null
          price_usd: number | null
          market_cap_usd: number | null
          liquidity_usd: number | null
          fdv_usd: number | null
          volume_24h_usd: number | null
        }
        Insert: {
          id?: string
          token_address: string
          snapshotted_at?: string
          source?: string | null
          refresh_source?: string | null
          trigger?: string | null
          pair_address?: string | null
          dex_id?: string | null
          quote_token_symbol?: string | null
          price_sol?: number | null
          price_usd?: number | null
          market_cap_usd?: number | null
          liquidity_usd?: number | null
          fdv_usd?: number | null
          volume_24h_usd?: number | null
        }
        Update: {
          id?: string
          token_address?: string
          snapshotted_at?: string
          source?: string | null
          refresh_source?: string | null
          trigger?: string | null
          pair_address?: string | null
          dex_id?: string | null
          quote_token_symbol?: string | null
          price_sol?: number | null
          price_usd?: number | null
          market_cap_usd?: number | null
          liquidity_usd?: number | null
          fdv_usd?: number | null
          volume_24h_usd?: number | null
        }
        Relationships: []
      }
      // -----------------------------------------------------------------------
      // helius_cu_log — Helius API compute-unit telemetry (internal, pruned daily)
      // NOTE: column is `logged_at` NOT `created_at`; `component` NOT `operation`
      // -----------------------------------------------------------------------
      helius_cu_log: {
        Row: {
          id: string
          logged_at: string
          label: string
          component: string
          cu_amount: number
          hourly_used: number
          hourly_budget: number
          daily_used: number
          daily_budget: number
        }
        Insert: {
          id?: string
          logged_at?: string
          label: string
          component: string
          cu_amount?: number
          hourly_used?: number
          hourly_budget?: number
          daily_used?: number
          daily_budget?: number
        }
        Update: {
          id?: string
          logged_at?: string
          label?: string
          component?: string
          cu_amount?: number
          hourly_used?: number
          hourly_budget?: number
          daily_used?: number
          daily_budget?: number
        }
        Relationships: []
      }
      // -----------------------------------------------------------------------
      // alerts — PostLaunchWatcher risk events
      // -----------------------------------------------------------------------
      alerts: {
        Row: {
          id: string
          created_at: string
          /** e.g. 'path_obfuscation_extreme' | 'account_resize' | 'metadata_hijack' | 'authority_transition' */
          alert_type: string
          /** 'warn' | 'critical' */
          severity: string
          mint_address: string | null
          account: string | null
          signature: string | null
          payload: Json | null
        }
        Insert: {
          id?: string
          created_at?: string
          alert_type: string
          severity: string
          mint_address?: string | null
          account?: string | null
          signature?: string | null
          payload?: Json | null
        }
        Update: {
          id?: string
          created_at?: string
          alert_type?: string
          severity?: string
          mint_address?: string | null
          account?: string | null
          signature?: string | null
          payload?: Json | null
        }
        Relationships: []
      }
      // -----------------------------------------------------------------------
      // wallet_sol_transfers — SOL transfer graph (for cluster/funder detection)
      // NOTE: amount_usd is currently always NULL (backfill pending)
      // -----------------------------------------------------------------------
      wallet_sol_transfers: {
        Row: {
          id: string
          transaction_signature: string
          from_wallet: string
          to_wallet: string
          amount_sol: number
          /** Currently always NULL — SOL/USD price not captured at write time. */
          amount_usd: number | null
          transferred_at: string
          discovered_via_wallet: string | null
          data_source: string | null
          created_at: string
        }
        Insert: {
          id?: string
          transaction_signature: string
          from_wallet: string
          to_wallet: string
          amount_sol: number
          amount_usd?: number | null
          transferred_at: string
          discovered_via_wallet?: string | null
          data_source?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          transaction_signature?: string
          from_wallet?: string
          to_wallet?: string
          amount_sol?: number
          amount_usd?: number | null
          transferred_at?: string
          discovered_via_wallet?: string | null
          data_source?: string | null
          created_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      find_hollow_pairs: {
        Args: { p_limit?: number }
        Returns: Array<{ wallet_address: string; token_address: string }>
      }
      refresh_wallet_token_counts: {
        Args: Record<PropertyKey, never>
        Returns: undefined
      }
      prune_helius_cu_log: {
        Args: { retention_days?: number }
        Returns: number
      }
      /** Returns the count of wallet_performance_history rows not yet enriched in wallet_raw_tx_metrics. */
      count_hollow_pairs: {
        Args: Record<PropertyKey, never>
        Returns: number
      }
      /** Aggregated Helius CU consumption over 1h / 24h / 7d windows. */
      get_helius_cu_totals: {
        Args: Record<PropertyKey, never>
        Returns: { cu_last_1h: number; cu_last_24h: number; cu_last_7d: number }
      }
      /** Top N components by CU consumed in the last 24h. */
      get_helius_cu_top_components: {
        Args: { p_limit?: number }
        Returns: Array<{ component: string; cu_last_24h: number }>
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
