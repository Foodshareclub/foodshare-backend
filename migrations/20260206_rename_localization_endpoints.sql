-- =============================================================================
-- Migration: Rename localization endpoints to api-v1-localization
-- Description: Updates all DB triggers/crons that reference the old
--              /locale/ and /localization/ Edge Function paths to use
--              the unified /api-v1-localization/ endpoint.
-- Created: 2026-02-06
-- =============================================================================

-- =============================================================================
-- 1. Update sync_locale_to_redis() function
--    Old: /functions/v1/locale/sync-to-redis
--    New: /functions/v1/api-v1-localization/sync-to-redis
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
  edge_function_url := current_setting('app.supabase_url', true) || '/functions/v1/api-v1-localization/sync-to-redis';
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
      edge_function_url := edge_function_url || '/functions/v1/api-v1-localization/sync-to-redis';
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

  RAISE NOTICE 'Locale Redis sync: Request % sent for user % -> %',
    http_request_id, NEW.id, NEW.preferred_locale;

  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'Locale Redis sync failed: %', SQLERRM;
    RETURN NEW;
END;
$$;

-- =============================================================================
-- 2. Update trigger_post_translation() function
--    Old: /functions/v1/localization/translate-batch
--    New: /functions/v1/api-v1-localization/translate-batch
-- =============================================================================

CREATE OR REPLACE FUNCTION trigger_post_translation()
RETURNS TRIGGER AS $$
DECLARE
  v_post_name TEXT;
  v_post_description TEXT;
BEGIN
  IF NEW.is_active = TRUE THEN
    v_post_name := COALESCE(NEW.post_name, '');
    v_post_description := COALESCE(NEW.post_description, '');

    IF LENGTH(v_post_name) > 0 OR LENGTH(v_post_description) > 0 THEN
      PERFORM net.http_post(
        url := current_setting('app.supabase_url') || '/functions/v1/api-v1-localization/translate-batch',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || current_setting('app.service_role_key')
        ),
        body := jsonb_build_object(
          'content_type', 'post',
          'content_id', NEW.id::text,
          'fields', jsonb_build_array(
            jsonb_build_object('name', 'title', 'text', v_post_name),
            jsonb_build_object('name', 'description', 'text', v_post_description)
          )
        )
      );

      RAISE LOG 'Triggered translation for post %', NEW.id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- 3. Re-schedule cron jobs with updated URLs
--    Old: /functions/v1/localization/backfill-*
--    New: /functions/v1/api-v1-localization/backfill-*
-- =============================================================================

-- Drop old cron jobs
SELECT cron.unschedule('backfill-post-translations');
SELECT cron.unschedule('backfill-challenge-translations');
SELECT cron.unschedule('backfill-forum-post-translations');

-- Re-create with updated URLs
SELECT cron.schedule(
  'backfill-post-translations',
  '0 * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'automation_project_url') || '/functions/v1/api-v1-localization/backfill-posts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'automation_anon_key')
    ),
    body := jsonb_build_object(
      'mode', 'incremental',
      'limit', 50,
      'hoursBack', 24,
      'source', 'cron'
    ),
    timeout_milliseconds := 60000
  ) AS request_id;
  $$
);

SELECT cron.schedule(
  'backfill-challenge-translations',
  '0 3 * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'automation_project_url') || '/functions/v1/api-v1-localization/backfill-challenges',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'automation_anon_key')
    ),
    body := jsonb_build_object(
      'mode', 'incremental',
      'limit', 100,
      'hoursBack', 168,
      'source', 'cron'
    ),
    timeout_milliseconds := 60000
  ) AS request_id;
  $$
);

SELECT cron.schedule(
  'backfill-forum-post-translations',
  '0 4 * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'automation_project_url') || '/functions/v1/api-v1-localization/backfill-forum-posts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'automation_anon_key')
    ),
    body := jsonb_build_object(
      'mode', 'incremental',
      'limit', 100,
      'hoursBack', 48,
      'source', 'cron'
    ),
    timeout_milliseconds := 60000
  ) AS request_id;
  $$
);
