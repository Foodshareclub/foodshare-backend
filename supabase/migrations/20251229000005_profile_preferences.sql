-- Migration: Add advanced profile preferences
-- Description: Adds dietary preferences, food allergies, availability, and contact preferences to profiles

-- Add dietary preferences as JSONB array (e.g., ["vegetarian", "gluten_free"])
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS dietary_preferences jsonb DEFAULT '[]'::jsonb;

-- Add food allergies as text field
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS food_allergies text;

-- Add preferred contact method
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS preferred_contact_method text DEFAULT 'in_app'
    CHECK (preferred_contact_method IN ('in_app', 'email', 'phone', 'sms'));

-- Add phone number for contact (optional)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS phone_number text;

-- Add available days as JSONB array (e.g., ["saturday", "sunday"])
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS available_days jsonb DEFAULT '["saturday", "sunday"]'::jsonb;

-- Add preferred time slots as JSONB object (e.g., {"start_hour": 12, "end_hour": 17})
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS preferred_pickup_time jsonb DEFAULT '{"start_hour": 12, "start_minute": 0, "end_hour": 17, "end_minute": 0}'::jsonb;

-- Add profile visibility setting
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS profile_visibility text DEFAULT 'public'
    CHECK (profile_visibility IN ('public', 'friends_only', 'private'));

-- Add notification preferences as JSONB
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS notification_preferences jsonb DEFAULT '{"push_enabled": true, "email_enabled": true}'::jsonb;

-- Add location sharing preference
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS location_sharing_enabled boolean DEFAULT true;

-- Create index on dietary preferences for efficient filtering
CREATE INDEX IF NOT EXISTS idx_profiles_dietary_preferences
    ON profiles USING gin (dietary_preferences);

-- Create index on available days for efficient filtering
CREATE INDEX IF NOT EXISTS idx_profiles_available_days
    ON profiles USING gin (available_days);

-- Create index on profile visibility
CREATE INDEX IF NOT EXISTS idx_profiles_visibility
    ON profiles (profile_visibility);

-- Add RLS policies for the new columns
-- Users can read all public profiles
CREATE POLICY IF NOT EXISTS "Users can read public profiles preferences" ON profiles
    FOR SELECT
    USING (
        profile_visibility = 'public'
        OR auth.uid() = id
    );

-- Users can update their own preferences
CREATE POLICY IF NOT EXISTS "Users can update their own preferences" ON profiles
    FOR UPDATE
    USING (auth.uid() = id)
    WITH CHECK (auth.uid() = id);

-- Add comments for documentation
COMMENT ON COLUMN profiles.dietary_preferences IS 'User dietary preferences as JSON array (vegetarian, vegan, gluten_free, etc.)';
COMMENT ON COLUMN profiles.food_allergies IS 'Free text description of food allergies';
COMMENT ON COLUMN profiles.preferred_contact_method IS 'How the user prefers to be contacted (in_app, email, phone, sms)';
COMMENT ON COLUMN profiles.available_days IS 'Days of week user is available for pickups as JSON array';
COMMENT ON COLUMN profiles.preferred_pickup_time IS 'Preferred time window for pickups as JSON object with start/end hours';
COMMENT ON COLUMN profiles.profile_visibility IS 'Who can view this profile (public, friends_only, private)';
COMMENT ON COLUMN profiles.notification_preferences IS 'User notification settings as JSON object';
COMMENT ON COLUMN profiles.location_sharing_enabled IS 'Whether user allows sharing their approximate location';
