-- Recompress Old Images Cron Job
-- Gradually optimizes images uploaded before new compression system

-- Schedule: Daily at 4am (low traffic time)
SELECT cron.schedule(
  'recompress-old-images',
  '0 4 * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'automation_project_url') || '/functions/v1/recompress-images-cron',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
