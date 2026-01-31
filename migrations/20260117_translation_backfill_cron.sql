-- Translation Backfill Cron Jobs
-- Automatically translate new content via scheduled edge function calls
-- Uses incremental mode to only process recent content

-- =====================================================
-- Backfill Post Translations (Hourly)
-- High volume content - processes 50 posts created in last 24 hours
-- =====================================================
SELECT cron.schedule(
  'backfill-post-translations',
  '0 * * * *',  -- Every hour at minute 0
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'automation_project_url') || '/functions/v1/localization/backfill-posts',
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

-- =====================================================
-- Backfill Challenge Translations (Daily at 3 AM)
-- Low volume content - processes 100 challenges created in last 7 days
-- =====================================================
SELECT cron.schedule(
  'backfill-challenge-translations',
  '0 3 * * *',  -- Daily at 3:00 AM
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'automation_project_url') || '/functions/v1/localization/backfill-challenges',
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

-- =====================================================
-- Backfill Forum Post Translations (Daily at 4 AM)
-- Medium volume content - processes 100 forum posts created in last 48 hours
-- =====================================================
SELECT cron.schedule(
  'backfill-forum-post-translations',
  '0 4 * * *',  -- Daily at 4:00 AM
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'automation_project_url') || '/functions/v1/localization/backfill-forum-posts',
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

-- =====================================================
-- Verification queries (run manually after migration)
-- =====================================================
-- Check cron jobs are created:
-- SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE '%translation%';

-- Check recent runs:
-- SELECT jobname, status, return_message, start_time
-- FROM cron.job_run_details
-- WHERE jobname LIKE '%translation%'
-- ORDER BY start_time DESC LIMIT 10;

-- Check translation coverage:
-- SELECT content_type, target_locale, COUNT(*)
-- FROM dynamic_content_translations
-- GROUP BY content_type, target_locale
-- ORDER BY content_type, count DESC;
