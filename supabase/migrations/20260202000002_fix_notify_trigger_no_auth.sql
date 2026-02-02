-- ============================================================================
-- Migration: Fix notify_new_post trigger to not require auth
-- Date: 2026-02-02
-- Description: Simplifies the trigger to not require auth headers since
--              verify_jwt = false is set in config.toml for this function.
-- ============================================================================

-- Update the trigger function to use hardcoded URL and no auth
-- (matches the pattern used by send-digest-notifications trigger)
CREATE OR REPLACE FUNCTION trigger_notify_new_post()
RETURNS TRIGGER AS $$
BEGIN
  -- Call the Edge Function asynchronously via pg_net (fire-and-forget)
  -- No auth needed since verify_jwt = false in config.toml
  PERFORM net.http_post(
    url := 'https://***REMOVED***/functions/v1/notify-new-post',
    headers := jsonb_build_object(
      'Content-Type', 'application/json'
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
