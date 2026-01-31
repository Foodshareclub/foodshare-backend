-- ============================================================================
-- Update Notification Digest Cron Jobs to Call Edge Function
-- ============================================================================
-- Changes cron jobs from calling database function to calling the
-- send-digest-notifications Edge Function via HTTP for proper delivery
-- of push notifications and emails.
-- ============================================================================

-- Ensure pg_net extension is enabled for HTTP calls
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA net;

-- ============================================================================
-- Helper function to call the digest Edge Function
-- ============================================================================

CREATE OR REPLACE FUNCTION public.trigger_digest_edge_function(p_frequency text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url text;
  v_service_role_key text;
  v_request_id bigint;
BEGIN
  -- Get the Supabase URL and service role key from vault
  SELECT decrypted_secret INTO v_url
  FROM vault.decrypted_secrets
  WHERE name = 'supabase_url'
  LIMIT 1;

  SELECT decrypted_secret INTO v_service_role_key
  FROM vault.decrypted_secrets
  WHERE name = 'supabase_service_role_key'
  LIMIT 1;

  -- Fallback to hardcoded URL if vault secret not set
  IF v_url IS NULL OR v_url = '' THEN
    v_url := 'https://***REMOVED***';
  END IF;

  -- Make HTTP POST request to the Edge Function using pg_net
  SELECT net.http_post(
    url := v_url || '/functions/v1/send-digest-notifications',
    body := jsonb_build_object(
      'frequency', p_frequency,
      'limit', 100
    ),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || COALESCE(v_service_role_key, '')
    )
  ) INTO v_request_id;

  RETURN v_request_id;
END;
$$;

COMMENT ON FUNCTION public.trigger_digest_edge_function IS 'Triggers the send-digest-notifications Edge Function for a specific frequency';

-- ============================================================================
-- Update Cron Job 4: Process Hourly Notification Digests
-- ============================================================================

SELECT cron.unschedule('notification-digest-hourly')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'notification-digest-hourly');

SELECT cron.schedule(
  'notification-digest-hourly',
  '0 * * * *',
  $$SELECT trigger_digest_edge_function('hourly');$$
);

-- ============================================================================
-- Update Cron Job 5: Process Daily Notification Digests (9am UTC)
-- ============================================================================

SELECT cron.unschedule('notification-digest-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'notification-digest-daily');

SELECT cron.schedule(
  'notification-digest-daily',
  '0 9 * * *',
  $$SELECT trigger_digest_edge_function('daily');$$
);

-- ============================================================================
-- Update Cron Job 6: Process Weekly Notification Digests (Mondays 9am UTC)
-- ============================================================================

SELECT cron.unschedule('notification-digest-weekly')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'notification-digest-weekly');

SELECT cron.schedule(
  'notification-digest-weekly',
  '0 9 * * 1',
  $$SELECT trigger_digest_edge_function('weekly');$$
);

-- ============================================================================
-- Cron Job 7: Cleanup Old Digest Queue (Sundays 2am UTC)
-- ============================================================================
-- Removes processed entries older than 7 days to keep the queue clean

SELECT cron.unschedule('notification-digest-cleanup')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'notification-digest-cleanup');

SELECT cron.schedule(
  'notification-digest-cleanup',
  '0 2 * * 0',
  $$SELECT cleanup_old_digest_queue(7);$$
);

-- ============================================================================
-- Verify Setup
-- ============================================================================
-- Run: SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname LIKE 'notification-digest%';
-- Run: SELECT * FROM cron.job_run_details WHERE jobid IN (SELECT jobid FROM cron.job WHERE jobname LIKE 'notification-digest%') ORDER BY start_time DESC LIMIT 10;

