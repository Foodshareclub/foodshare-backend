-- Upgrade notify_new_user trigger to pass comprehensive profile data
-- Run this in your Supabase SQL Editor after deploying the updated function

-- Drop and recreate the trigger function with enhanced data
CREATE OR REPLACE FUNCTION notify_new_user()
RETURNS TRIGGER AS $$
DECLARE
  request_id bigint;
BEGIN
  -- Call the edge function with comprehensive profile data
  SELECT INTO request_id net.http_post(
    url := 'https://***REMOVED***/functions/v1/notify-new-user',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer ***REMOVED***"}'::jsonb,
    body := jsonb_build_object(
      'record', jsonb_build_object(
        -- Identity
        'id', NEW.id,
        'nickname', NEW.nickname,
        'first_name', NEW.first_name,
        'second_name', NEW.second_name,
        
        -- Contact
        'email', NEW.email,
        'phone', NEW.phone,
        
        -- Profile info
        'about_me', NEW.about_me,
        'bio', NEW.bio,
        'avatar_url', NEW.avatar_url,
        
        -- Preferences
        'transportation', NEW.transportation,
        'dietary_preferences', NEW.dietary_preferences,
        'search_radius_km', NEW.search_radius_km,
        
        -- Social media
        'facebook', NEW.facebook,
        'instagram', NEW.instagram,
        'twitter', NEW.twitter,
        
        -- Status
        'is_verified', NEW.is_verified,
        'is_active', NEW.is_active,
        'user_role', NEW.user_role,
        
        -- Timestamps
        'created_time', NEW.created_time,
        'updated_at', NEW.updated_at
      )
    )
  );
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- The trigger already exists, no need to recreate it
-- Just verify it's working:
SELECT 
  trigger_name,
  event_manipulation,
  event_object_table,
  action_statement
FROM information_schema.triggers
WHERE trigger_name = 'on_new_user_notify';
