-- Migration: Performance Optimization Indexes
-- Purpose: Add composite and partial indexes for common query patterns
-- Note: Use CONCURRENTLY to avoid locking tables in production

-- =============================================================================
-- Posts Table Indexes (Feed Performance)
-- =============================================================================

-- Composite index for active posts with location (feed queries)
-- Note: Using gist for location requires PostGIS extension
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_active_location
    ON posts USING gist (location)
    WHERE status = 'active' AND deleted_at IS NULL;

-- Index for user's posts sorted by creation date
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_user_created
    ON posts (user_id, created_at DESC)
    WHERE deleted_at IS NULL;

-- Index for posts by status and type
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_status_type
    ON posts (status, post_type, created_at DESC)
    WHERE deleted_at IS NULL;

-- Index for expiring posts (for cleanup jobs)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_expires
    ON posts (expires_at)
    WHERE status = 'active' AND expires_at IS NOT NULL;

-- =============================================================================
-- Messaging Indexes (Chat Performance)
-- =============================================================================

-- Index for room participants lookup
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_room_participants_room_user
    ON room_participants (room_id, user_id)
    WHERE deleted_at IS NULL;

-- Index for user's rooms sorted by last message
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rooms_user_updated
    ON rooms (updated_at DESC)
    WHERE deleted_at IS NULL;

-- Index for unread message counts
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_room_participants_unread
    ON room_participants (user_id, read_at)
    WHERE deleted_at IS NULL AND read_at IS NULL;

-- =============================================================================
-- Profile Indexes (User Discovery)
-- =============================================================================

-- Index for active profiles
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_profiles_active
    ON profiles (created_at DESC)
    WHERE deleted_at IS NULL;

-- Index for profile search by display name (case-insensitive)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_profiles_display_name_lower
    ON profiles (lower(display_name))
    WHERE deleted_at IS NULL;

-- =============================================================================
-- Reviews and Ratings Indexes
-- =============================================================================

-- Index for user's received reviews
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reviews_reviewee
    ON reviews (reviewee_id, created_at DESC)
    WHERE deleted_at IS NULL;

-- Index for calculating average ratings
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reviews_rating_calc
    ON reviews (reviewee_id, rating)
    WHERE deleted_at IS NULL;

-- =============================================================================
-- Notifications Indexes
-- =============================================================================

-- Index for user's unread notifications
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_user_unread
    ON notifications (user_id, created_at DESC)
    WHERE read_at IS NULL;

-- Index for notification cleanup
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_created
    ON notifications (created_at)
    WHERE read_at IS NOT NULL;

-- =============================================================================
-- Forum Indexes
-- =============================================================================

-- Index for published forum posts
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_forum_published
    ON forum (status, created_at DESC)
    WHERE status = 'published' AND deleted_at IS NULL;

-- Index for forum by category
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_forum_category
    ON forum (category, created_at DESC)
    WHERE status = 'published' AND deleted_at IS NULL;

-- =============================================================================
-- Challenge Indexes
-- =============================================================================

-- Index for active challenges
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_challenges_active
    ON challenges (start_date, end_date)
    WHERE status = 'active';

-- Index for challenge activities
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_challenge_activities_user
    ON challenge_activities (user_id, challenge_id, created_at DESC);

-- =============================================================================
-- Likes Indexes
-- =============================================================================

-- Index for counting likes on posts
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_likes_post
    ON likes (post_id)
    WHERE deleted_at IS NULL;

-- Index for user's liked posts
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_likes_user
    ON likes (user_id, created_at DESC)
    WHERE deleted_at IS NULL;

-- =============================================================================
-- Views/Analytics Indexes
-- =============================================================================

-- Index for view counting (if views table exists)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'views') THEN
        EXECUTE 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_views_post_time ON views (post_id, created_at)';
        EXECUTE 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_views_user_post ON views (user_id, post_id) WHERE user_id IS NOT NULL';
    END IF;
END
$$;

-- =============================================================================
-- Security Tables Indexes (from earlier migration)
-- =============================================================================

-- Ensure security indexes exist
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_login_attempts_email_recent
    ON security.login_attempts (email, created_at DESC)
    WHERE created_at > now() - interval '24 hours';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_account_lockouts_active
    ON security.account_lockouts (email)
    WHERE locked_until > now();

-- =============================================================================
-- Audit Log Indexes
-- =============================================================================

-- Index for vault access audit log
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema = 'audit' AND table_name = 'vault_access_log') THEN
        EXECUTE 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vault_access_user_time
                 ON audit.vault_access_log (user_id, created_at DESC)';
        EXECUTE 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vault_access_secret_time
                 ON audit.vault_access_log (secret_name, created_at DESC)';
        EXECUTE 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vault_access_failed
                 ON audit.vault_access_log (created_at DESC)
                 WHERE access_result != ''success''';
    END IF;
END
$$;

-- =============================================================================
-- Device Tokens Index
-- =============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_device_tokens_user
    ON device_tokens (user_id, updated_at DESC)
    WHERE deleted_at IS NULL;

-- =============================================================================
-- Feature Flags Index (if table exists)
-- =============================================================================

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'feature_flags') THEN
        EXECUTE 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_feature_flags_active
                 ON feature_flags (key)
                 WHERE enabled = true AND (expires_at IS NULL OR expires_at > now())';
    END IF;
END
$$;

-- =============================================================================
-- Analyze Tables for Query Planner
-- =============================================================================
-- Run ANALYZE on frequently queried tables to update statistics

ANALYZE posts;
ANALYZE profiles;
ANALYZE rooms;
ANALYZE room_participants;
ANALYZE notifications;
ANALYZE reviews;
ANALYZE likes;
ANALYZE forum;
ANALYZE challenges;

-- Analyze security tables if they exist
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema = 'security' AND table_name = 'login_attempts') THEN
        EXECUTE 'ANALYZE security.login_attempts';
        EXECUTE 'ANALYZE security.account_lockouts';
    END IF;
END
$$;

-- =============================================================================
-- Comments
-- =============================================================================

COMMENT ON INDEX idx_posts_active_location IS 'Spatial index for nearby posts queries (feed)';
COMMENT ON INDEX idx_posts_user_created IS 'User posts timeline';
COMMENT ON INDEX idx_room_participants_room_user IS 'Fast room membership lookup';
COMMENT ON INDEX idx_notifications_user_unread IS 'Unread notification badge count';
COMMENT ON INDEX idx_reviews_rating_calc IS 'Average rating calculation';
