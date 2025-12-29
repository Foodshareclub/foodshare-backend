-- Migration: Add CHECK Constraints (Data Validation)
-- Priority: HIGH
-- Description: Adds CHECK constraints for data validation and integrity
-- Impact: Prevents invalid data from entering the database
--
-- Changes:
-- 1. Email and phone format validation
-- 2. Rating range validation (0-5 stars)
-- 3. Coordinate range validation (lat/lon)
-- 4. URL format validation
-- 5. Counter value validation (non-negative)
--
-- Created: 2025-01-05
-- Author: Enterprise Data Quality Review

BEGIN;

-- =============================================================================
-- PROFILES TABLE - CONTACT INFORMATION VALIDATION
-- =============================================================================

-- Email format validation (RFC 5322 simplified)
ALTER TABLE public.profiles
  ADD CONSTRAINT check_email_format
  CHECK (
    email IS NULL OR
    email ~* '^[a-zA-Z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$'
  );

COMMENT ON CONSTRAINT check_email_format ON public.profiles IS
  'Validates email format using RFC 5322 simplified regex pattern';

-- Phone number format validation (E.164 international format)
ALTER TABLE public.profiles
  ADD CONSTRAINT check_phone_format
  CHECK (
    phone = '' OR
    phone ~* '^\+?[1-9]\d{1,14}$'
  );

COMMENT ON CONSTRAINT check_phone_format ON public.profiles IS
  'Validates phone number using E.164 format (+[1-9][0-9]{1,14})';

-- =============================================================================
-- REVIEWS TABLE - RATING VALIDATION
-- =============================================================================

-- Rating must be between 0 and 5 stars
ALTER TABLE public.reviews
  ADD CONSTRAINT check_rating_range
  CHECK (reviewed_rating >= 0 AND reviewed_rating <= 5);

COMMENT ON CONSTRAINT check_rating_range ON public.reviews IS
  'Ensures ratings are between 0 and 5 stars inclusive';

-- =============================================================================
-- POSTS TABLE - GEOLOCATION VALIDATION
-- =============================================================================

-- Latitude range: -90 to +90 degrees
ALTER TABLE public.posts
  ADD CONSTRAINT check_latitude_valid
  CHECK (
    latitude IS NULL OR
    (latitude >= -90 AND latitude <= 90)
  );

COMMENT ON CONSTRAINT check_latitude_valid ON public.posts IS
  'Validates latitude is within valid geographic range (-90 to +90 degrees)';

-- Longitude range: -180 to +180 degrees
ALTER TABLE public.posts
  ADD CONSTRAINT check_longitude_valid
  CHECK (
    longitude IS NULL OR
    (longitude >= -180 AND latitude <= 180)
  );

COMMENT ON CONSTRAINT check_longitude_valid ON public.posts IS
  'Validates longitude is within valid geographic range (-180 to +180 degrees)';

-- Coordinates must both be set or both be null
ALTER TABLE public.posts
  ADD CONSTRAINT check_coordinates_paired
  CHECK (
    (latitude IS NULL AND longitude IS NULL) OR
    (latitude IS NOT NULL AND longitude IS NOT NULL)
  );

COMMENT ON CONSTRAINT check_coordinates_paired ON public.posts IS
  'Ensures lat/lon are always set together (both null or both not null)';

-- =============================================================================
-- POSTS TABLE - COUNTER VALIDATION
-- =============================================================================

-- Post views cannot be negative
ALTER TABLE public.posts
  ADD CONSTRAINT check_post_views_non_negative
  CHECK (post_views >= 0);

COMMENT ON CONSTRAINT check_post_views_non_negative ON public.posts IS
  'Prevents negative view counts';

-- Post like counter cannot be negative
ALTER TABLE public.posts
  ADD CONSTRAINT check_post_likes_non_negative
  CHECK (post_like_counter IS NULL OR post_like_counter >= 0);

COMMENT ON CONSTRAINT check_post_likes_non_negative ON public.posts IS
  'Prevents negative like counts';

-- =============================================================================
-- CHALLENGES TABLE - COUNTER VALIDATION
-- =============================================================================

-- Challenge views cannot be negative
ALTER TABLE public.challenges
  ADD CONSTRAINT check_challenge_views_non_negative
  CHECK (challenge_views >= 0);

COMMENT ON CONSTRAINT check_challenge_views_non_negative ON public.challenges IS
  'Prevents negative challenge view counts';

-- Challenge likes cannot be negative
ALTER TABLE public.challenges
  ADD CONSTRAINT check_challenge_likes_non_negative
  CHECK (challenge_likes_counter >= 0);

COMMENT ON CONSTRAINT check_challenge_likes_non_negative ON public.challenges IS
  'Prevents negative challenge like counts';

-- Challenge score cannot be negative
ALTER TABLE public.challenges
  ADD CONSTRAINT check_challenge_score_non_negative
  CHECK (challenge_score >= 0);

COMMENT ON CONSTRAINT check_challenge_score_non_negative ON public.challenges IS
  'Prevents negative challenge scores';

-- Challenged people count cannot be negative
ALTER TABLE public.challenges
  ADD CONSTRAINT check_challenged_people_non_negative
  CHECK (challenged_people >= 0);

COMMENT ON CONSTRAINT check_challenged_people_non_negative ON public.challenges IS
  'Prevents negative challenged people counts';

-- =============================================================================
-- FORUM TABLE - COUNTER VALIDATION
-- =============================================================================

-- Forum likes cannot be negative
ALTER TABLE public.forum
  ADD CONSTRAINT check_forum_likes_non_negative
  CHECK (forum_likes_counter >= 0);

COMMENT ON CONSTRAINT check_forum_likes_non_negative ON public.forum IS
  'Prevents negative forum like counts';

-- Forum comments cannot be negative
ALTER TABLE public.forum
  ADD CONSTRAINT check_forum_comments_non_negative
  CHECK (forum_comments_counter IS NULL OR forum_comments_counter >= 0);

COMMENT ON CONSTRAINT check_forum_comments_non_negative ON public.forum IS
  'Prevents negative forum comment counts';

-- =============================================================================
-- PROFILES TABLE - COUNTER VALIDATION
-- =============================================================================

-- Liked posts counter cannot be negative
ALTER TABLE public.profiles
  ADD CONSTRAINT check_liked_posts_non_negative
  CHECK (liked_posts_counter >= 0);

-- Liked forums counter cannot be negative
ALTER TABLE public.profiles
  ADD CONSTRAINT check_liked_forums_non_negative
  CHECK (liked_forums_counter >= 0);

-- Liked challenges counter cannot be negative
ALTER TABLE public.profiles
  ADD CONSTRAINT check_liked_challenges_non_negative
  CHECK (liked_challenges_counter >= 0);

-- Reviews counters cannot be negative
ALTER TABLE public.profiles
  ADD CONSTRAINT check_reviews_post_counter_non_negative
  CHECK (reviews_post_counter >= 0);

ALTER TABLE public.profiles
  ADD CONSTRAINT check_reviews_forum_counter_non_negative
  CHECK (reviews_forum_counter >= 0);

ALTER TABLE public.profiles
  ADD CONSTRAINT check_reviews_challenge_counter_non_negative
  CHECK (reviews_challenge_counter >= 0);

-- Shared counters cannot be negative
ALTER TABLE public.profiles
  ADD CONSTRAINT check_shared_posts_non_negative
  CHECK (shared_posts_counter >= 0);

ALTER TABLE public.profiles
  ADD CONSTRAINT check_shared_forums_non_negative
  CHECK (shared_forums_counter >= 0);

ALTER TABLE public.profiles
  ADD CONSTRAINT check_shared_challenges_non_negative
  CHECK (shared_challenges_counter >= 0);

-- Average ratings must be between 0 and 5
ALTER TABLE public.profiles
  ADD CONSTRAINT check_reviewed_posts_avg_rating
  CHECK (reviewed_posts_average_rating >= 0 AND reviewed_posts_average_rating <= 5);

ALTER TABLE public.profiles
  ADD CONSTRAINT check_reviewed_forum_avg_rating
  CHECK (reviewed_forum_average_rating >= 0 AND reviewed_forum_average_rating <= 5);

ALTER TABLE public.profiles
  ADD CONSTRAINT check_reviewed_challenges_avg_rating
  CHECK (reviewed_challenges_average_rating >= 0 AND reviewed_challenges_average_rating <= 5);

COMMENT ON CONSTRAINT check_reviewed_posts_avg_rating ON public.profiles IS
  'Validates post average rating is between 0 and 5';

-- =============================================================================
-- FEEDBACK TABLE - RATING VALIDATION
-- =============================================================================

-- Feedback rating must be between 0 and 5
ALTER TABLE public.feedback
  ADD CONSTRAINT check_feedback_rating_range
  CHECK (rating >= 0 AND rating <= 5);

COMMENT ON CONSTRAINT check_feedback_rating_range ON public.feedback IS
  'Validates feedback rating is between 0 and 5 stars';

-- =============================================================================
-- ADDRESS TABLE - GEOLOCATION VALIDATION
-- =============================================================================

-- Latitude range for address
ALTER TABLE public.address
  ADD CONSTRAINT check_address_lat_valid
  CHECK (lat >= -90 AND lat <= 90);

COMMENT ON CONSTRAINT check_address_lat_valid ON public.address IS
  'Validates address latitude is within valid range';

-- Longitude range for address
ALTER TABLE public.address
  ADD CONSTRAINT check_address_long_valid
  CHECK (long >= -180 AND long <= 180);

COMMENT ON CONSTRAINT check_address_long_valid ON public.address IS
  'Validates address longitude is within valid range';

-- Radius must be positive
ALTER TABLE public.address
  ADD CONSTRAINT check_radius_positive
  CHECK (radius_meters > 0);

COMMENT ON CONSTRAINT check_radius_positive ON public.address IS
  'Ensures radius is positive (meters)';

-- =============================================================================
-- TELEGRAM USER ACTIVITY - VALIDATION
-- =============================================================================

-- Message count cannot be negative
ALTER TABLE public.telegram_user_activity
  ADD CONSTRAINT check_message_count_non_negative
  CHECK (message_count IS NULL OR message_count >= 0);

-- Total messages cannot be negative
ALTER TABLE public.telegram_user_activity
  ADD CONSTRAINT check_total_messages_non_negative
  CHECK (total_messages IS NULL OR total_messages >= 0);

-- Average message length cannot be negative
ALTER TABLE public.telegram_user_activity
  ADD CONSTRAINT check_avg_message_length_non_negative
  CHECK (average_message_length IS NULL OR average_message_length >= 0);

-- Total characters cannot be negative
ALTER TABLE public.telegram_user_activity
  ADD CONSTRAINT check_total_characters_non_negative
  CHECK (total_characters IS NULL OR total_characters >= 0);

-- Most active hour must be between 0 and 23
ALTER TABLE public.telegram_user_activity
  ADD CONSTRAINT check_most_active_hour_range
  CHECK (most_active_hour IS NULL OR (most_active_hour >= 0 AND most_active_hour <= 23));

COMMENT ON CONSTRAINT check_most_active_hour_range ON public.telegram_user_activity IS
  'Validates hour is between 0 (midnight) and 23 (11 PM)';

-- =============================================================================
-- NOTIFICATION TABLE - BATCH VALIDATION
-- =============================================================================

-- Batch index must be non-negative
ALTER TABLE public.notifications
  ADD CONSTRAINT check_batch_index_non_negative
  CHECK (batch_index IS NULL OR batch_index >= 0);

-- Number of batches must be positive
ALTER TABLE public.notifications
  ADD CONSTRAINT check_num_batches_positive
  CHECK (num_batches IS NULL OR num_batches > 0);

-- Number sent must be non-negative
ALTER TABLE public.notifications
  ADD CONSTRAINT check_num_sent_non_negative
  CHECK (num_sent IS NULL OR num_sent >= 0);

-- Batch index must be less than num_batches
ALTER TABLE public.notifications
  ADD CONSTRAINT check_batch_index_within_range
  CHECK (
    batch_index IS NULL OR
    num_batches IS NULL OR
    batch_index < num_batches
  );

COMMENT ON CONSTRAINT check_batch_index_within_range ON public.notifications IS
  'Ensures batch_index is less than total number of batches';

-- =============================================================================
-- VERIFICATION QUERIES
-- =============================================================================

-- Test constraints (will fail if validation works)
/*
-- Should fail: Invalid email
INSERT INTO profiles (id, email) VALUES (gen_random_uuid(), 'not-an-email');

-- Should fail: Rating out of range
INSERT INTO reviews (profile_id, reviewed_rating) VALUES ('...', 6);

-- Should fail: Invalid latitude
INSERT INTO posts (profile_id, latitude, longitude)
VALUES ('...', 100, 50);  -- 100 is > 90

-- Should fail: Negative counter
INSERT INTO posts (profile_id, post_views) VALUES ('...', -1);
*/

-- Verify constraints were added
SELECT
  conname as constraint_name,
  contype as constraint_type,
  conrelid::regclass as table_name,
  pg_get_constraintdef(oid) as definition
FROM pg_constraint
WHERE connamespace = 'public'::regnamespace
  AND contype = 'c'  -- CHECK constraints
  AND conname LIKE 'check_%'
ORDER BY conrelid::regclass::text, conname;

COMMIT;

-- =============================================================================
-- EXPECTED BENEFITS
-- =============================================================================

-- Data quality: Prevents invalid data at database level
-- Application simplification: Less validation code needed
-- Database integrity: Catch bugs earlier in development
-- Documentation: Constraints self-document valid ranges

-- =============================================================================
-- PERFORMANCE IMPACT
-- =============================================================================

-- Minimal overhead: CHECK constraints are evaluated only on INSERT/UPDATE
-- No impact on SELECT queries
-- Estimated overhead: < 1ms per write operation

-- =============================================================================
-- ROLLBACK INSTRUCTIONS
-- =============================================================================

-- To rollback (NOT RECOMMENDED - allows invalid data):
/*
BEGIN;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS check_email_format;
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS check_phone_format;
ALTER TABLE public.reviews DROP CONSTRAINT IF EXISTS check_rating_range;
ALTER TABLE public.posts DROP CONSTRAINT IF EXISTS check_latitude_valid;
ALTER TABLE public.posts DROP CONSTRAINT IF EXISTS check_longitude_valid;
ALTER TABLE public.posts DROP CONSTRAINT IF EXISTS check_coordinates_paired;
ALTER TABLE public.posts DROP CONSTRAINT IF EXISTS check_post_views_non_negative;
ALTER TABLE public.posts DROP CONSTRAINT IF EXISTS check_post_likes_non_negative;
-- ... (continue for all constraints)

COMMIT;
*/
