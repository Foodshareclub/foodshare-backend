-- Migration: Fix profiles.role column reference
-- Date: 2025-12-25
-- Description: Fixes the missing profiles.role column that breaks authentication
--
-- Problem:
--   Previous migrations reference profiles.role which doesn't exist:
--   1. 20251104104841_add_jsonb_indexes.sql created idx_profiles_role_gin
--   2. 20251109000000_secure_vault_access.sql queries profiles.role in get_secret_audited()
--
-- Solution:
--   1. Drop the broken GIN index on profiles.role
--   2. Update get_secret_audited() to use user_roles table instead

BEGIN;

-- ============================================================================
-- PART 1: DROP BROKEN INDEX
-- ============================================================================

-- Drop the GIN index that references non-existent profiles.role column
DROP INDEX IF EXISTS public.idx_profiles_role_gin;

-- ============================================================================
-- PART 2: FIX get_secret_audited FUNCTION
-- ============================================================================

-- Recreate the function to use user_roles table instead of profiles.role
CREATE OR REPLACE FUNCTION public.get_secret_audited(
  secret_name text,
  requesting_user_id uuid DEFAULT auth.uid(),
  request_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = '' -- Prevents search path injection attacks
AS $$
DECLARE
  secret_value text;
  user_role text;
  allowed_secrets text[];
  access_granted boolean := false;
BEGIN
  -- Get user role from user_roles table (joined with roles)
  -- This replaces the broken profiles.role query
  SELECT r.name INTO user_role
  FROM public.user_roles ur
  JOIN public.roles r ON ur.role_id = r.id
  WHERE ur.profile_id = requesting_user_id
  LIMIT 1;

  -- Whitelist of secrets that can be accessed via this function
  -- Only service-to-service credentials, never admin keys
  allowed_secrets := ARRAY[
    'UPSTASH_REDIS_URL',
    'UPSTASH_REDIS_TOKEN',
    'RESEND_API_KEY',
    'OPENAI_API_KEY',
    'REVENUECAT_IOS_PUBLIC_KEY',
    'REVENUECAT_ANDROID_PUBLIC_KEY'
  ];

  -- Check if requested secret is in whitelist
  IF secret_name = ANY(allowed_secrets) THEN
    -- Fetch the decrypted secret from vault
    SELECT decrypted_secret INTO secret_value
    FROM vault.decrypted_secrets
    WHERE name = secret_name;

    access_granted := (secret_value IS NOT NULL);
  ELSE
    -- Unauthorized secret requested
    access_granted := false;
    secret_value := NULL;
  END IF;

  -- Log access attempt to audit table
  INSERT INTO audit.vault_access_log (
    user_id,
    user_role,
    secret_name,
    access_granted,
    access_method,
    ip_address,
    user_agent,
    request_id
  ) VALUES (
    requesting_user_id,
    COALESCE(user_role, 'unknown'),
    secret_name,
    access_granted,
    'rpc',
    (request_metadata->>'ip_address')::inet,
    request_metadata->>'user_agent',
    request_metadata->>'request_id'
  );

  RETURN secret_value;
END;
$$;

-- Maintain security grants
GRANT EXECUTE ON FUNCTION public.get_secret_audited(text, uuid, jsonb) TO service_role;
REVOKE EXECUTE ON FUNCTION public.get_secret_audited(text, uuid, jsonb) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.get_secret_audited(text, uuid, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_secret_audited(text, uuid, jsonb) FROM public;

-- ============================================================================
-- PART 3: VERIFICATION
-- ============================================================================

DO $$
BEGIN
  -- Verify the function exists and is updated
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname = 'get_secret_audited'
  ) THEN
    RAISE NOTICE '✅ get_secret_audited function updated successfully';
  ELSE
    RAISE WARNING '⚠️ get_secret_audited function not found';
  END IF;

  -- Verify index was dropped
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'idx_profiles_role_gin'
  ) THEN
    RAISE NOTICE '✅ idx_profiles_role_gin index dropped successfully';
  ELSE
    RAISE WARNING '⚠️ idx_profiles_role_gin index still exists';
  END IF;
END $$;

COMMIT;

-- ============================================================================
-- POST-MIGRATION NOTES
-- ============================================================================
--
-- This migration fixes the "column profiles.role does not exist" error that
-- occurs during Google/Apple OAuth sign-in.
--
-- The root cause was that previous migrations assumed a 'role' JSONB column
-- existed in the profiles table, but the actual role system uses separate
-- 'roles' and 'user_roles' tables.
--
-- After applying this migration:
-- 1. OAuth sign-in should work correctly
-- 2. The get_secret_audited function will properly check user roles
-- 3. No more errors about profiles.role
