/**
 * Auth API shared types
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";

export interface AuthContext {
  supabase: SupabaseClient;
  requestId: string;
  corsHeaders: Record<string, string>;
  clientIp: string | null;
}
