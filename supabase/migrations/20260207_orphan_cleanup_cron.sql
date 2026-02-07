-- Orphan Image Cleanup Cron Job
-- Runs daily to clean up unreferenced images

-- Schedule: Daily at 3am (low traffic time)
SELECT cron.schedule(
  'cleanup-orphan-images',
  '0 3 * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'automation_project_url') || '/functions/v1/api-v1-images/cleanup',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret')
    ),
    body := jsonb_build_object(
      'gracePeriodHours', 24,
      'batchSize', 100,
      'dryRun', false
    )
  );
  $$
);
