-- Migration: Secure Vault Access with Audit Logging
-- Date: 2025-11-09
-- Author: Foodshare Security Team
-- Description:
--   Phase 1: Remove direct iOS access to Vault
--   Phase 2: Add comprehensive audit logging for all secret access
--   Phase 3: Implement rate limiting infrastructure
--   Phase 4: Create safe config endpoint for iOS
--
-- Security Improvements:
--   - Revokes authenticated user access to vault secrets
--   - Adds audit trail for compliance (HIPAA, GDPR, SOC2)
--   - Implements rate limiting to prevent abuse
--   - Creates service-specific access patterns
--
-- Breaking Changes:
--   - get_secret(text) function is replaced with get_secret_audited()
--   - iOS apps can no longer fetch secrets directly
--   - Edge Functions must use new audited functions

BEGIN;

-- ============================================================================
-- PART 1: CREATE AUDIT INFRASTRUCTURE
-- ============================================================================

-- Create audit schema for compliance and forensics
CREATE SCHEMA IF NOT EXISTS audit;

COMMENT ON SCHEMA audit IS
'Audit and compliance schema. Contains logs for security-sensitive operations.
Access restricted to service_role only.';

-- Audit log table for vault access tracking
CREATE TABLE IF NOT EXISTS audit.vault_access_log (
  id BIGSERIAL PRIMARY KEY,

  -- User identification
  user_id UUID NOT NULL,
  user_role TEXT,

  -- Access details
  secret_name TEXT NOT NULL,
  access_granted BOOLEAN NOT NULL,
  access_method TEXT NOT NULL, -- 'rpc', 'edge_function', 'service_role', 'direct'

  -- Request metadata for forensics
  ip_address INET,
  user_agent TEXT,
  request_id TEXT,

  -- Timestamp
  accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Foreign key to auth.users
  CONSTRAINT fk_vault_access_user FOREIGN KEY (user_id)
    REFERENCES auth.users(id) ON DELETE CASCADE
);

-- Performance indexes
CREATE INDEX idx_vault_access_log_user_id
  ON audit.vault_access_log(user_id);

CREATE INDEX idx_vault_access_log_secret_name
  ON audit.vault_access_log(secret_name);

CREATE INDEX idx_vault_access_log_accessed_at
  ON audit.vault_access_log(accessed_at DESC);

-- Security monitoring index (failed access attempts)
CREATE INDEX idx_vault_access_log_failed
  ON audit.vault_access_log(user_id, accessed_at)
  WHERE access_granted = false;

-- Enable Row Level Security
ALTER TABLE audit.vault_access_log ENABLE ROW LEVEL SECURITY;

-- Policy: Only service_role can access audit logs
-- Regular users and authenticated users cannot query audit logs
CREATE POLICY audit_logs_service_role_only ON audit.vault_access_log
  FOR ALL
  USING (false); -- Deny all access via RLS (service_role bypasses RLS)

-- Grant access to service_role only
GRANT ALL ON audit.vault_access_log TO service_role;
GRANT USAGE, SELECT ON SEQUENCE audit.vault_access_log_id_seq TO service_role;

-- Table comment
COMMENT ON TABLE audit.vault_access_log IS
'Audit log for all Supabase Vault secret access attempts.
Tracks user_id, secret_name, timestamp, IP address, and access result.
Used for security monitoring, compliance reporting, and incident investigation.

Access: service_role only
Retention: Indefinite (or per compliance policy)
PII: Contains user_id, IP address';

-- ============================================================================
-- PART 2: REMOVE INSECURE FUNCTIONS
-- ============================================================================

-- Drop old insecure get_secret function that allowed iOS access
DROP FUNCTION IF EXISTS public.get_secret(text);

-- Log the migration
DO $$
BEGIN
  RAISE NOTICE 'Dropped insecure get_secret(text) function - iOS can no longer access Vault directly';
END $$;

-- ============================================================================
-- PART 3: CREATE SECURE AUDITED FUNCTIONS
-- ============================================================================

-- Secure audited secret access function
-- ONLY accessible by service_role (Edge Functions)
-- NOT accessible by iOS app or authenticated users
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
  -- Get user role from profiles table
  -- Use fully qualified name to avoid search_path issues
  SELECT (role::jsonb->>'role')::text INTO user_role
  FROM public.profiles
  WHERE id = requesting_user_id;

  -- Whitelist of secrets that can be accessed via this function
  -- Only service-to-service credentials, never admin keys
  allowed_secrets := ARRAY[
    'UPSTASH_REDIS_URL',
    'UPSTASH_REDIS_TOKEN',
    'RESEND_API_KEY',
    'OPENAI_API_KEY',
    'REVENUECAT_IOS_PUBLIC_KEY',
    'REVENUECAT_ANDROID_PUBLIC_KEY'
    -- DO NOT ADD:
    -- - REVENUECAT_SECRET_API_KEY (admin only)
    -- - SUPABASE_SERVICE_ROLE_KEY (admin only)
    -- - Database passwords
    -- - Admin credentials
  ];

  -- Check if requested secret is in whitelist
  IF secret_name = ANY(allowed_secrets) THEN
    -- Fetch the decrypted secret from vault
    -- Must use fully qualified name
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
  -- Always log, even if access denied (for security monitoring)
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

  -- Return secret value or NULL if not found/unauthorized
  RETURN secret_value;
END;
$$;

-- CRITICAL SECURITY: Only grant execute to service_role
-- This ensures ONLY Edge Functions can call this function
-- iOS app, authenticated users, and anon users CANNOT call this
GRANT EXECUTE ON FUNCTION public.get_secret_audited(text, uuid, jsonb) TO service_role;

-- Explicitly revoke from all other roles
REVOKE EXECUTE ON FUNCTION public.get_secret_audited(text, uuid, jsonb) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.get_secret_audited(text, uuid, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_secret_audited(text, uuid, jsonb) FROM public;

-- Function comment
COMMENT ON FUNCTION public.get_secret_audited(text, uuid, jsonb) IS
'Securely fetch secrets from Supabase Vault with comprehensive audit logging.

SECURITY:
- ONLY accessible by service_role (Edge Functions)
- NOT accessible by iOS app, Android app, or web clients
- NOT accessible by authenticated users
- Implements whitelist of allowed secrets
- Logs all access attempts (success and failure)

USAGE (Edge Functions only):
  const secret = await supabase.rpc("get_secret_audited", {
    secret_name: "UPSTASH_REDIS_URL",
    requesting_user_id: user.id,
    request_metadata: {
      ip_address: req.headers.get("x-forwarded-for"),
      user_agent: req.headers.get("user-agent"),
      request_id: crypto.randomUUID()
    }
  });

AUDIT:
- All calls logged to audit.vault_access_log
- Includes user_id, secret_name, timestamp, IP, user agent
- Failed attempts logged for security monitoring

PARAMETERS:
- secret_name: Name of secret to retrieve (must be in whitelist)
- requesting_user_id: UUID of user making request (defaults to auth.uid())
- request_metadata: JSONB with ip_address, user_agent, request_id

RETURNS:
- Secret value (text) if authorized and found
- NULL if unauthorized or not found';

-- ============================================================================
-- PART 4: CREATE SAFE SERVICE CONFIG FUNCTION
-- ============================================================================

-- Function to return NON-SENSITIVE service configuration
-- Safe for iOS/Android apps to call
-- Does NOT expose secrets, only feature flags and limits
CREATE OR REPLACE FUNCTION public.get_service_config()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Return ONLY non-sensitive configuration
  -- This tells the app what features are available
  -- WITHOUT exposing credentials or secrets
  RETURN jsonb_build_object(
    'version', '1.0.0',
    'features', jsonb_build_object(
      'redis_caching_enabled', true,
      'email_notifications_enabled', true,
      'ai_features_enabled', false,
      'push_notifications_enabled', true,
      'real_time_enabled', true
    ),
    'cache', jsonb_build_object(
      'default_ttl_seconds', 3600,
      'max_ttl_seconds', 86400
    ),
    'uploads', jsonb_build_object(
      'max_file_size_mb', 10,
      'supported_image_formats', jsonb_build_array('jpg', 'jpeg', 'png', 'heic', 'webp'),
      'max_images_per_listing', 5
    ),
    'rate_limits', jsonb_build_object(
      'cache_requests_per_minute', 60,
      'email_requests_per_hour', 10,
      'api_requests_per_minute', 100,
      'search_requests_per_minute', 30
    ),
    'search', jsonb_build_object(
      'max_radius_km', 100,
      'default_radius_km', 10,
      'max_results', 100
    )
  );
END;
$$;

-- Grant to authenticated users (safe - no secrets exposed)
GRANT EXECUTE ON FUNCTION public.get_service_config() TO authenticated;

-- Comment
COMMENT ON FUNCTION public.get_service_config() IS
'Returns non-sensitive service configuration for mobile apps.

SECURITY:
- Safe to call from iOS/Android/Web
- Does NOT expose secrets or credentials
- Only returns feature flags and rate limits

USAGE (iOS):
  let config = try await supabase.rpc("get_service_config").execute()
  let cacheEnabled = config["features"]["redis_caching_enabled"]

RETURNS:
- JSONB with service configuration
- Feature flags
- Rate limits
- Upload limits
- Non-sensitive settings';

-- ============================================================================
-- PART 5: RATE LIMITING INFRASTRUCTURE
-- ============================================================================

-- Rate limiting check function
-- Used by Edge Functions to prevent abuse
CREATE OR REPLACE FUNCTION public.check_rate_limit(
  user_id uuid,
  operation text,
  max_requests integer,
  time_window_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = audit
AS $$
DECLARE
  request_count integer;
  is_within_limit boolean;
BEGIN
  -- Count recent requests for this user and operation
  SELECT COUNT(*) INTO request_count
  FROM audit.vault_access_log
  WHERE vault_access_log.user_id = check_rate_limit.user_id
    AND vault_access_log.secret_name = check_rate_limit.operation
    AND accessed_at > NOW() - (time_window_seconds || ' seconds')::interval;

  -- Check if under limit
  is_within_limit := request_count < max_requests;

  -- Return true if within limit, false if exceeded
  RETURN is_within_limit;
END;
$$;

-- Grant to service_role (Edge Functions)
GRANT EXECUTE ON FUNCTION public.check_rate_limit(uuid, text, integer, integer) TO service_role;

-- Comment
COMMENT ON FUNCTION public.check_rate_limit(uuid, text, integer, integer) IS
'Check if user has exceeded rate limit for a specific operation.

SECURITY:
- Used by Edge Functions to prevent abuse
- Queries audit log for recent requests
- Returns boolean (true = within limit, false = exceeded)

USAGE (Edge Functions):
  const withinLimit = await supabase.rpc("check_rate_limit", {
    user_id: user.id,
    operation: "cache_operation",
    max_requests: 60,
    time_window_seconds: 60
  });

  if (!withinLimit) {
    return new Response("Rate limit exceeded", { status: 429 });
  }

PARAMETERS:
- user_id: UUID of user
- operation: Operation name (e.g., "cache_operation", "geocode")
- max_requests: Maximum requests allowed
- time_window_seconds: Time window for rate limit

RETURNS:
- true if within limit
- false if exceeded';

-- ============================================================================
-- PART 6: HELPER VIEWS FOR MONITORING
-- ============================================================================

-- View: Recent failed access attempts (security monitoring)
CREATE OR REPLACE VIEW audit.failed_vault_access AS
SELECT
  user_id,
  secret_name,
  COUNT(*) as attempt_count,
  MAX(accessed_at) as last_attempt,
  ARRAY_AGG(DISTINCT ip_address) as ip_addresses
FROM audit.vault_access_log
WHERE access_granted = false
  AND accessed_at > NOW() - INTERVAL '24 hours'
GROUP BY user_id, secret_name
ORDER BY attempt_count DESC;

COMMENT ON VIEW audit.failed_vault_access IS
'Recent failed vault access attempts in last 24 hours.
Used for security monitoring and detecting potential attacks.';

-- View: Vault access statistics
CREATE OR REPLACE VIEW audit.vault_access_stats AS
SELECT
  secret_name,
  COUNT(*) as total_requests,
  COUNT(*) FILTER (WHERE access_granted = true) as successful_requests,
  COUNT(*) FILTER (WHERE access_granted = false) as failed_requests,
  COUNT(DISTINCT user_id) as unique_users,
  MIN(accessed_at) as first_access,
  MAX(accessed_at) as last_access
FROM audit.vault_access_log
WHERE accessed_at > NOW() - INTERVAL '30 days'
GROUP BY secret_name
ORDER BY total_requests DESC;

COMMENT ON VIEW audit.vault_access_stats IS
'Vault access statistics for last 30 days.
Shows request counts, success/failure rates, and unique users per secret.';

-- Grant views to service_role
GRANT SELECT ON audit.failed_vault_access TO service_role;
GRANT SELECT ON audit.vault_access_stats TO service_role;

-- ============================================================================
-- PART 7: MIGRATION VERIFICATION
-- ============================================================================

-- Verify audit infrastructure
DO $$
DECLARE
  audit_table_exists boolean;
  function_exists boolean;
  grants_correct boolean;
BEGIN
  -- Check audit table
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'audit' AND table_name = 'vault_access_log'
  ) INTO audit_table_exists;

  -- Check function
  SELECT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname = 'get_secret_audited'
  ) INTO function_exists;

  -- Check grants
  SELECT NOT EXISTS (
    SELECT 1 FROM information_schema.role_routine_grants
    WHERE routine_name = 'get_secret_audited'
      AND grantee IN ('authenticated', 'anon', 'public')
  ) INTO grants_correct;

  -- Report results
  IF audit_table_exists AND function_exists AND grants_correct THEN
    RAISE NOTICE '✅ Migration successful - Vault access is now secure';
    RAISE NOTICE '   - Audit table created: audit.vault_access_log';
    RAISE NOTICE '   - Secure function created: public.get_secret_audited()';
    RAISE NOTICE '   - iOS access revoked: authenticated users cannot access vault';
    RAISE NOTICE '   - Service role only: Only Edge Functions can fetch secrets';
  ELSE
    RAISE WARNING '⚠️  Migration verification failed:';
    IF NOT audit_table_exists THEN
      RAISE WARNING '   - Audit table missing';
    END IF;
    IF NOT function_exists THEN
      RAISE WARNING '   - Secure function missing';
    END IF;
    IF NOT grants_correct THEN
      RAISE WARNING '   - Incorrect grants (iOS may still have access)';
    END IF;
  END IF;
END $$;

COMMIT;

-- ============================================================================
-- POST-MIGRATION NOTES
-- ============================================================================

-- Next steps:
-- 1. Deploy Edge Functions that use get_secret_audited()
-- 2. Update iOS code to remove direct Vault access
-- 3. Test Edge Functions with audit logging
-- 4. Monitor audit.vault_access_log for anomalies
-- 5. Set up alerts for failed access attempts
-- 6. Review rate limits and adjust as needed

-- Monitoring queries:
--
-- -- Recent access attempts:
-- SELECT * FROM audit.vault_access_log ORDER BY accessed_at DESC LIMIT 100;
--
-- -- Failed attempts (potential attacks):
-- SELECT * FROM audit.failed_vault_access;
--
-- -- Usage statistics:
-- SELECT * FROM audit.vault_access_stats;
--
-- -- Specific user's access:
-- SELECT * FROM audit.vault_access_log WHERE user_id = 'uuid-here';
--
-- -- Suspicious activity (many failures):
-- SELECT user_id, COUNT(*) as failures
-- FROM audit.vault_access_log
-- WHERE access_granted = false
--   AND accessed_at > NOW() - INTERVAL '1 hour'
-- GROUP BY user_id
-- HAVING COUNT(*) > 10;
