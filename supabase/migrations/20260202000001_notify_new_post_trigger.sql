-- ============================================================================
-- Migration: Add Database Trigger for New Post Notifications
-- Date: 2026-02-02
-- Description: Creates a trigger that calls the notify-new-post Edge Function
--              when new posts are inserted. This ensures admin gets Telegram
--              notifications for new volunteer applications and other posts.
-- ============================================================================

-- Create the trigger function that calls the Edge Function via pg_net
CREATE OR REPLACE FUNCTION trigger_notify_new_post()
RETURNS TRIGGER AS $$
DECLARE
  supabase_url TEXT;
  service_role_key TEXT;
BEGIN
  -- Get configuration from app settings
  supabase_url := current_setting('app.supabase_url', true);
  service_role_key := current_setting('app.service_role_key', true);

  -- Skip if configuration is missing
  IF supabase_url IS NULL OR service_role_key IS NULL THEN
    RAISE WARNING 'notify_new_post: Missing app.supabase_url or app.service_role_key';
    RETURN NEW;
  END IF;

  -- Call the Edge Function asynchronously via pg_net (fire-and-forget)
  PERFORM net.http_post(
    url := supabase_url || '/functions/v1/notify-new-post',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_role_key
    ),
    body := jsonb_build_object(
      'record', jsonb_build_object(
        'id', NEW.id,
        'post_name', NEW.post_name,
        'post_type', NEW.post_type,
        'post_address', NEW.post_address,
        'post_description', NEW.post_description,
        'profile_id', NEW.profile_id
      )
    )
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Log error but don't block the INSERT
  RAISE WARNING 'notify_new_post error: %', SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop existing trigger if any
DROP TRIGGER IF EXISTS trigger_notify_new_post_on_insert ON posts;

-- Create trigger for new post insertions
CREATE TRIGGER trigger_notify_new_post_on_insert
  AFTER INSERT ON posts
  FOR EACH ROW
  EXECUTE FUNCTION trigger_notify_new_post();

-- Add comments
COMMENT ON FUNCTION trigger_notify_new_post() IS
  'Sends Telegram notification to admin when new posts are created (including volunteer applications)';

COMMENT ON TRIGGER trigger_notify_new_post_on_insert ON posts IS
  'Triggers admin notification via Edge Function when posts are inserted';
