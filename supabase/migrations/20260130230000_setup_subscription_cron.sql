-- =============================================================================
-- Subscription Cron Jobs (pg_cron)
-- =============================================================================
-- Direct database function calls - no external dependencies
-- Supabase pg_cron runs these reliably at the database level

-- =============================================================================
-- Cron Job 1: Process DLQ (Every 5 minutes)
-- =============================================================================
-- Retries failed subscription events with exponential backoff
-- Expires events that exceed max retries

SELECT cron.unschedule('subscription-dlq-process')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'subscription-dlq-process');

SELECT cron.schedule(
  'subscription-dlq-process',
  '*/5 * * * *',
  $$SELECT billing.process_dlq();$$
);

-- =============================================================================
-- Cron Job 2: Update Daily Metrics (Midnight UTC)
-- =============================================================================
-- Aggregates subscription counts, churn, reactivations, grace recoveries

SELECT cron.unschedule('subscription-metrics-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'subscription-metrics-daily');

SELECT cron.schedule(
  'subscription-metrics-daily',
  '0 0 * * *',
  $$SELECT billing.update_daily_metrics(CURRENT_DATE);$$
);

-- =============================================================================
-- Cron Job 3: Cleanup Old Events (Sundays 1am UTC)
-- =============================================================================
-- Removes processed events older than 90 days
-- Removes resolved DLQ entries older than 90 days

SELECT cron.unschedule('subscription-cleanup-weekly')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'subscription-cleanup-weekly');

SELECT cron.schedule(
  'subscription-cleanup-weekly',
  '0 1 * * 0',
  $$SELECT billing.cleanup_old_events(90);$$
);

-- =============================================================================
-- Verify Setup
-- =============================================================================
-- Run: SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname LIKE 'subscription%';
-- Run: SELECT * FROM cron.job_run_details WHERE jobid IN (SELECT jobid FROM cron.job WHERE jobname LIKE 'subscription%') ORDER BY start_time DESC LIMIT 10;
