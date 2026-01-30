-- =============================================================================
-- Setup pg_cron for Subscription Tasks
-- =============================================================================
-- Supabase includes pg_cron extension for scheduled tasks
-- This is the most reliable way to run cron jobs in Supabase

-- Enable pg_cron extension (already enabled in most Supabase projects)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Grant usage to postgres user
GRANT USAGE ON SCHEMA cron TO postgres;

-- =============================================================================
-- Cron Job: Process DLQ and Metrics (Every 5 minutes)
-- =============================================================================

-- Remove existing job if it exists
SELECT cron.unschedule('subscription-cron-5min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'subscription-cron-5min');

-- Schedule the cron job to call our Edge Function
-- Note: pg_cron can call HTTP endpoints via pg_net extension
SELECT cron.schedule(
  'subscription-cron-5min',
  '*/5 * * * *',  -- Every 5 minutes
  $$
  SELECT net.http_post(
    url := 'https://***REMOVED***/functions/v1/subscription-cron',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Cron-Secret', current_setting('app.cron_secret', true)
    ),
    body := '{}'::jsonb
  );
  $$
);

-- =============================================================================
-- Alternative: Direct Database Functions (if pg_net not available)
-- =============================================================================

-- Process DLQ directly every 5 minutes
SELECT cron.unschedule('subscription-dlq-process')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'subscription-dlq-process');

SELECT cron.schedule(
  'subscription-dlq-process',
  '*/5 * * * *',
  $$SELECT billing.process_dlq();$$
);

-- Update metrics at midnight UTC
SELECT cron.unschedule('subscription-metrics-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'subscription-metrics-daily');

SELECT cron.schedule(
  'subscription-metrics-daily',
  '0 0 * * *',  -- Midnight UTC
  $$SELECT billing.update_daily_metrics(CURRENT_DATE);$$
);

-- Cleanup old events on Sundays at 1am UTC
SELECT cron.unschedule('subscription-cleanup-weekly')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'subscription-cleanup-weekly');

SELECT cron.schedule(
  'subscription-cleanup-weekly',
  '0 1 * * 0',  -- Sundays at 1am UTC
  $$SELECT billing.cleanup_old_events(90);$$
);

-- =============================================================================
-- Set the cron secret as an app setting
-- =============================================================================
-- Run this separately in Supabase SQL Editor:
-- ALTER DATABASE postgres SET app.cron_secret = 'your-cron-secret-here';

-- =============================================================================
-- View scheduled jobs
-- =============================================================================
-- SELECT * FROM cron.job;
-- SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 10;

COMMENT ON EXTENSION pg_cron IS 'Subscription system cron jobs for DLQ processing, metrics, and cleanup';
