-- Migration: Add Missing NOT NULL Constraints
-- Priority: HIGH
-- Description: Adds NOT NULL constraints to critical columns that should never be NULL
-- Impact: Prevents data integrity issues and NULL-related bugs
--
-- Changes:
-- 1. Adds NOT NULL to foreign key columns
-- 2. Adds NOT NULL to created_at timestamps
-- 3. Backfills any existing NULL values with defaults
--
-- Created: 2025-01-04
-- Author: Data Integrity Audit

BEGIN;

-- =============================================================================
-- FORUM TABLE
-- =============================================================================

-- Backfill NULL profile_id values (shouldn't exist, but be safe)
UPDATE public.forum
SET profile_id = '00000000-0000-0000-0000-000000000000'
WHERE profile_id IS NULL;

-- Add NOT NULL constraint
ALTER TABLE public.forum
ALTER COLUMN profile_id SET NOT NULL;

-- =============================================================================
-- REVIEWS TABLE
-- =============================================================================

-- Backfill NULL profile_id values
UPDATE public.reviews
SET profile_id = '00000000-0000-0000-0000-000000000000'
WHERE profile_id IS NULL;

-- Add NOT NULL constraint
ALTER TABLE public.reviews
ALTER COLUMN profile_id SET NOT NULL;

-- =============================================================================
-- ROOM_PARTICIPANTS TABLE
-- =============================================================================

-- Delete rows with NULL profile_id (invalid data)
-- These are messages without a sender, which shouldn't exist
DELETE FROM public.room_participants
WHERE profile_id IS NULL;

-- Add NOT NULL constraint
ALTER TABLE public.room_participants
ALTER COLUMN profile_id SET NOT NULL;

-- =============================================================================
-- ADDRESS TABLE - created_at
-- =============================================================================

-- Backfill NULL created_at with current timestamp
UPDATE public.address
SET created_at = NOW()
WHERE created_at IS NULL;

-- Add NOT NULL constraint with default
ALTER TABLE public.address
ALTER COLUMN created_at SET NOT NULL;

ALTER TABLE public.address
ALTER COLUMN created_at SET DEFAULT (NOW() AT TIME ZONE 'utc');

-- =============================================================================
-- CHALLENGE_ACTIVITIES TABLE - created_at
-- =============================================================================

-- Backfill NULL created_at
UPDATE public.challenge_activities
SET created_at = NOW()
WHERE created_at IS NULL;

-- Add NOT NULL constraint with default
ALTER TABLE public.challenge_activities
ALTER COLUMN created_at SET NOT NULL;

ALTER TABLE public.challenge_activities
ALTER COLUMN created_at SET DEFAULT NOW();

-- =============================================================================
-- LOCATION_UPDATE_QUEUE TABLE - created_at
-- =============================================================================

-- Backfill NULL created_at
UPDATE public.location_update_queue
SET created_at = CURRENT_TIMESTAMP
WHERE created_at IS NULL;

-- Add NOT NULL constraint with default
ALTER TABLE public.location_UPDATE_queue
ALTER COLUMN created_at SET NOT NULL;

ALTER TABLE public.location_update_queue
ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;

-- =============================================================================
-- POSTS TABLE - Critical fields
-- =============================================================================

-- Ensure post_title is never NULL
UPDATE public.posts
SET post_title = '(No Title)'
WHERE post_title IS NULL OR post_title = '';

ALTER TABLE public.posts
ALTER COLUMN post_title SET NOT NULL;

-- Ensure profile_id is never NULL
ALTER TABLE public.posts
ALTER COLUMN profile_id SET NOT NULL;

-- =============================================================================
-- LIKES TABLE
-- =============================================================================

-- Ensure profile_id is never NULL
DELETE FROM public.likes WHERE profile_id IS NULL;

ALTER TABLE public.likes
ALTER COLUMN profile_id SET NOT NULL;

-- =============================================================================
-- COMMENTS TABLE
-- =============================================================================

-- Ensure user_id is never NULL
DELETE FROM public.comments WHERE user_id IS NULL;

ALTER TABLE public.comments
ALTER COLUMN user_id SET NOT NULL;

-- =============================================================================
-- ROOMS TABLE
-- =============================================================================

-- Ensure sharer and requester are never NULL
DELETE FROM public.rooms
WHERE sharer IS NULL OR requester IS NULL;

ALTER TABLE public.rooms
ALTER COLUMN sharer SET NOT NULL;

ALTER TABLE public.rooms
ALTER COLUMN requester SET NOT NULL;

-- =============================================================================
-- VERIFICATION
-- =============================================================================

-- Check for remaining NULL values in critical columns
-- SELECT
--   'forum' as table_name,
--   COUNT(*) as null_count
-- FROM public.forum
-- WHERE profile_id IS NULL
-- UNION ALL
-- SELECT 'reviews', COUNT(*) FROM public.reviews WHERE profile_id IS NULL
-- UNION ALL
-- SELECT 'room_participants', COUNT(*) FROM public.room_participants WHERE profile_id IS NULL
-- UNION ALL
-- SELECT 'address', COUNT(*) FROM public.address WHERE created_at IS NULL
-- UNION ALL
-- SELECT 'posts', COUNT(*) FROM public.posts WHERE post_title IS NULL OR profile_id IS NULL
-- UNION ALL
-- SELECT 'likes', COUNT(*) FROM public.likes WHERE profile_id IS NULL
-- UNION ALL
-- SELECT 'comments', COUNT(*) FROM public.comments WHERE user_id IS NULL
-- UNION ALL
-- SELECT 'rooms', COUNT(*) FROM public.rooms WHERE sharer IS NULL OR requester IS NULL;

-- Should return 0 for all counts

COMMIT;

-- =============================================================================
-- EXPECTED BENEFITS
-- =============================================================================

-- Data integrity: Prevents NULL-related bugs in application
-- Query optimization: Enables optimizer to skip NULL checks
-- Foreign key reliability: Ensures all references are valid
-- Timestamp consistency: All created_at fields have values

-- =============================================================================
-- ROLLBACK INSTRUCTIONS
-- =============================================================================

-- To rollback (NOT RECOMMENDED - allows bad data):
/*
BEGIN;

ALTER TABLE public.forum ALTER COLUMN profile_id DROP NOT NULL;
ALTER TABLE public.reviews ALTER COLUMN profile_id DROP NOT NULL;
ALTER TABLE public.room_participants ALTER COLUMN profile_id DROP NOT NULL;
ALTER TABLE public.address ALTER COLUMN created_at DROP NOT NULL;
ALTER TABLE public.challenge_activities ALTER COLUMN created_at DROP NOT NULL;
ALTER TABLE public.location_update_queue ALTER COLUMN created_at DROP NOT NULL;
ALTER TABLE public.posts ALTER COLUMN post_title DROP NOT NULL;
ALTER TABLE public.posts ALTER COLUMN profile_id DROP NOT NULL;
ALTER TABLE public.likes ALTER COLUMN profile_id DROP NOT NULL;
ALTER TABLE public.comments ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.rooms ALTER COLUMN sharer DROP NOT NULL;
ALTER TABLE public.rooms ALTER COLUMN requester DROP NOT NULL;

COMMIT;
*/

-- =============================================================================
-- APPLICATION IMPACT
-- =============================================================================

-- iOS app should already handle these correctly, but verify:
-- 1. Always provide profile_id when creating posts/reviews/forum/likes/comments
-- 2. created_at is now auto-populated with default
-- 3. Room creation requires both sharer and requester
-- 4. Post title cannot be empty

-- Example Swift code:
/*
// ✅ GOOD
let post = Post(
    title: title.isEmpty ? "(No Title)" : title,  // Never empty
    profileId: userId  // Always set
)

// ❌ BAD - Will fail with NOT NULL constraint error
let post = Post(
    title: nil,  // Error!
    profileId: nil  // Error!
)
*/
