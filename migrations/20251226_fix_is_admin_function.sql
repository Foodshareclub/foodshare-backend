-- ============================================================================
-- Migration: Fix is_admin() function to use user_roles table
-- Date: 2024-12-26
-- Description: Updates the is_admin() function to check user_roles table
--              instead of the deprecated profiles.role column.
--              This fixes the circular dependency where:
--              1. user_roles RLS uses is_admin()
--              2. is_admin() checked profiles.role (empty/deprecated)
--              3. Admin users couldn't read user_roles, breaking admin access
-- ============================================================================

-- Fix is_admin() to use user_roles table instead of deprecated profiles.role
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.roles r ON ur.role_id = r.id
    WHERE ur.profile_id = (SELECT auth.uid())
    AND r.name IN ('admin', 'superadmin')
  );
$$;

-- Update comment
COMMENT ON FUNCTION public.is_admin() IS 'Check if current user has admin or superadmin role via user_roles table';
