-- Migration: Add iOS-specific fields to profiles table
-- This enables cross-platform user profiles for web and iOS apps
-- Created: 2025-11-05
-- 
-- ⚠️  PRODUCTION SAFETY:
-- This migration is ADDITIVE ONLY - it adds new columns with defaults
-- No existing data is modified or deleted
-- Safe to run on production database
--
-- BEFORE RUNNING:
-- 1. Backup your database: npx supabase db dump -f backup_before_ios_fields.sql
-- 2. Test on staging environment first
-- 3. Run during low-traffic period
--
-- ROLLBACK: Simply drop the added columns if needed (see rollback script below)

-- Start transaction for atomicity
BEGIN;

-- Verify we're working with the correct table
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'profiles') THEN
        RAISE EXCEPTION 'profiles table does not exist! Aborting migration.';
    END IF;
END $$;

-- Add iOS-specific columns to profiles table (all with safe defaults)
ALTER TABLE profiles
ADD COLUMN IF NOT EXISTS bio TEXT,
ADD COLUMN IF NOT EXISTS dietary_preferences JSONB DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS notification_preferences JSONB DEFAULT '{"messages": true, "new_listings": true, "reservations": true}'::jsonb,
ADD COLUMN IF NOT EXISTS search_radius_km INTEGER DEFAULT 5 CHECK (search_radius_km > 0 AND search_radius_km <= 100),
ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS items_shared INTEGER DEFAULT 0 CHECK (items_shared >= 0),
ADD COLUMN IF NOT EXISTS items_received INTEGER DEFAULT 0 CHECK (items_received >= 0),
ADD COLUMN IF NOT EXISTS rating_average NUMERIC(3,2) DEFAULT 0.0 CHECK (rating_average >= 0 AND rating_average <= 5.0),
ADD COLUMN IF NOT EXISTS rating_count INTEGER DEFAULT 0 CHECK (rating_count >= 0),
ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ DEFAULT now();

-- Add comment explaining the fields
COMMENT ON COLUMN profiles.bio IS 'User bio/about me text';
COMMENT ON COLUMN profiles.dietary_preferences IS 'Array of dietary preferences (e.g., ["vegetarian", "gluten-free"])';
COMMENT ON COLUMN profiles.notification_preferences IS 'Notification settings for messages, listings, and reservations';
COMMENT ON COLUMN profiles.search_radius_km IS 'Default search radius in kilometers (1-100)';
COMMENT ON COLUMN profiles.is_verified IS 'Whether user has verified their email/phone';
COMMENT ON COLUMN profiles.is_active IS 'Whether user account is active';
COMMENT ON COLUMN profiles.items_shared IS 'Count of food items shared';
COMMENT ON COLUMN profiles.items_received IS 'Count of food items received';
COMMENT ON COLUMN profiles.rating_average IS 'Average rating from reviews (0-5.0)';
COMMENT ON COLUMN profiles.rating_count IS 'Total number of reviews received';
COMMENT ON COLUMN profiles.last_seen_at IS 'Last time user was active in the app';

-- Create index for active users
CREATE INDEX IF NOT EXISTS idx_profiles_is_active ON profiles(is_active) WHERE is_active = true;

-- Create index for last seen (for activity tracking)
CREATE INDEX IF NOT EXISTS idx_profiles_last_seen_at ON profiles(last_seen_at DESC);

-- Create index for search radius (for location-based queries)
CREATE INDEX IF NOT EXISTS idx_profiles_search_radius_km ON profiles(search_radius_km);

-- Verify migration success
DO $$
DECLARE
    missing_columns TEXT[];
BEGIN
    SELECT ARRAY_AGG(column_name)
    INTO missing_columns
    FROM (
        VALUES 
            ('bio'), ('dietary_preferences'), ('notification_preferences'),
            ('search_radius_km'), ('is_verified'), ('is_active'),
            ('items_shared'), ('items_received'), ('rating_average'),
            ('rating_count'), ('last_seen_at')
    ) AS expected(column_name)
    WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'profiles' AND column_name = expected.column_name
    );
    
    IF missing_columns IS NOT NULL THEN
        RAISE EXCEPTION 'Migration failed! Missing columns: %', missing_columns;
    END IF;
    
    RAISE NOTICE 'Migration successful! All iOS fields added to profiles table.';
END $$;

-- Commit transaction
COMMIT;

-- ROLLBACK SCRIPT (run separately if needed):
/*
BEGIN;
ALTER TABLE profiles
    DROP COLUMN IF EXISTS bio,
    DROP COLUMN IF EXISTS dietary_preferences,
    DROP COLUMN IF EXISTS notification_preferences,
    DROP COLUMN IF EXISTS search_radius_km,
    DROP COLUMN IF EXISTS is_verified,
    DROP COLUMN IF EXISTS is_active,
    DROP COLUMN IF EXISTS items_shared,
    DROP COLUMN IF EXISTS items_received,
    DROP COLUMN IF EXISTS rating_average,
    DROP COLUMN IF EXISTS rating_count,
    DROP COLUMN IF EXISTS last_seen_at;

DROP INDEX IF EXISTS idx_profiles_is_active;
DROP INDEX IF EXISTS idx_profiles_last_seen_at;
DROP INDEX IF EXISTS idx_profiles_search_radius_km;
COMMIT;
*/
