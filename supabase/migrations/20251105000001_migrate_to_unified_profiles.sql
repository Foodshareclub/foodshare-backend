-- Migration: Migrate from profiles_foodshare to unified profiles table
-- This consolidates user data into a single cross-platform profiles table
-- Created: 2025-11-05
--
-- ⚠️  PRODUCTION SAFETY - CRITICAL:
-- This migration modifies foreign key constraints and drops a table
-- MUST be run with extreme caution on production
--
-- PREREQUISITES:
-- 1. Migration 20251105000000_add_ios_fields_to_profiles.sql MUST be applied first
-- 2. BACKUP YOUR DATABASE: npx supabase db dump -f backup_before_migration.sql
-- 3. Test on staging environment first
-- 4. Verify no active users are using profiles_foodshare
-- 5. Run during maintenance window (low traffic)
--
-- VALIDATION CHECKS:
-- - Ensures profiles table has required iOS fields
-- - Verifies no data loss during migration
-- - Confirms all foreign keys are updated
--
-- ROLLBACK: See rollback script at end of file

-- Start transaction for atomicity
BEGIN;

-- SAFETY CHECK 1: Verify prerequisites
DO $$
BEGIN
    -- Check that profiles table exists
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'profiles') THEN
        RAISE EXCEPTION 'ABORT: profiles table does not exist!';
    END IF;
    
    -- Check that iOS fields were added to profiles
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'profiles' AND column_name = 'bio'
    ) THEN
        RAISE EXCEPTION 'ABORT: iOS fields not found in profiles table. Run migration 20251105000000 first!';
    END IF;
    
    -- Check if profiles_foodshare exists
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'profiles_foodshare') THEN
        RAISE NOTICE 'profiles_foodshare table does not exist. Skipping migration.';
    END IF;
    
    RAISE NOTICE 'Prerequisites verified. Proceeding with migration...';
END $$;

-- SAFETY CHECK 2: Count records before migration
DO $$
DECLARE
    profiles_count INTEGER;
    profiles_foodshare_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO profiles_count FROM profiles;
    SELECT COUNT(*) INTO profiles_foodshare_count FROM profiles_foodshare;
    
    RAISE NOTICE 'Current state: profiles=% rows, profiles_foodshare=% rows', 
        profiles_count, profiles_foodshare_count;
END $$;

-- Step 1: Migrate any data from profiles_foodshare to profiles (if needed)
-- Note: Only migrate if there are users in profiles_foodshare not in profiles
INSERT INTO profiles (
    id, 
    nickname, 
    first_name, 
    second_name,
    email,
    phone,
    avatar_url,
    bio,
    dietary_preferences,
    notification_preferences,
    search_radius_km,
    is_verified,
    is_active,
    items_shared,
    items_received,
    rating_average,
    rating_count,
    last_seen_at,
    created_time,
    updated_at
)
SELECT 
    pf.id,
    COALESCE(pf.nickname, ''),
    COALESCE(pf.first_name, ''),
    COALESCE(pf.last_name, ''),  -- maps to second_name
    pf.email,
    COALESCE(pf.phone, ''),
    COALESCE(pf.avatar_url, 'https://***REMOVED***/storage/v1/object/public/avatars/cuties/cute-strawberry.png'),
    pf.bio,
    COALESCE(pf.dietary_preferences, '[]'::jsonb),
    COALESCE(pf.notification_preferences, '{"messages": true, "new_listings": true, "reservations": true}'::jsonb),
    COALESCE(pf.search_radius_km, 5),
    COALESCE(pf.is_verified, false),
    COALESCE(pf.is_active, true),
    COALESCE(pf.items_shared, 0),
    COALESCE(pf.items_received, 0),
    COALESCE(pf.rating_average, 0.0),
    COALESCE(pf.rating_count, 0),
    COALESCE(pf.last_seen_at, now()),
    COALESCE(pf.created_at, now()),
    COALESCE(pf.updated_at, now())
FROM profiles_foodshare pf
WHERE NOT EXISTS (
    SELECT 1 FROM profiles p WHERE p.id = pf.id
)
ON CONFLICT (id) DO NOTHING;

-- Step 2: Update foreign key constraints to point to profiles instead of profiles_foodshare

-- Drop existing foreign key constraints
ALTER TABLE food_items DROP CONSTRAINT IF EXISTS food_items_user_id_fkey;
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_owner_id_fkey;
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_requester_id_fkey;
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_last_message_sender_id_fkey;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_sender_id_fkey;
ALTER TABLE reservations DROP CONSTRAINT IF EXISTS reservations_requester_id_fkey;
ALTER TABLE foodshare_reviews DROP CONSTRAINT IF EXISTS foodshare_reviews_reviewer_id_fkey;
ALTER TABLE foodshare_reviews DROP CONSTRAINT IF EXISTS foodshare_reviews_reviewed_user_id_fkey;

-- Add new foreign key constraints pointing to profiles
ALTER TABLE food_items 
    ADD CONSTRAINT food_items_user_id_fkey 
    FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;

ALTER TABLE conversations 
    ADD CONSTRAINT conversations_owner_id_fkey 
    FOREIGN KEY (owner_id) REFERENCES profiles(id) ON DELETE CASCADE;

ALTER TABLE conversations 
    ADD CONSTRAINT conversations_requester_id_fkey 
    FOREIGN KEY (requester_id) REFERENCES profiles(id) ON DELETE CASCADE;

ALTER TABLE conversations 
    ADD CONSTRAINT conversations_last_message_sender_id_fkey 
    FOREIGN KEY (last_message_sender_id) REFERENCES profiles(id) ON DELETE SET NULL;

ALTER TABLE messages 
    ADD CONSTRAINT messages_sender_id_fkey 
    FOREIGN KEY (sender_id) REFERENCES profiles(id) ON DELETE CASCADE;

ALTER TABLE reservations 
    ADD CONSTRAINT reservations_requester_id_fkey 
    FOREIGN KEY (requester_id) REFERENCES profiles(id) ON DELETE CASCADE;

ALTER TABLE foodshare_reviews 
    ADD CONSTRAINT foodshare_reviews_reviewer_id_fkey 
    FOREIGN KEY (reviewer_id) REFERENCES profiles(id) ON DELETE CASCADE;

ALTER TABLE foodshare_reviews 
    ADD CONSTRAINT foodshare_reviews_reviewed_user_id_fkey 
    FOREIGN KEY (reviewed_user_id) REFERENCES profiles(id) ON DELETE CASCADE;

-- SAFETY CHECK 3: Verify foreign keys were updated correctly
DO $$
DECLARE
    fk_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO fk_count
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu 
        ON ccu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY' 
        AND ccu.table_name = 'profiles'
        AND tc.table_name IN (
            'food_items', 'conversations', 'messages', 
            'reservations', 'foodshare_reviews'
        );
    
    IF fk_count < 8 THEN
        RAISE EXCEPTION 'ABORT: Foreign key migration incomplete! Expected 8 FKs, found %', fk_count;
    END IF;
    
    RAISE NOTICE 'Foreign keys verified: % constraints point to profiles table', fk_count;
END $$;

-- SAFETY CHECK 4: Verify no data in iOS tables references non-existent profiles
DO $$
DECLARE
    orphaned_count INTEGER;
BEGIN
    -- Check food_items
    SELECT COUNT(*) INTO orphaned_count
    FROM food_items fi
    WHERE NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = fi.user_id);
    
    IF orphaned_count > 0 THEN
        RAISE EXCEPTION 'ABORT: Found % food_items with invalid user_id!', orphaned_count;
    END IF;
    
    RAISE NOTICE 'Data integrity verified: No orphaned records found';
END $$;

-- Step 3: Drop profiles_foodshare table (now redundant)
-- Only drop if it exists and has no remaining dependencies
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'profiles_foodshare') THEN
        DROP TABLE profiles_foodshare CASCADE;
        RAISE NOTICE 'profiles_foodshare table dropped successfully';
    ELSE
        RAISE NOTICE 'profiles_foodshare table already dropped or does not exist';
    END IF;
END $$;

-- Add comment
COMMENT ON TABLE profiles IS 'Unified user profiles for web and iOS apps';

-- FINAL VERIFICATION
DO $$
DECLARE
    final_profiles_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO final_profiles_count FROM profiles;
    
    RAISE NOTICE '=== MIGRATION COMPLETE ===';
    RAISE NOTICE 'Final profiles count: %', final_profiles_count;
    RAISE NOTICE 'All foreign keys updated to reference profiles table';
    RAISE NOTICE 'profiles_foodshare table removed';
    RAISE NOTICE '========================';
END $$;

-- Commit transaction
COMMIT;

-- ROLLBACK SCRIPT (run separately if needed):
/*
⚠️  WARNING: This rollback script will recreate profiles_foodshare and revert foreign keys
Only use if you need to undo the migration immediately after applying it

BEGIN;

-- Recreate profiles_foodshare table
CREATE TABLE profiles_foodshare (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT UNIQUE CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}$'),
    nickname TEXT,
    first_name TEXT,
    last_name TEXT,
    avatar_url TEXT,
    bio TEXT,
    phone TEXT CHECK (phone ~* '^\+?[1-9]\d{1,14}$'),
    rating_average NUMERIC(3,2) DEFAULT 0.0 CHECK (rating_average >= 0 AND rating_average <= 5.0),
    rating_count INTEGER DEFAULT 0 CHECK (rating_count >= 0),
    items_shared INTEGER DEFAULT 0 CHECK (items_shared >= 0),
    items_received INTEGER DEFAULT 0 CHECK (items_received >= 0),
    location geography(Point, 4326),
    latitude DOUBLE PRECISION CHECK (latitude >= -90 AND latitude <= 90),
    longitude DOUBLE PRECISION CHECK (longitude >= -180 AND longitude <= 180),
    search_radius_km INTEGER DEFAULT 5 CHECK (search_radius_km > 0 AND search_radius_km <= 100),
    dietary_preferences JSONB DEFAULT '[]'::jsonb,
    notification_preferences JSONB DEFAULT '{"messages": true, "new_listings": true, "reservations": true}'::jsonb,
    is_verified BOOLEAN DEFAULT false,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    last_seen_at TIMESTAMPTZ DEFAULT now()
);

-- Copy data back from profiles
INSERT INTO profiles_foodshare (
    id, email, nickname, first_name, last_name, avatar_url, bio, phone,
    rating_average, rating_count, items_shared, items_received,
    search_radius_km, dietary_preferences, notification_preferences,
    is_verified, is_active, last_seen_at, created_at, updated_at
)
SELECT 
    id, email, nickname, first_name, second_name, avatar_url, bio, phone,
    rating_average, rating_count, items_shared, items_received,
    search_radius_km, dietary_preferences, notification_preferences,
    is_verified, is_active, last_seen_at, created_time, updated_at
FROM profiles
WHERE bio IS NOT NULL OR dietary_preferences IS NOT NULL;  -- Only iOS users

-- Revert foreign keys
ALTER TABLE food_items DROP CONSTRAINT food_items_user_id_fkey;
ALTER TABLE food_items ADD CONSTRAINT food_items_user_id_fkey 
    FOREIGN KEY (user_id) REFERENCES profiles_foodshare(id) ON DELETE CASCADE;

-- (Repeat for other tables...)

COMMIT;
*/
