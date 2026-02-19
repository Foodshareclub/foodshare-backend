-- Fix: notify_new_user() was calling non-existent edge function 'notify-new-user'
-- Correct endpoint is 'api-v1-notifications/trigger/new-user'
-- Also: the trigger on profiles table was never created
--
-- Note: Uses vault + pg_net which only exist on production Supabase.
-- Wrapped in DO block with exception handling for CI compatibility.

DO $$
BEGIN
  -- Recreate the function with the correct endpoint
  EXECUTE $fn$
    CREATE OR REPLACE FUNCTION public.notify_new_user()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    AS $body$
    DECLARE
      request_id bigint;
      anon_key text;
    BEGIN
      SELECT decrypted_secret INTO anon_key
      FROM vault.decrypted_secrets
      WHERE name = 'anon_key'
      LIMIT 1;

      IF anon_key IS NULL THEN
        anon_key := current_setting('app.settings.anon_key', true);
      END IF;

      SELECT INTO request_id net.http_post(
        url := 'http://kong:8000/functions/v1/api-v1-notifications/trigger/new-user',
        headers := json_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || anon_key
        )::jsonb,
        body := jsonb_build_object(
          'record', jsonb_build_object(
            'id', NEW.id,
            'nickname', NEW.nickname,
            'first_name', NEW.first_name,
            'second_name', NEW.second_name,
            'email', NEW.email,
            'avatar_url', NEW.avatar_url,
            'created_time', NEW.created_time
          )
        )
      );

      RETURN NEW;
    END;
    $body$
  $fn$;

  -- Create the trigger (drop first in case it exists from manual fix)
  DROP TRIGGER IF EXISTS on_new_user_notify ON public.profiles;
  CREATE TRIGGER on_new_user_notify
    AFTER INSERT ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.notify_new_user();

EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'notify_new_user migration skipped (missing extensions): %', SQLERRM;
END;
$$;
