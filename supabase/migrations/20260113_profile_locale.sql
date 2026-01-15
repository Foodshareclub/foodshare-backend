-- Add preferred_locale column to profiles table
-- Stores user's language preference (e.g., 'en', 'ru', 'de')

ALTER TABLE profiles 
ADD COLUMN IF NOT EXISTS preferred_locale TEXT DEFAULT NULL;

-- Add comment
COMMENT ON COLUMN profiles.preferred_locale IS 'User preferred locale code (e.g., en, ru, de). NULL means use system locale.';

-- Update profiles_with_stats view to include preferred_locale
CREATE OR REPLACE VIEW profiles_with_stats AS
SELECT 
    p.id,
    p.nickname,
    p.avatar_url,
    p.bio,
    p.about_me,
    p.created_time,
    p.search_radius_km,
    p.preferred_locale,
    COALESCE(ps.items_shared, 0) as items_shared,
    COALESCE(ps.items_received, 0) as items_received,
    COALESCE(ps.rating_average, 0.0) as rating_average,
    COALESCE(ps.rating_count, 0) as rating_count
FROM profiles p
LEFT JOIN profile_stats ps ON p.id = ps.profile_id;
