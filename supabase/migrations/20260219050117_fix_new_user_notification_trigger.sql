-- Fix: All webhook trigger functions were calling non-existent standalone edge functions.
-- Correct endpoint pattern is: api-v1-notifications/trigger/<type>
--
-- Fixed functions:
--   notify_new_user            → api-v1-notifications/trigger/new-user
--   notify_new_post            → api-v1-notifications/trigger/new-post
--   trigger_notify_new_post    → api-v1-notifications/trigger/new-post
--   notify_forum_post_telegram → api-v1-notifications/trigger/forum-post
--   notify_new_report          → api-v1-notifications/trigger/new-report
--
-- Also creates missing trigger on profiles table for new user notifications.
--
-- Note: Uses vault + pg_net (Supabase-only). Wrapped for CI compatibility.

DO $$
BEGIN

  -- 1. notify_new_user
  EXECUTE $fn$
    CREATE OR REPLACE FUNCTION public.notify_new_user()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $body$
    DECLARE request_id bigint; anon_key text;
    BEGIN
      SELECT decrypted_secret INTO anon_key FROM vault.decrypted_secrets WHERE name = 'anon_key' LIMIT 1;
      IF anon_key IS NULL THEN anon_key := current_setting('app.settings.anon_key', true); END IF;
      SELECT INTO request_id net.http_post(
        url := 'http://kong:8000/functions/v1/api-v1-notifications/trigger/new-user',
        headers := json_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || anon_key)::jsonb,
        body := jsonb_build_object('record', jsonb_build_object(
          'id', NEW.id, 'nickname', NEW.nickname, 'first_name', NEW.first_name,
          'second_name', NEW.second_name, 'email', NEW.email,
          'avatar_url', NEW.avatar_url, 'created_time', NEW.created_time
        ))
      );
      RETURN NEW;
    END;
    $body$
  $fn$;

  DROP TRIGGER IF EXISTS on_new_user_notify ON public.profiles;
  CREATE TRIGGER on_new_user_notify
    AFTER INSERT ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.notify_new_user();

  -- 2. notify_new_post
  EXECUTE $fn$
    CREATE OR REPLACE FUNCTION public.notify_new_post()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $body$
    DECLARE request_id bigint; anon_key text;
    BEGIN
      IF NEW.is_active = true THEN
        SELECT decrypted_secret INTO anon_key FROM vault.decrypted_secrets WHERE name = 'anon_key' LIMIT 1;
        IF anon_key IS NULL THEN anon_key := current_setting('app.settings.anon_key', true); END IF;
        SELECT INTO request_id net.http_post(
          url := 'http://kong:8000/functions/v1/api-v1-notifications/trigger/new-post',
          headers := json_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || anon_key)::jsonb,
          body := jsonb_build_object('record', jsonb_build_object(
            'id', NEW.id, 'post_name', NEW.post_name, 'post_type', NEW.post_type,
            'post_address', NEW.post_address, 'post_description', NEW.post_description, 'profile_id', NEW.profile_id
          ))
        );
      END IF;
      RETURN NEW;
    END;
    $body$
  $fn$;

  -- 3. trigger_notify_new_post (duplicate on posts with exception handling)
  EXECUTE $fn$
    CREATE OR REPLACE FUNCTION public.trigger_notify_new_post()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $body$
    BEGIN
      PERFORM net.http_post(
        url := 'http://kong:8000/functions/v1/api-v1-notifications/trigger/new-post',
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := jsonb_build_object('record', jsonb_build_object(
          'id', NEW.id, 'post_name', NEW.post_name, 'post_type', NEW.post_type,
          'post_address', NEW.post_address, 'post_description', NEW.post_description, 'profile_id', NEW.profile_id
        ))
      );
      RETURN NEW;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'notify_new_post error: %', SQLERRM;
      RETURN NEW;
    END;
    $body$
  $fn$;

  -- 4. notify_forum_post_telegram
  EXECUTE $fn$
    CREATE OR REPLACE FUNCTION public.notify_forum_post_telegram()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $body$
    BEGIN
      IF NEW.forum_published = true THEN
        PERFORM net.http_post(
          url := 'http://kong:8000/functions/v1/api-v1-notifications/trigger/forum-post',
          body := jsonb_build_object('record', jsonb_build_object(
            'id', NEW.id, 'profile_id', NEW.profile_id, 'forum_post_name', NEW.forum_post_name,
            'forum_post_description', NEW.forum_post_description, 'slug', NEW.slug,
            'post_type', NEW.post_type, 'forum_published', NEW.forum_published,
            'forum_post_created_at', NEW.forum_post_created_at
          )),
          headers := jsonb_build_object('Content-Type', 'application/json')
        );
      END IF;
      RETURN NEW;
    END;
    $body$
  $fn$;

  -- 5. notify_new_report
  EXECUTE $fn$
    CREATE OR REPLACE FUNCTION public.notify_new_report()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $body$
    DECLARE request_id bigint; anon_key text;
    BEGIN
      SELECT decrypted_secret INTO anon_key FROM vault.decrypted_secrets WHERE name = 'anon_key' LIMIT 1;
      IF anon_key IS NULL THEN anon_key := current_setting('app.settings.anon_key', true); END IF;
      SELECT INTO request_id net.http_post(
        url := 'http://kong:8000/functions/v1/api-v1-notifications/trigger/new-report',
        headers := json_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || anon_key)::jsonb,
        body := jsonb_build_object(
          'record', row_to_json(NEW)::jsonb,
          'table', TG_TABLE_NAME,
          'type', TG_OP
        )
      );
      RETURN NEW;
    END;
    $body$
  $fn$;

EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Notification trigger migration skipped (missing extensions): %', SQLERRM;
END;
$$;
