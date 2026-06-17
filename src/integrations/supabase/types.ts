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
