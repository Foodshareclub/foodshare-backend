-- ============================================================================
-- Migration: Add self-read policy for user_roles table
-- Date: 2024-12-27
-- Description: Allows users to read their own role entries from user_roles.
--              This fixes the circular dependency where:
--              1. Client-side checkAdminStatus() queries user_roles
--              2. RLS policy required is_admin() which creates circular block
--              3. Users couldn't read their own roles to determine admin status
-- ============================================================================

-- Allow users to read their own role entries (needed for client-side admin check)
CREATE POLICY "Users can read own roles"
ON public.user_roles
FOR SELECT
USING (profile_id = auth.uid());
