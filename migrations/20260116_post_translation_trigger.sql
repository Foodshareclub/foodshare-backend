-- Migration: Auto-translate posts on creation/update
-- Created: 2026-01-16
-- Purpose: Automatically trigger batch translation when posts are created or updated

-- =====================================================
-- Function: Trigger batch translation for new/updated posts
-- =====================================================
CREATE OR REPLACE FUNCTION trigger_post_translation()
RETURNS TRIGGER AS $$
DECLARE
  v_post_name TEXT;
  v_post_description TEXT;
BEGIN
  -- Only trigger for active posts with content
  IF NEW.is_active = TRUE THEN
    v_post_name := COALESCE(NEW.post_name, '');
    v_post_description := COALESCE(NEW.post_description, '');
    
    -- Only translate if we have content
    IF LENGTH(v_post_name) > 0 OR LENGTH(v_post_description) > 0 THEN
      -- Call edge function asynchronously via pg_net
      -- This is fire-and-forget - doesn't block the insert/update
      PERFORM net.http_post(
        url := current_setting('app.supabase_url') || '/functions/v1/localization/translate-batch',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || current_setting('app.service_role_key')
        ),
        body := jsonb_build_object(
          'content_type', 'post',
          'content_id', NEW.id::text,
          'fields', jsonb_build_array(
            jsonb_build_object('name', 'title', 'text', v_post_name),
            jsonb_build_object('name', 'description', 'text', v_post_description)
          )
        )
      );
      
      RAISE LOG 'Triggered translation for post %', NEW.id;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================================================
-- Trigger: Auto-translate on post insert
-- =====================================================
DROP TRIGGER IF EXISTS trigger_post_translation_on_insert ON posts;
CREATE TRIGGER trigger_post_translation_on_insert
  AFTER INSERT ON posts
  FOR EACH ROW
  EXECUTE FUNCTION trigger_post_translation();

-- =====================================================
-- Trigger: Auto-translate on post update (only if content changed)
-- =====================================================
DROP TRIGGER IF EXISTS trigger_post_translation_on_update ON posts;
CREATE TRIGGER trigger_post_translation_on_update
  AFTER UPDATE ON posts
  FOR EACH ROW
  WHEN (
    OLD.post_name IS DISTINCT FROM NEW.post_name OR
    OLD.post_description IS DISTINCT FROM NEW.post_description
  )
  EXECUTE FUNCTION trigger_post_translation();

-- =====================================================
-- Comments
-- =====================================================
COMMENT ON FUNCTION trigger_post_translation() IS 
  'Automatically triggers batch translation via edge function when posts are created or updated';

COMMENT ON TRIGGER trigger_post_translation_on_insert ON posts IS
  'Triggers batch translation for newly created posts';

COMMENT ON TRIGGER trigger_post_translation_on_update ON posts IS
  'Triggers batch translation when post content is updated';
