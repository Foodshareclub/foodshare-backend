-- ============================================================================
-- Migration: Add public read policy for roles table
-- Date: 2024-12-27
-- Description: Allows authenticated users to read role definitions.
--              Required for the user_roles → roles join in checkAdminStatus().
--              Role names (admin, superadmin, user) are not sensitive data.
-- ============================================================================

-- Allow authenticated users to read roles (needed for join in admin check)
CREATE POLICY "Authenticated users can read roles"
ON public.roles
FOR SELECT
TO authenticated
USING (true);
