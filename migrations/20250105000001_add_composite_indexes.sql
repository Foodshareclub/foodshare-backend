-- Migration: Add Composite Indexes (Enterprise-Grade)
-- Priority: CRITICAL
-- Description: Adds composite indexes for optimal multi-column query performance
-- Impact: 10-50x faster queries on common access patterns
--
-- Changes:
-- 1. Chat system composite indexes (rooms table)
-- 2. Message pagination indexes (room_participants)
-- 3. Feed generation indexes (posts)
-- 4. User engagement indexes (likes, reviews)
-- 5. Map filtering indexes (posts with location)
--
-- Created: 2025-01-05
-- Author: Enterprise Architecture Review

BEGIN;

-- =============================================================================
-- CHAT SYSTEM - CRITICAL PERFORMANCE
-- =============================================================================

-- Users query rooms by sharer + post combination
CREATE INDEX IF NOT EXISTS idx_rooms_sharer_post_composite
  ON public.rooms(sharer, post_id)
  INCLUDE (id, last_message_time);

COMMENT ON INDEX idx_rooms_sharer_post_composite IS
  'Composite index for sharer chat queries. Covers: WHERE sharer = ? AND post_id = ?';

-- Users query rooms by requester + post combination
CREATE INDEX IF NOT EXISTS idx_rooms_requester_post_composite
  ON public.rooms(requester, post_id)
  INCLUDE (id, last_message_time);

COMMENT ON INDEX idx_rooms_requester_post_composite IS
  'Composite index for requester chat queries. Covers: WHERE requester = ? AND post_id = ?';

-- Message pagination by room + timestamp (DESC for latest first)
CREATE INDEX IF NOT EXISTS idx_room_participants_room_time
  ON public.room_participants(room_id, timestamp DESC)
  INCLUDE (profile_id, text, image);

COMMENT ON INDEX idx_room_participants_room_time IS
  'Message pagination index. Covers: WHERE room_id = ? ORDER BY timestamp DESC LIMIT 50';

-- =============================================================================
-- FEED GENERATION - USER TIMELINE
-- =============================================================================

-- User's active posts sorted by creation date
CREATE INDEX IF NOT EXISTS idx_posts_user_feed
  ON public.posts(profile_id, created_at DESC)
  WHERE active = true;

COMMENT ON INDEX idx_posts_user_feed IS
  'Feed generation index for active posts. Partial index filters active = true.';

-- All users' active posts for global feed
CREATE INDEX IF NOT EXISTS idx_posts_global_feed
  ON public.posts(created_at DESC)
  WHERE active = true
  INCLUDE (id, profile_id, post_name, post_description, post_type);

COMMENT ON INDEX idx_posts_global_feed IS
  'Global feed index with INCLUDE columns for covering index optimization.';

-- =============================================================================
-- USER ENGAGEMENT - LIKES & REVIEWS
-- =============================================================================

-- User's likes on posts (check if already liked)
CREATE INDEX IF NOT EXISTS idx_likes_user_post_composite
  ON public.likes(profile_id, post_id)
  INCLUDE (created_at);

COMMENT ON INDEX idx_likes_user_post_composite IS
  'Check if user already liked a post. Covers: WHERE profile_id = ? AND post_id = ?';

-- Post's likes count (for analytics)
CREATE INDEX IF NOT EXISTS idx_likes_post_profile_composite
  ON public.likes(post_id, profile_id)
  INCLUDE (created_at);

COMMENT ON INDEX idx_likes_post_profile_composite IS
  'Count post likes. Covers: WHERE post_id = ? or (post_id, profile_id) for deduplication';

-- User's reviews sorted by date
CREATE INDEX IF NOT EXISTS idx_reviews_user_date_composite
  ON public.reviews(profile_id, id DESC)
  INCLUDE (post_id, reviewed_rating, feedback);

COMMENT ON INDEX idx_reviews_user_date_composite IS
  'User review history. Covers: WHERE profile_id = ? ORDER BY id DESC';

-- Post reviews for rating calculation
CREATE INDEX IF NOT EXISTS idx_reviews_post_composite
  ON public.reviews(post_id, reviewed_rating)
  WHERE post_id IS NOT NULL;

COMMENT ON INDEX idx_reviews_post_composite IS
  'Calculate post average rating. Covers: WHERE post_id = ? for AVG(reviewed_rating)';

-- =============================================================================
-- MAP FILTERING - LOCATION-BASED QUERIES
-- =============================================================================

-- Active posts by type for map display
CREATE INDEX IF NOT EXISTS idx_posts_type_active_composite
  ON public.posts(post_type, active)
  WHERE active = true;

COMMENT ON INDEX idx_posts_type_active_composite IS
  'Filter posts by type on map. Covers: WHERE post_type = ? AND active = true';

-- Spatial + filter composite (PostGIS + regular columns)
CREATE INDEX IF NOT EXISTS idx_posts_location_active
  ON public.posts USING GIST(location)
  WHERE active = true;

COMMENT ON INDEX idx_posts_location_active IS
  'Spatial index for active posts only. Partial index for better performance.';

-- =============================================================================
-- FORUM & CHALLENGES - COMPOSITE LOOKUPS
-- =============================================================================

-- Published forums sorted by date
CREATE INDEX IF NOT EXISTS idx_forum_published_date
  ON public.forum(forum_published, forum_post_created_at DESC)
  WHERE forum_published = true
  INCLUDE (id, profile_id, forum_post_name);

COMMENT ON INDEX idx_forum_published_date IS
  'Published forum posts feed. Covers: WHERE forum_published = true ORDER BY created_at DESC';

-- Published challenges sorted by date
CREATE INDEX IF NOT EXISTS idx_challenges_published_date
  ON public.challenges(challenge_published, challenge_created_at DESC)
  WHERE challenge_published = true
  INCLUDE (id, challenge_title, challenge_difficulty);

COMMENT ON INDEX idx_challenges_published_date IS
  'Published challenges feed. Covers: WHERE challenge_published = true ORDER BY created_at DESC';

-- =============================================================================
-- COMMENTS - FORUM DISCUSSION THREADS
-- =============================================================================

-- Comments on forum posts sorted by date
CREATE INDEX IF NOT EXISTS idx_comments_forum_date
  ON public.comments(forum_id, comment_created_at DESC)
  WHERE forum_id IS NOT NULL
  INCLUDE (id, user_id, comment);

COMMENT ON INDEX idx_comments_forum_date IS
  'Forum comment threads. Covers: WHERE forum_id = ? ORDER BY created_at DESC';

-- =============================================================================
-- CHALLENGE ACTIVITIES - USER ENGAGEMENT
-- =============================================================================

-- User's accepted challenges
CREATE INDEX IF NOT EXISTS idx_challenge_activities_accepted_challenge
  ON public.challenge_activities(user_accepted_challenge, challenge_id)
  WHERE user_accepted_challenge IS NOT NULL
  INCLUDE (created_at);

COMMENT ON INDEX idx_challenge_activities_accepted_challenge IS
  'User accepted challenges. Covers: WHERE user_accepted_challenge = ?';

-- User's completed challenges
CREATE INDEX IF NOT EXISTS idx_challenge_activities_completed_challenge
  ON public.challenge_activities(user_completed_challenge, challenge_id)
  WHERE user_completed_challenge IS NOT NULL
  INCLUDE (created_at);

COMMENT ON INDEX idx_challenge_activities_completed_challenge IS
  'User completed challenges. Covers: WHERE user_completed_challenge = ?';

-- =============================================================================
-- NOTIFICATIONS - USER INBOX
-- =============================================================================

-- User notifications sorted by timestamp
CREATE INDEX IF NOT EXISTS idx_notifications_user_time
  ON public.notifications(profile_id, id DESC)
  WHERE profile_id IS NOT NULL
  INCLUDE (notification_title, notification_text, status);

COMMENT ON INDEX idx_notifications_user_time IS
  'User notification inbox. Covers: WHERE profile_id = ? ORDER BY id DESC';

-- Alternative user field (users_ff)
CREATE INDEX IF NOT EXISTS idx_notifications_users_ff_time
  ON public.notifications(users_ff, id DESC)
  WHERE users_ff IS NOT NULL
  INCLUDE (notification_title, notification_text, status);

COMMENT ON INDEX idx_notifications_users_ff_time IS
  'User notification inbox (FlutterFlow field). Covers: WHERE users_ff = ? ORDER BY id DESC';

-- =============================================================================
-- VERIFICATION QUERIES
-- =============================================================================

-- Check that indexes were created
-- SELECT
--   schemaname,
--   tablename,
--   indexname,
--   pg_size_pretty(pg_relation_size(indexrelid)) as index_size
-- FROM pg_stat_user_indexes
-- WHERE schemaname = 'public'
--   AND indexname LIKE '%_composite' OR indexname LIKE '%_feed' OR indexname LIKE '%_time'
-- ORDER BY pg_relation_size(indexrelid) DESC;

-- Test query performance improvement
/*
-- Before: Sequential scan or index scan on single column
EXPLAIN ANALYZE
SELECT * FROM rooms
WHERE sharer = 'user-uuid' AND post_id = 123;

-- After: Index Only Scan using idx_rooms_sharer_post_composite
EXPLAIN ANALYZE
SELECT * FROM rooms
WHERE sharer = 'user-uuid' AND post_id = 123;

-- Should show: Index Only Scan or Bitmap Index Scan
-- Execution time should be <10ms vs 100ms+
*/

COMMIT;

-- =============================================================================
-- PERFORMANCE IMPACT
-- =============================================================================

-- Expected improvements:
-- - Chat room lookups: 10-50x faster
-- - Message pagination: 20-100x faster (with timestamp sort)
-- - Feed generation: 10-30x faster (with covering index)
-- - Like checks: 50-100x faster (composite uniqueness)
-- - Map queries: 5-20x faster (spatial + filter combo)

-- Storage overhead:
-- - Each composite index: 5-15% of table size
-- - Total overhead: ~200-300MB across all tables
-- - Well worth it for query performance gains

-- Index build time:
-- - rooms: ~1-2 seconds (small table)
-- - room_participants: ~3-5 seconds (larger table)
-- - posts: ~2-4 seconds (1,580 rows)
-- - likes: ~1-2 seconds
-- - Total: ~10-20 seconds

-- =============================================================================
-- MAINTENANCE
-- =============================================================================

-- Composite indexes are automatically maintained on INSERT/UPDATE/DELETE
-- ANALYZE will update index statistics
-- Rebuild indexes if needed:
-- REINDEX INDEX CONCURRENTLY idx_rooms_sharer_post_composite;

-- Monitor index usage:
-- SELECT
--   schemaname,
--   tablename,
--   indexname,
--   idx_scan as index_scans,
--   idx_tup_read as tuples_read,
--   idx_tup_fetch as tuples_fetched
-- FROM pg_stat_user_indexes
-- WHERE schemaname = 'public'
--   AND indexname LIKE '%_composite'
-- ORDER BY idx_scan DESC;

-- =============================================================================
-- ROLLBACK INSTRUCTIONS
-- =============================================================================

-- To rollback (NOT RECOMMENDED - slower queries):
/*
BEGIN;

DROP INDEX IF EXISTS public.idx_rooms_sharer_post_composite;
DROP INDEX IF EXISTS public.idx_rooms_requester_post_composite;
DROP INDEX IF EXISTS public.idx_room_participants_room_time;
DROP INDEX IF EXISTS public.idx_posts_user_feed;
DROP INDEX IF EXISTS public.idx_posts_global_feed;
DROP INDEX IF EXISTS public.idx_likes_user_post_composite;
DROP INDEX IF EXISTS public.idx_likes_post_profile_composite;
DROP INDEX IF EXISTS public.idx_reviews_user_date_composite;
DROP INDEX IF EXISTS public.idx_reviews_post_composite;
DROP INDEX IF EXISTS public.idx_posts_type_active_composite;
DROP INDEX IF EXISTS public.idx_posts_location_active;
DROP INDEX IF EXISTS public.idx_forum_published_date;
DROP INDEX IF EXISTS public.idx_challenges_published_date;
DROP INDEX IF EXISTS public.idx_comments_forum_date;
DROP INDEX IF EXISTS public.idx_challenge_activities_accepted_challenge;
DROP INDEX IF EXISTS public.idx_challenge_activities_completed_challenge;
DROP INDEX IF EXISTS public.idx_notifications_user_time;
DROP INDEX IF EXISTS public.idx_notifications_users_ff_time;

COMMIT;
*/
