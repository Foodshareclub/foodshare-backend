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
-- Cron Job 4: Process Hourly Notification Digests (Every hour at :00)
-- =============================================================================
-- Sends batched notifications for users with hourly frequency preference

SELECT cron.unschedule('notification-digest-hourly')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'notification-digest-hourly');

SELECT cron.schedule(
  'notification-digest-hourly',
  '0 * * * *',
  $$SELECT process_notification_digest();$$
);

-- =============================================================================
-- Cron Job 5: Process Daily Notification Digests (9am UTC)
-- =============================================================================
-- Sends batched notifications for users with daily frequency preference

SELECT cron.unschedule('notification-digest-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'notification-digest-daily');

SELECT cron.schedule(
  'notification-digest-daily',
  '0 9 * * *',
  $$SELECT process_notification_digest();$$
);

-- =============================================================================
-- Cron Job 6: Process Weekly Notification Digests (Mondays 9am UTC)
-- =============================================================================
-- Sends batched notifications for users with weekly frequency preference

SELECT cron.unschedule('notification-digest-weekly')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'notification-digest-weekly');

SELECT cron.schedule(
  'notification-digest-weekly',
  '0 9 * * 1',
  $$SELECT process_notification_digest();$$
);

-- =============================================================================
-- Verify Setup
-- =============================================================================
-- Run: SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname LIKE 'subscription%' OR jobname LIKE 'notification%';
-- Run: SELECT * FROM cron.job_run_details WHERE jobid IN (SELECT jobid FROM cron.job WHERE jobname LIKE 'subscription%' OR jobname LIKE 'notification%') ORDER BY start_time DESC LIMIT 10;
