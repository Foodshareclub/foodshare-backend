-- ============================================================================
-- Email Provider Stats Sync Cron Job
-- Automatically syncs provider stats every hour via pg_cron + pg_net
-- ============================================================================

-- pg_cron and pg_net are pre-installed on Supabase, just ensure they're enabled
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    CREATE EXTENSION pg_cron;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    CREATE EXTENSION pg_net WITH SCHEMA extensions;
  END IF;
END $$;

-- ============================================================================
-- Required Vault Secret: INTERNAL_SERVICE_SECRET
--
-- This secret is used by pg_cron to authenticate with Edge Functions.
-- It must match the INTERNAL_SERVICE_SECRET environment variable set
-- in Supabase Edge Functions.
--
-- Setup (run in SQL Editor or via CLI):
-- 1. Generate a secret: openssl rand -hex 32
-- 2. Store in vault: INSERT INTO vault.secrets (name, secret) VALUES ('INTERNAL_SERVICE_SECRET', 'your-secret');
-- 3. Set Edge Function env var: supabase secrets set INTERNAL_SERVICE_SECRET=your-secret
-- ============================================================================

-- ============================================================================
-- Internal health recalculation function (runs every 15 minutes)
-- This recalculates health scores based on success rates
-- ============================================================================

CREATE OR REPLACE FUNCTION sync_email_provider_stats_internal()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_provider record;
  v_now timestamptz := now();
BEGIN
  -- Update health scores for all providers
  FOR v_provider IN
    SELECT provider FROM email_provider_health_metrics
  LOOP
    UPDATE email_provider_health_metrics
    SET
      last_updated = v_now,
      -- Recalculate health score based on recent success rate
      health_score = CASE
        WHEN total_requests = 0 THEN 100
        WHEN successful_requests::float / NULLIF(total_requests, 0) >= 0.95 THEN 100
        WHEN successful_requests::float / NULLIF(total_requests, 0) >= 0.90 THEN 90
        WHEN successful_requests::float / NULLIF(total_requests, 0) >= 0.80 THEN 80
        WHEN successful_requests::float / NULLIF(total_requests, 0) >= 0.70 THEN 70
        ELSE 50
      END
    WHERE provider = v_provider.provider;
  END LOOP;

  -- Reset daily quotas if it's a new day (past midnight UTC)
  UPDATE email_provider_health_metrics
  SET
    daily_quota_used = 0,
    last_updated = v_now
  WHERE DATE(last_updated) < DATE(v_now)
    AND daily_quota_used > 0;
END;
$$;

-- ============================================================================
-- Schedule the cron jobs
-- ============================================================================

-- Unschedule existing jobs if they exist (idempotent)
DO $$
BEGIN
  PERFORM cron.unschedule('sync-email-provider-stats-hourly');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  PERFORM cron.unschedule('recalculate-email-provider-health');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  PERFORM cron.unschedule('reset-daily-email-quotas');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- ============================================================================
-- Trigger function for hourly sync
-- Uses INTERNAL_SERVICE_SECRET from vault for authentication
-- ============================================================================

CREATE OR REPLACE FUNCTION trigger_email_provider_sync()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net, vault
AS $$
DECLARE
  v_internal_secret text;
  v_request_id bigint;
BEGIN
  -- Get internal service secret from vault
  SELECT decrypted_secret INTO v_internal_secret
  FROM vault.decrypted_secrets
  WHERE name = 'INTERNAL_SERVICE_SECRET';

  IF v_internal_secret IS NULL THEN
    RAISE WARNING 'INTERNAL_SERVICE_SECRET not found in vault';
    RETURN NULL;
  END IF;

  -- Call the Edge Function with internal secret
  SELECT net.http_post(
    url := 'https://***REMOVED***/functions/v1/api-v1-notifications/admin/providers/sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_internal_secret
    ),
    body := '{"source": "cron"}'::jsonb
  ) INTO v_request_id;

  RETURN v_request_id;
END;
$$;

GRANT EXECUTE ON FUNCTION trigger_email_provider_sync TO service_role;

-- Schedule hourly sync (calls Edge Function via trigger_email_provider_sync)
SELECT cron.schedule(
  'sync-email-provider-stats-hourly',
  '0 * * * *',  -- Every hour at minute 0
  $$SELECT trigger_email_provider_sync()$$
);

-- Schedule internal health recalculation every 15 minutes
SELECT cron.schedule(
  'recalculate-email-provider-health',
  '*/15 * * * *',  -- Every 15 minutes
  $$SELECT sync_email_provider_stats_internal()$$
);

-- Schedule daily quota reset at midnight UTC
SELECT cron.schedule(
  'reset-daily-email-quotas',
  '0 0 * * *',  -- Every day at midnight UTC
  $$SELECT reset_daily_email_quotas()$$
);

-- ============================================================================
-- Permissions
-- ============================================================================

GRANT EXECUTE ON FUNCTION sync_email_provider_stats_internal TO service_role;

-- ============================================================================
-- Comments
-- ============================================================================

COMMENT ON FUNCTION sync_email_provider_stats_internal IS
  'Internal function to recalculate health scores and reset daily quotas';
