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
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      ai_control: {
        Row: {
          ai_enabled: boolean
          session_id: string
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          ai_enabled?: boolean
          session_id: string
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          ai_enabled?: boolean
          session_id?: string
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      api_keys: {
        Row: {
          api_key: string
          created_at: string | null
          id: string
          is_active: boolean | null
          label: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          api_key?: string
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          label?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          api_key?: string
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          label?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      failed_automations: {
        Row: {
          created_at: string | null
          error_details: Json | null
          error_message: string
          id: string
          recipient: string | null
          resolved: boolean | null
          resolved_at: string | null
          session_id: string | null
          severity: string | null
          source: string | null
          user_id: string | null
          workflow_name: string | null
        }
        Insert: {
          created_at?: string | null
          error_details?: Json | null
          error_message: string
          id?: string
          recipient?: string | null
          resolved?: boolean | null
          resolved_at?: string | null
          session_id?: string | null
          severity?: string | null
          source?: string | null
          user_id?: string | null
          workflow_name?: string | null
        }
        Update: {
          created_at?: string | null
          error_details?: Json | null
          error_message?: string
          id?: string
          recipient?: string | null
          resolved?: boolean | null
          resolved_at?: string | null
          session_id?: string | null
          severity?: string | null
          source?: string | null
          user_id?: string | null
          workflow_name?: string | null
        }
        Relationships: []
      }
      handoff_requests: {
        Row: {
          agent_data: Json | null
          created_at: string
          id: string
          message: string | null
          notes: string | null
          priority: string
          reason: string
          recipient: string | null
          resolved_at: string | null
          resolved_by: string | null
          session_id: string | null
          status: string
        }
        Insert: {
          agent_data?: Json | null
          created_at?: string
          id?: string
          message?: string | null
          notes?: string | null
          priority?: string
          reason?: string
          recipient?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          session_id?: string | null
          status?: string
        }
        Update: {
          agent_data?: Json | null
          created_at?: string
          id?: string
          message?: string | null
          notes?: string | null
          priority?: string
          reason?: string
          recipient?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          session_id?: string | null
          status?: string
        }
        Relationships: []
      }
      orders: {
        Row: {
          amount_to_collect: number | null
          consignment_id: string | null
          created_at: string
          customer_address: string | null
          customer_name: string | null
          customer_phone: string | null
          id: string
          merchant_order_id: string | null
          notes: string | null
          order_data: Json | null
          order_receive_ratio: string | null
          paperfly: number | null
          pathao: number | null
          product_name: string
          quantity: number
          reason_for_cancel: string | null
          recipient_id: string | null
          redex: number | null
          session_id: string | null
          sku: string | null
          source: string | null
          status: string
          steadfast: number | null
          total_cancel: number | null
          total_delivered: number | null
          total_parcels: number | null
          total_price: number | null
          unit_price: number | null
          updated_at: string
        }
        Insert: {
          amount_to_collect?: number | null
          consignment_id?: string | null
          created_at?: string
          customer_address?: string | null
          customer_name?: string | null
          customer_phone?: string | null
          id?: string
          merchant_order_id?: string | null
          notes?: string | null
          order_data?: Json | null
          order_receive_ratio?: string | null
          paperfly?: number | null
          pathao?: number | null
          product_name: string
          quantity?: number
          reason_for_cancel?: string | null
          recipient_id?: string | null
          redex?: number | null
          session_id?: string | null
          sku?: string | null
          source?: string | null
          status?: string
          steadfast?: number | null
          total_cancel?: number | null
          total_delivered?: number | null
          total_parcels?: number | null
          total_price?: number | null
          unit_price?: number | null
          updated_at?: string
        }
        Update: {
          amount_to_collect?: number | null
          consignment_id?: string | null
          created_at?: string
          customer_address?: string | null
          customer_name?: string | null
          customer_phone?: string | null
          id?: string
          merchant_order_id?: string | null
          notes?: string | null
          order_data?: Json | null
          order_receive_ratio?: string | null
          paperfly?: number | null
          pathao?: number | null
          product_name?: string
          quantity?: number
          reason_for_cancel?: string | null
          recipient_id?: string | null
          redex?: number | null
          session_id?: string | null
          sku?: string | null
          source?: string | null
          status?: string
          steadfast?: number | null
          total_cancel?: number | null
          total_delivered?: number | null
          total_parcels?: number | null
          total_price?: number | null
          unit_price?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      platform_connections: {
        Row: {
          access_token: string
          created_at: string | null
          id: string
          is_active: boolean | null
          page_id: string | null
          phone_number_id: string | null
          platform: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          access_token: string
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          page_id?: string | null
          phone_number_id?: string | null
          platform: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          access_token?: string
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          page_id?: string | null
          phone_number_id?: string | null
          platform?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      recipient_names: {
        Row: {
          created_at: string
          id: string
          name: string
          recipient_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          recipient_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          recipient_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      app_owner: {
        Row: {
          user_id: string
          claimed_at: string
        }
        Insert: {
          user_id: string
          claimed_at?: string
        }
        Update: {
          user_id?: string
          claimed_at?: string
        }
        Relationships: []
      }
      team_invites: {
        Row: {
          id: string
          created_by: string
          email: string
          role: string
          permissions: string[]
          token: string
          status: string
          accepted_user_id: string | null
          created_at: string
        }
        Insert: {
          id?: string
          created_by: string
          email: string
          role?: string
          permissions?: string[]
          token?: string
          status?: string
          accepted_user_id?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          created_by?: string
          email?: string
          role?: string
          permissions?: string[]
          token?: string
          status?: string
          accepted_user_id?: string | null
          created_at?: string
        }
        Relationships: []
      }
      supabase_connections: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          service_role_key: string
          supabase_url: string
          table_name: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          service_role_key: string
          supabase_url: string
          table_name?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          service_role_key?: string
          supabase_url?: string
          table_name?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      get_invite_by_token: {
        Args: { p_token: string }
        Returns: Array<{
          id: string
          email: string
          role: string
          permissions: string[]
          token: string
          status: string
          accepted_user_id: string | null
        }>
      }
      claim_owner_if_unclaimed: {
        Args: Record<string, never>
        Returns: boolean
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
