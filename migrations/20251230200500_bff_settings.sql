-- ============================================================================
-- BFF Settings Screen
-- Complete settings data with atomic section updates
-- ============================================================================

-- Drop existing functions if they exist
DROP FUNCTION IF EXISTS public.get_user_settings(uuid);
DROP FUNCTION IF EXISTS public.update_user_settings(uuid, text, jsonb);
DROP FUNCTION IF EXISTS public.get_app_settings();

-- ============================================================================
-- get_user_settings - Complete settings screen data
-- ============================================================================

/**
 * get_user_settings - Returns all user settings organized by section
 *
 * Features:
 * - Settings organized by section
 * - Default values for missing preferences
 * - Field definitions with types and options
 * - Validation rules included
 *
 * @param p_user_id - The user's ID
 *
 * @returns JSONB with all settings data
 */
CREATE OR REPLACE FUNCTION public.get_user_settings(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile record;
BEGIN
  SELECT
    p.id,
    p.username,
    p.email,
    p.notification_preferences,
    p.dietary_preferences,
    p.created_at
  INTO v_profile
  FROM profiles p
  WHERE p.id = p_user_id
    AND p.deleted_at IS NULL;

  IF v_profile IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', jsonb_build_object('code', 'NOT_FOUND', 'message', 'User not found')
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'settings', jsonb_build_object(
      -- Notification Settings
      'notifications', jsonb_build_object(
        'pushEnabled', COALESCE((v_profile.notification_preferences->>'push_enabled')::boolean, true),
        'emailEnabled', COALESCE((v_profile.notification_preferences->>'email_enabled')::boolean, true),
        'newListings', COALESCE((v_profile.notification_preferences->>'new_listings')::boolean, true),
        'messages', COALESCE((v_profile.notification_preferences->>'messages')::boolean, true),
        'reminders', COALESCE((v_profile.notification_preferences->>'reminders')::boolean, true),
        'marketing', COALESCE((v_profile.notification_preferences->>'marketing')::boolean, false),
        'quietHoursEnabled', COALESCE((v_profile.notification_preferences->>'quiet_hours_enabled')::boolean, false),
        'quietHoursStart', COALESCE(v_profile.notification_preferences->>'quiet_hours_start', '22:00'),
        'quietHoursEnd', COALESCE(v_profile.notification_preferences->>'quiet_hours_end', '08:00')
      ),
      -- Privacy Settings
      'privacy', jsonb_build_object(
        'showEmail', COALESCE((v_profile.notification_preferences->>'show_email')::boolean, false),
        'showLocation', COALESCE((v_profile.notification_preferences->>'show_location')::boolean, true),
        'showOnlineStatus', COALESCE((v_profile.notification_preferences->>'show_online_status')::boolean, true),
        'allowMessages', COALESCE((v_profile.notification_preferences->>'allow_messages')::boolean, true),
        'allowRatings', COALESCE((v_profile.notification_preferences->>'allow_ratings')::boolean, true)
      ),
      -- Preferences
      'preferences', jsonb_build_object(
        'dietary', COALESCE(v_profile.dietary_preferences, '[]'::jsonb),
        'searchRadiusKm', COALESCE((v_profile.notification_preferences->>'search_radius')::integer, 10),
        'language', COALESCE(v_profile.notification_preferences->>'language', 'en'),
        'units', COALESCE(v_profile.notification_preferences->>'units', 'metric'),
        'theme', COALESCE(v_profile.notification_preferences->>'theme', 'system')
      ),
      -- Account Settings
      'account', jsonb_build_object(
        'email', v_profile.email,
        'emailVerified', true, -- Assuming verified through Supabase Auth
        'memberSince', to_char(v_profile.created_at, 'Mon DD, YYYY')
      )
    ),
    'sections', jsonb_build_array(
      jsonb_build_object(
        'id', 'notifications',
        'title', 'Notifications',
        'icon', 'bell',
        'description', 'Manage how you receive notifications',
        'fields', jsonb_build_array(
          jsonb_build_object('key', 'pushEnabled', 'label', 'Push Notifications', 'type', 'toggle', 'description', 'Receive push notifications on your device'),
          jsonb_build_object('key', 'emailEnabled', 'label', 'Email Notifications', 'type', 'toggle', 'description', 'Receive email updates'),
          jsonb_build_object('key', 'newListings', 'label', 'New Listings Nearby', 'type', 'toggle', 'description', 'Get notified when new food is shared near you'),
          jsonb_build_object('key', 'messages', 'label', 'Messages', 'type', 'toggle', 'description', 'Get notified when you receive messages'),
          jsonb_build_object('key', 'reminders', 'label', 'Reminders', 'type', 'toggle', 'description', 'Get pickup reminders'),
          jsonb_build_object('key', 'marketing', 'label', 'Marketing', 'type', 'toggle', 'description', 'Receive tips and community updates'),
          jsonb_build_object('key', 'quietHoursEnabled', 'label', 'Quiet Hours', 'type', 'toggle', 'description', 'Pause notifications during set hours'),
          jsonb_build_object('key', 'quietHoursStart', 'label', 'Start Time', 'type', 'time', 'dependsOn', 'quietHoursEnabled'),
          jsonb_build_object('key', 'quietHoursEnd', 'label', 'End Time', 'type', 'time', 'dependsOn', 'quietHoursEnabled')
        )
      ),
      jsonb_build_object(
        'id', 'privacy',
        'title', 'Privacy',
        'icon', 'shield',
        'description', 'Control your privacy settings',
        'fields', jsonb_build_array(
          jsonb_build_object('key', 'showEmail', 'label', 'Show Email', 'type', 'toggle', 'description', 'Allow others to see your email'),
          jsonb_build_object('key', 'showLocation', 'label', 'Show Location', 'type', 'toggle', 'description', 'Show your general location on listings'),
          jsonb_build_object('key', 'showOnlineStatus', 'label', 'Show Online Status', 'type', 'toggle', 'description', 'Let others see when you are online'),
          jsonb_build_object('key', 'allowMessages', 'label', 'Allow Messages', 'type', 'toggle', 'description', 'Allow others to message you'),
          jsonb_build_object('key', 'allowRatings', 'label', 'Allow Ratings', 'type', 'toggle', 'description', 'Allow others to rate you after transactions')
        )
      ),
      jsonb_build_object(
        'id', 'preferences',
        'title', 'Preferences',
        'icon', 'sliders',
        'description', 'Customize your experience',
        'fields', jsonb_build_array(
          jsonb_build_object('key', 'dietary', 'label', 'Dietary Preferences', 'type', 'multiselect',
            'options', jsonb_build_array(
              jsonb_build_object('value', 'vegetarian', 'label', 'Vegetarian'),
              jsonb_build_object('value', 'vegan', 'label', 'Vegan'),
              jsonb_build_object('value', 'gluten-free', 'label', 'Gluten-Free'),
              jsonb_build_object('value', 'dairy-free', 'label', 'Dairy-Free'),
              jsonb_build_object('value', 'nut-free', 'label', 'Nut-Free'),
              jsonb_build_object('value', 'halal', 'label', 'Halal'),
              jsonb_build_object('value', 'kosher', 'label', 'Kosher')
            )
          ),
          jsonb_build_object('key', 'searchRadiusKm', 'label', 'Search Radius', 'type', 'slider',
            'min', 1, 'max', 50, 'step', 1, 'unit', 'km'),
          jsonb_build_object('key', 'language', 'label', 'Language', 'type', 'select',
            'options', jsonb_build_array(
              jsonb_build_object('value', 'en', 'label', 'English'),
              jsonb_build_object('value', 'de', 'label', 'Deutsch'),
              jsonb_build_object('value', 'es', 'label', 'Español'),
              jsonb_build_object('value', 'fr', 'label', 'Français'),
              jsonb_build_object('value', 'ru', 'label', 'Русский')
            )
          ),
          jsonb_build_object('key', 'units', 'label', 'Units', 'type', 'select',
            'options', jsonb_build_array(
              jsonb_build_object('value', 'metric', 'label', 'Metric (km)'),
              jsonb_build_object('value', 'imperial', 'label', 'Imperial (mi)')
            )
          ),
          jsonb_build_object('key', 'theme', 'label', 'Theme', 'type', 'select',
            'options', jsonb_build_array(
              jsonb_build_object('value', 'system', 'label', 'System'),
              jsonb_build_object('value', 'light', 'label', 'Light'),
              jsonb_build_object('value', 'dark', 'label', 'Dark')
            )
          )
        )
      ),
      jsonb_build_object(
        'id', 'account',
        'title', 'Account',
        'icon', 'user',
        'description', 'Manage your account',
        'fields', jsonb_build_array(
          jsonb_build_object('key', 'email', 'label', 'Email', 'type', 'display', 'description', 'Your registered email address'),
          jsonb_build_object('key', 'memberSince', 'label', 'Member Since', 'type', 'display')
        ),
        'actions', jsonb_build_array(
          jsonb_build_object('label', 'Change Password', 'action', 'change_password', 'style', 'secondary'),
          jsonb_build_object('label', 'Export My Data', 'action', 'export_data', 'style', 'secondary'),
          jsonb_build_object('label', 'Delete Account', 'action', 'delete_account', 'style', 'danger')
        )
      )
    ),
    'meta', jsonb_build_object(
      'timestamp', NOW(),
      'cacheTTL', 300
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_user_settings(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_settings(uuid) TO service_role;

COMMENT ON FUNCTION public.get_user_settings IS 'BFF endpoint: Returns complete settings screen data';

-- ============================================================================
-- update_user_settings - Atomically updates a settings section
-- ============================================================================

/**
 * update_user_settings - Updates a specific settings section
 *
 * @param p_user_id - The user's ID
 * @param p_section - The section to update ('notifications', 'privacy', 'preferences')
 * @param p_settings - The settings to update
 *
 * @returns JSONB with updated section
 */
CREATE OR REPLACE FUNCTION public.update_user_settings(
  p_user_id uuid,
  p_section text,
  p_settings jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_prefs jsonb;
  v_new_prefs jsonb;
  v_key text;
  v_value jsonb;
BEGIN
  -- Get current preferences
  SELECT COALESCE(notification_preferences, '{}'::jsonb)
  INTO v_current_prefs
  FROM profiles
  WHERE id = p_user_id AND deleted_at IS NULL;

  IF v_current_prefs IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', jsonb_build_object('code', 'NOT_FOUND', 'message', 'User not found')
    );
  END IF;

  -- Map section keys to storage keys and merge
  CASE p_section
    WHEN 'notifications' THEN
      v_new_prefs := v_current_prefs;
      -- Convert camelCase to snake_case for storage
      FOR v_key, v_value IN SELECT * FROM jsonb_each(p_settings) LOOP
        v_new_prefs := jsonb_set(
          v_new_prefs,
          ARRAY[
            CASE v_key
              WHEN 'pushEnabled' THEN 'push_enabled'
              WHEN 'emailEnabled' THEN 'email_enabled'
              WHEN 'newListings' THEN 'new_listings'
              WHEN 'quietHoursEnabled' THEN 'quiet_hours_enabled'
              WHEN 'quietHoursStart' THEN 'quiet_hours_start'
              WHEN 'quietHoursEnd' THEN 'quiet_hours_end'
              ELSE v_key
            END
          ],
          v_value
        );
      END LOOP;

    WHEN 'privacy' THEN
      v_new_prefs := v_current_prefs;
      FOR v_key, v_value IN SELECT * FROM jsonb_each(p_settings) LOOP
        v_new_prefs := jsonb_set(
          v_new_prefs,
          ARRAY[
            CASE v_key
              WHEN 'showEmail' THEN 'show_email'
              WHEN 'showLocation' THEN 'show_location'
              WHEN 'showOnlineStatus' THEN 'show_online_status'
              WHEN 'allowMessages' THEN 'allow_messages'
              WHEN 'allowRatings' THEN 'allow_ratings'
              ELSE v_key
            END
          ],
          v_value
        );
      END LOOP;

    WHEN 'preferences' THEN
      v_new_prefs := v_current_prefs;
      FOR v_key, v_value IN SELECT * FROM jsonb_each(p_settings) LOOP
        IF v_key = 'dietary' THEN
          -- Dietary preferences stored separately
          UPDATE profiles
          SET dietary_preferences = v_value,
              updated_at = NOW()
          WHERE id = p_user_id;
        ELSE
          v_new_prefs := jsonb_set(
            v_new_prefs,
            ARRAY[
              CASE v_key
                WHEN 'searchRadiusKm' THEN 'search_radius'
                ELSE v_key
              END
            ],
            v_value
          );
        END IF;
      END LOOP;

    ELSE
      RETURN jsonb_build_object(
        'success', false,
        'error', jsonb_build_object('code', 'INVALID_SECTION', 'message', 'Unknown settings section')
      );
  END CASE;

  -- Update notification preferences
  UPDATE profiles
  SET notification_preferences = v_new_prefs,
      updated_at = NOW()
  WHERE id = p_user_id;

  RETURN jsonb_build_object(
    'success', true,
    'section', p_section,
    'updated', p_settings,
    'meta', jsonb_build_object('timestamp', NOW())
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_user_settings(uuid, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_user_settings(uuid, text, jsonb) TO service_role;

COMMENT ON FUNCTION public.update_user_settings IS 'Atomically updates a settings section';

-- ============================================================================
-- get_app_settings - Returns app-wide settings and configuration
-- ============================================================================

/**
 * get_app_settings - Returns app configuration for clients
 *
 * Includes:
 * - App version requirements
 * - Feature availability
 * - Default values
 * - Support links
 *
 * @returns JSONB with app settings
 */
CREATE OR REPLACE FUNCTION public.get_app_settings()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN jsonb_build_object(
    'success', true,
    'app', jsonb_build_object(
      'name', 'FoodShare',
      'version', '1.0.0',
      'minSupportedVersion', '0.9.0'
    ),
    'features', jsonb_build_object(
      'pushNotifications', true,
      'emailNotifications', true,
      'locationServices', true,
      'messaging', true,
      'ratings', true,
      'challenges', true
    ),
    'defaults', jsonb_build_object(
      'searchRadiusKm', 10,
      'maxSearchRadiusKm', 50,
      'maxImagesPerListing', 5,
      'maxDescriptionLength', 2000,
      'listingExpiryDays', 7
    ),
    'support', jsonb_build_object(
      'email', 'support@foodshare.app',
      'helpUrl', 'https://help.foodshare.app',
      'termsUrl', 'https://foodshare.app/terms',
      'privacyUrl', 'https://foodshare.app/privacy'
    ),
    'legal', jsonb_build_object(
      'termsVersion', '2024-01-01',
      'privacyVersion', '2024-01-01'
    ),
    'meta', jsonb_build_object(
      'timestamp', NOW(),
      'cacheTTL', 3600
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_app_settings() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_app_settings() TO anon;
GRANT EXECUTE ON FUNCTION public.get_app_settings() TO service_role;

COMMENT ON FUNCTION public.get_app_settings IS 'Returns app-wide configuration for clients';
