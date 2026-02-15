-- Add composite indexes for high-traffic query patterns
-- All indexes created CONCURRENTLY to avoid blocking production queries

-- Chat pagination (messages by room, ordered by time)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_room_created
  ON messages(room_id, created_at DESC);

-- Unread tracking (room members by profile, ordered by last read)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_room_members_profile_read
  ON room_members(profile_id, last_read_at DESC);

-- Engagement checks (likes by post + user for fast lookup)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_post_likes_composite
  ON post_likes(post_id, profile_id);

-- Bookmark queries (user bookmarks ordered by time)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_post_bookmarks_user_time
  ON post_bookmarks(profile_id, created_at DESC);

-- Product filtering (active posts by category, ordered by time)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_category_active_time
  ON posts(category_id, is_active, created_at DESC)
  WHERE is_active = true;

-- User's active posts (ordered by time)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_user_active_time
  ON posts(profile_id, is_active, created_at DESC)
  WHERE is_active = true;

-- Notification delivery log (ordered by creation time)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notification_delivery_created
  ON notification_delivery_log(created_at);
