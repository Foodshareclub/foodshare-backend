-- =============================================================================
-- Migration: Locale Redis Sync
-- Description: Syncs user locale changes to Redis via Edge Function trigger
-- Created: 2026-01-18
-- =============================================================================

-- This migration creates a database trigger that automatically syncs
-- locale preference changes to Redis for cross-device O(1) lookup.
--
-- When a user updates their preferred_locale in their profile:
-- 1. The trigger fires AFTER UPDATE
-- 2. pg_net makes an async HTTP POST to /functions/v1/locale/sync-to-redis
-- 3. The Edge Function updates the Redis cache: user:locale:{userId}
--
-- This enables:
-- - Instant locale sync across all user devices
-- - O(1) Redis lookup instead of database query on app launch
-- - 7-day TTL with automatic refresh on each update

-- =============================================================================
-- Function: Sync locale changes to Redis
-- =============================================================================

CREATE OR REPLACE FUNCTION public.sync_locale_to_redis()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  edge_function_url TEXT;
  service_role_key TEXT;
  http_request_id BIGINT;
BEGIN
  -- Only trigger if preferred_locale actually changed
  IF OLD.preferred_locale IS NOT DISTINCT FROM NEW.preferred_locale THEN
    RETURN NEW;
  END IF;

  -- Skip if new locale is NULL (user cleared preference)
  IF NEW.preferred_locale IS NULL THEN
    RETURN NEW;
  END IF;

  -- Get configuration from environment
  edge_function_url := current_setting('app.supabase_url', true) || '/functions/v1/locale/sync-to-redis';
  service_role_key := current_setting('app.service_role_key', true);

  -- If settings not configured, use vault (fallback)
  IF edge_function_url IS NULL OR service_role_key IS NULL THEN
    SELECT
      decrypted_secret INTO edge_function_url
    FROM vault.decrypted_secrets
    WHERE name = 'supabase_url';

    SELECT
      decrypted_secret INTO service_role_key
    FROM vault.decrypted_secrets
    WHERE name = 'supabase_service_role_key';

    IF edge_function_url IS NOT NULL THEN
      edge_function_url := edge_function_url || '/functions/v1/locale/sync-to-redis';
    END IF;
  END IF;

  -- Skip if configuration not available (graceful degradation)
  IF edge_function_url IS NULL OR service_role_key IS NULL THEN
    RAISE WARNING 'Locale Redis sync: Missing configuration, skipping';
    RETURN NEW;
  END IF;

  -- Make async HTTP request to Edge Function using pg_net
  SELECT net.http_post(
    url := edge_function_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_role_key
    ),
    body := jsonb_build_object(
      'userId', NEW.id::text,
      'locale', NEW.preferred_locale
    ),
    timeout_milliseconds := 5000
  ) INTO http_request_id;

  -- Log the request (for debugging)
  RAISE NOTICE 'Locale Redis sync: Request % sent for user % -> %',
    http_request_id, NEW.id, NEW.preferred_locale;

  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    -- Log error but don't fail the transaction
    RAISE WARNING 'Locale Redis sync failed: %', SQLERRM;
    RETURN NEW;
END;
$$;

-- Add comment for documentation
COMMENT ON FUNCTION public.sync_locale_to_redis() IS
  'Syncs user locale preference changes to Redis via Edge Function for O(1) cross-device lookup';

-- =============================================================================
-- Trigger: Fire on locale updates
-- =============================================================================

-- Drop trigger if exists (idempotent)
DROP TRIGGER IF EXISTS on_locale_update ON public.profiles;

-- Create trigger for locale updates
CREATE TRIGGER on_locale_update
  AFTER UPDATE OF preferred_locale ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_locale_to_redis();

-- Add comment for documentation
COMMENT ON TRIGGER on_locale_update ON public.profiles IS
  'Triggers Redis cache update when user changes their locale preference';

-- =============================================================================
-- Grant permissions
-- =============================================================================

-- Ensure the trigger function can be executed
GRANT EXECUTE ON FUNCTION public.sync_locale_to_redis() TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_locale_to_redis() TO service_role;
