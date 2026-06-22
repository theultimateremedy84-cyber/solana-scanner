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
      scan_history: {
        Row: {
          fdv: number | null
          freeze_authority: string | null
          holder_count: number | null
          honey_pot_status: string
          id: string
          image_url: string | null
          /**
           * TRUE when PostLaunchWatcher detected a SetAuthority instruction
           * (MintTokens or FreezeAccount) on this mint after its initial launch.
           * Enforces globalRiskScore >= 90 (Critical Risk) in scan-core.
           * DB column: BOOLEAN NOT NULL DEFAULT FALSE
           */
          is_authority_transitioned: boolean
          /**
           * TRUE when PostLaunchWatcher detected an account-data-length
           * modification (SystemProgram Allocate / AllocateWithSeed, or a
           * realloc-syscall) on an account owned by this token's program.
           * Enforces globalRiskScore >= 95 (Critical Risk) in scan-core.
           * DB column: BOOLEAN NOT NULL DEFAULT FALSE
           */
          is_account_resized: boolean
          /**
           * Current update_authority of the token's Metaplex metadata account.
           * null = unavailable. "111…" = burned (immutable).
           * DB column: TEXT
           */
          metadata_update_authority: string | null
          /**
           * TRUE when the update_authority is live (not null, not SystemProgram).
           * Applies a +15 risk-score penalty in scan-core.
           * DB column: BOOLEAN NOT NULL DEFAULT TRUE
           */
          is_metadata_mutable: boolean
          /**
           * TRUE when PostLaunchWatcher detected a post-launch UpdateMetadataAccount
           * / UpdateV1 instruction on this mint. Triggers a Critical alert.
           * DB column: BOOLEAN NOT NULL DEFAULT FALSE
           */
          is_metadata_hijacked: boolean
          liquidity: number | null
          lp_lock_days: number | null
          lp_status: string | null
          market_cap: number | null
          mint_authority: string | null
          raw: Json | null
          risk_level: string
          risk_score: number
          scanned_at: string
          sniper_pct: number | null
          sniper_wallets: number | null
          token_address: string
          token_name: string | null
          token_symbol: string | null
          top_holder_pct: number | null
          volume_24h: number | null
        }
        Insert: {
          fdv?: number | null
          freeze_authority?: string | null
          holder_count?: number | null
          honey_pot_status: string
          id?: string
          image_url?: string | null
          is_authority_transitioned?: boolean
          is_account_resized?: boolean
          metadata_update_authority?: string | null
          is_metadata_mutable?: boolean
          is_metadata_hijacked?: boolean
          liquidity?: number | null
          lp_lock_days?: number | null
          lp_status?: string | null
          market_cap?: number | null
          mint_authority?: string | null
          raw?: Json | null
          risk_level: string
          risk_score: number
          scanned_at?: string
          sniper_pct?: number | null
          sniper_wallets?: number | null
          token_address: string
          token_name?: string | null
          token_symbol?: string | null
          top_holder_pct?: number | null
          volume_24h?: number | null
        }
        Update: {
          fdv?: number | null
          freeze_authority?: string | null
          holder_count?: number | null
          honey_pot_status?: string
          id?: string
          image_url?: string | null
          is_authority_transitioned?: boolean
          is_account_resized?: boolean
          metadata_update_authority?: string | null
          is_metadata_mutable?: boolean
          is_metadata_hijacked?: boolean
          liquidity?: number | null
          lp_lock_days?: number | null
          lp_status?: string | null
          market_cap?: number | null
          mint_authority?: string | null
          raw?: Json | null
          risk_level?: string
          risk_score?: number
          scanned_at?: string
          sniper_pct?: number | null
          sniper_wallets?: number | null
          token_address?: string
          token_name?: string | null
          token_symbol?: string | null
          top_holder_pct?: number | null
          volume_24h?: number | null
        }
        Relationships: []
      }
      // -----------------------------------------------------------------------
      // WALLET INTELLIGENCE TABLES — added separately, never modifying above
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
          discovery_score: number | null
          conviction_score: number | null
          intelligence_score: number | null
          wallet_classification: string | null
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
          conviction_score?: number | null
          intelligence_score?: number | null
          wallet_classification?: string | null
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
          conviction_score?: number | null
          intelligence_score?: number | null
          wallet_classification?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
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
          holder_count_at_entry: number | null
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
          reached_100k_mc: boolean
          reached_500k_mc: boolean
          reached_1m_mc: boolean
          reached_5m_mc: boolean
          reached_10m_mc: boolean
          reached_50m_mc: boolean
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
          reached_100k_mc?: boolean
          reached_500k_mc?: boolean
          reached_1m_mc?: boolean
          reached_5m_mc?: boolean
          reached_10m_mc?: boolean
          reached_50m_mc?: boolean
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
          reached_100k_mc?: boolean
          reached_500k_mc?: boolean
          reached_1m_mc?: boolean
          reached_5m_mc?: boolean
          reached_10m_mc?: boolean
          reached_50m_mc?: boolean
          last_updated?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
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
