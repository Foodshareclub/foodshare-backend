-- ============================================================================
-- Cron Jobs for Self-Hosted Supabase
-- Adapted from cloud baseline: vault.decrypted_secrets → hardcoded internal URLs
-- Internal API: http://kong:8000 (Docker network)
-- ============================================================================

-- Anon key for self-hosted
\set anon_key '***REMOVED***'
-- Service role key for self-hosted
\set service_key '***REMOVED***'

-- ============================================================================
-- Translation backfill jobs
-- ============================================================================

SELECT cron.schedule('backfill-challenge-translations', '0 3 * * *', $$
  SELECT net.http_post(
    url := 'http://kong:8000/functions/v1/api-v1-localization/backfill-challenges',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer ***REMOVED***"}'::jsonb,
    body := '{"mode": "incremental", "limit": 100, "hoursBack": 168, "source": "cron"}'::jsonb,
    timeout_milliseconds := 60000
  ) AS request_id;
$$);

SELECT cron.schedule('backfill-forum-post-translations', '0 4 * * *', $$
  SELECT net.http_post(
    url := 'http://kong:8000/functions/v1/api-v1-localization/backfill-forum-posts',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer ***REMOVED***"}'::jsonb,
    body := '{"mode": "incremental", "limit": 100, "hoursBack": 48, "source": "cron"}'::jsonb,
    timeout_milliseconds := 60000
  ) AS request_id;
$$);

SELECT cron.schedule('backfill-post-translations', '0 * * * *', $$
  SELECT net.http_post(
    url := 'http://kong:8000/functions/v1/api-v1-localization/backfill-posts',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer ***REMOVED***"}'::jsonb,
    body := '{"mode": "incremental", "limit": 50, "hoursBack": 24, "source": "cron"}'::jsonb,
    timeout_milliseconds := 60000
  ) AS request_id;
$$);

SELECT cron.schedule('backfill-untranslated-challenges', '0 */6 * * *', $$
  SELECT net.http_post(
    url := 'http://kong:8000/functions/v1/api-v1-localization/backfill-challenges',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer ***REMOVED***"}'::jsonb,
    body := '{"mode": "full", "limit": 50, "onlyUntranslated": true, "source": "cron"}'::jsonb,
    timeout_milliseconds := 120000
  ) AS request_id;
$$);

SELECT cron.schedule('backfill-untranslated-forum-posts', '30 */6 * * *', $$
  SELECT net.http_post(
    url := 'http://kong:8000/functions/v1/api-v1-localization/backfill-forum-posts',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer ***REMOVED***"}'::jsonb,
    body := '{"mode": "full", "limit": 50, "onlyUntranslated": true, "source": "cron"}'::jsonb,
    timeout_milliseconds := 120000
  ) AS request_id;
$$);

SELECT cron.schedule('backfill-untranslated-posts', '30 */2 * * *', $$
  SELECT net.http_post(
    url := 'http://kong:8000/functions/v1/api-v1-localization/backfill-posts',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer ***REMOVED***"}'::jsonb,
    body := '{"mode": "full", "limit": 100, "onlyUntranslated": true, "source": "cron"}'::jsonb,
    timeout_milliseconds := 120000
  ) AS request_id;
$$);

-- ============================================================================
-- Cleanup jobs (direct SQL — no HTTP calls needed)
-- ============================================================================

SELECT cron.schedule('cleanup-feed-cells', '0 * * * *', 'SELECT cleanup_expired_feed_cells()');
SELECT cron.schedule('cleanup-image-metrics', '0 3 * * 0', 'SELECT cleanup_old_image_metrics();');
SELECT cron.schedule('cleanup-job-run-details', '0 2 * * *', $$DELETE FROM cron.job_run_details WHERE end_time < NOW() - INTERVAL '3 days'$$);
SELECT cron.schedule('cleanup-translation-job-history', '0 5 * * *', $$DELETE FROM translation_backfill_jobs WHERE started_at < NOW() - INTERVAL '7 days';$$);

-- ============================================================================
-- Image processing jobs
-- ============================================================================

SELECT cron.schedule('cleanup-orphan-images', '0 3 * * *', $$
  SELECT net.http_post(
    url := 'http://kong:8000/functions/v1/api-v1-images/cleanup',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer ***REMOVED***"}'::jsonb,
    body := '{"gracePeriodHours": 24, "batchSize": 100, "dryRun": false}'::jsonb
  );
$$);

SELECT cron.schedule('compress-large-images', '* * * * *', 'SELECT invoke_image_compression();');

SELECT cron.schedule('recompress-old-images', '0 4 * * *', $$
  SELECT net.http_post(
    url := 'http://kong:8000/functions/v1/api-v1-images/recompress',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer ***REMOVED***"}'::jsonb,
    body := '{}'::jsonb
  );
$$);

-- ============================================================================
-- Email system jobs
-- ============================================================================

SELECT cron.schedule('email-circuit-breaker-cleanup', '0 * * * *', $$
    UPDATE email_circuit_breaker_state
    SET
      state = 'closed',
      failures = 0,
      next_retry_time = NULL,
      updated_at = NOW()
    WHERE state = 'open'
      AND next_retry_time IS NOT NULL
      AND next_retry_time < NOW();

    INSERT INTO email_health_events (provider, event_type, severity, message)
    SELECT
      provider,
      'circuit_breaker_auto_reset' as event_type,
      'info' as severity,
      'Circuit breaker automatically reset after retry timeout' as message
    FROM email_circuit_breaker_state
    WHERE state = 'closed'
      AND updated_at > NOW() - INTERVAL '5 minutes';
$$);

SELECT cron.schedule('email-dlq-review-alert', '0 9 * * *', $$
  INSERT INTO email_health_events (event_type, severity, message, metadata)
  SELECT
    'dlq_review_needed' as event_type,
    'warning' as severity,
    'Dead letter queue has ' || COUNT(*) || ' unreviewed emails' as message,
    jsonb_build_object(
      'count', COUNT(*),
      'oldest_email', MIN(created_at),
      'providers_failed', jsonb_agg(DISTINCT failed_providers)
    ) as metadata
  FROM email_dead_letter_queue
  WHERE reviewed_at IS NULL
  HAVING COUNT(*) > 0;
$$);

SELECT cron.schedule('email-health-events-cleanup', '0 2 * * 0', $$
    DELETE FROM email_health_events
    WHERE created_at < NOW() - INTERVAL '30 days';

    DELETE FROM email_logs
    WHERE created_at < NOW() - INTERVAL '90 days';

    DELETE FROM email_provider_metrics
    WHERE date < CURRENT_DATE - INTERVAL '90 days';
$$);

SELECT cron.schedule('email-health-monitoring', '*/5 * * * *', 'SELECT snapshot_provider_health();');
SELECT cron.schedule('email-queue-processor', '* * * * *', 'SELECT public.trigger_email_queue_processing();');

SELECT cron.schedule('email-quota-daily-reset', '0 0 * * *', $$
  INSERT INTO email_provider_quota (provider, date, emails_sent, daily_limit, monthly_limit, organization_id)
  SELECT
    p.provider,
    CURRENT_DATE + INTERVAL '1 day' as date,
    0 as emails_sent,
    CASE p.provider
      WHEN 'resend' THEN 100
      WHEN 'brevo' THEN 300
      WHEN 'aws_ses' THEN 100
      ELSE 100
    END as daily_limit,
    CASE p.provider
      WHEN 'resend' THEN 3000
      WHEN 'brevo' THEN 9000
      WHEN 'aws_ses' THEN 62000
      ELSE 3000
    END as monthly_limit,
    '00000000-0000-0000-0000-000000000001'::uuid as organization_id
  FROM UNNEST(ARRAY['resend', 'brevo', 'aws_ses']) as p(provider)
  WHERE NOT EXISTS (
    SELECT 1 FROM email_provider_quota eq
    WHERE eq.provider = p.provider
      AND eq.date = CURRENT_DATE + INTERVAL '1 day'
      AND eq.organization_id = '00000000-0000-0000-0000-000000000001'::uuid
  );
$$);

SELECT cron.schedule('recalculate-email-provider-health', '*/15 * * * *', 'SELECT sync_email_provider_stats_internal()');
SELECT cron.schedule('reset-daily-email-quotas', '0 0 * * *', 'SELECT reset_daily_email_quotas()');
SELECT cron.schedule('sync-email-provider-stats-hourly', '0 * * * *', 'SELECT trigger_email_provider_sync()');

-- ============================================================================
-- Location & coordinate jobs
-- ============================================================================

SELECT cron.schedule('invoke_update_post_coordinates_every_minute', '* * * * *', 'SELECT invoke_update_post_coordinates()');
SELECT cron.schedule('process-location-updates', '* * * * *', 'SELECT process_location_update_queue();');
SELECT cron.schedule('update-locations-every-5-minutes', '*/5 * * * *', 'SELECT scheduled_update_locations();');

-- ============================================================================
-- Notification digest jobs
-- ============================================================================

SELECT cron.schedule('notification-digest-cleanup', '0 2 * * 0', 'SELECT cleanup_old_digest_queue(7);');
SELECT cron.schedule('notification-digest-daily', '0 9 * * *', $$SELECT trigger_digest_edge_function('daily');$$);
SELECT cron.schedule('notification-digest-hourly', '0 * * * *', $$SELECT trigger_digest_edge_function('hourly');$$);
SELECT cron.schedule('notification-digest-weekly', '0 9 * * 1', $$SELECT trigger_digest_edge_function('weekly');$$);

-- ============================================================================
-- Automation & translation queue
-- ============================================================================

SELECT cron.schedule('process-automation-queue', '*/5 * * * *', $$
  SELECT net.http_post(
    url := 'http://kong:8000/functions/v1/api-v1-admin/process-automation-queue',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer ***REMOVED***"}'::jsonb,
    body := jsonb_build_object('triggered_at', NOW(), 'source', 'cron'),
    timeout_milliseconds := 30000
  ) AS request_id;
$$);

SELECT cron.schedule('process-translation-queue', '* * * * *', $$
  SELECT net.http_post(
    url := 'http://kong:8000/functions/v1/api-v1-localization/process-queue',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer ***REMOVED***"}'::jsonb,
    body := '{"limit": 20}'::jsonb,
    timeout_milliseconds := 120000
  ) AS request_id;
$$);

-- ============================================================================
-- Stats & materialized view refreshes
-- ============================================================================

SELECT cron.schedule('refresh-user-stats-mv', '*/15 * * * *', 'SELECT refresh_user_stats_mv()');
SELECT cron.schedule('update-daily-stats', '5 0 * * *', 'SELECT update_daily_stats()');

-- ============================================================================
-- Subscription / billing jobs
-- ============================================================================

SELECT cron.schedule('subscription-cleanup-weekly', '0 1 * * 0', 'SELECT billing.cleanup_old_events(90);');
SELECT cron.schedule('subscription-dlq-process', '*/5 * * * *', 'SELECT billing.process_dlq();');
SELECT cron.schedule('subscription-metrics-daily', '0 0 * * *', 'SELECT billing.update_daily_metrics(CURRENT_DATE);');

-- ============================================================================
-- Health checks
-- ============================================================================

SELECT cron.schedule('upstash-health-check-hourly', '0 * * * *', 'SELECT invoke_upstash_health_check();');

-- ============================================================================
-- Skipped jobs (not applicable for self-hosted):
-- - domain-monitor-check: referenced cloud-only domain-monitor function
-- - job_update_post_coordinates: duplicate of invoke_update_post_coordinates_every_minute
-- - update-locations-every-minute: duplicate of update-locations-every-5-minutes (kept 5-min version)
-- ============================================================================
