-- =============================================================================
-- Performance Indexes Migration
-- =============================================================================
-- Adds optimized indexes for common query patterns identified during analysis.
-- All indexes created CONCURRENTLY to avoid blocking production queries.
-- =============================================================================

-- =============================================================================
-- Posts (Listings) Indexes
-- =============================================================================

-- User's active listings (profile page, my listings)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_profile_active_created
  ON posts(profile_id, is_active, created_at DESC)
  WHERE deleted_at IS NULL;

-- Active listings by category (category browsing)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_category_active
  ON posts(category_id, is_active, created_at DESC)
  WHERE is_active = TRUE AND deleted_at IS NULL;

-- Location-based search (covering index for feed queries)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_location_active
  ON posts(latitude, longitude, is_active, created_at DESC)
  WHERE is_active = TRUE AND deleted_at IS NULL;

-- Post type filtering
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_type_active
  ON posts(post_type, is_active, created_at DESC)
  WHERE deleted_at IS NULL;

-- Expiring listings (for cleanup jobs)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_expires_at
  ON posts(expires_at)
  WHERE is_active = TRUE AND expires_at IS NOT NULL;

-- =============================================================================
-- Notifications Indexes
-- =============================================================================

-- Unread notifications for user (badge counts, notification list)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_recipient_unread
  ON notifications(profile_id, created_at DESC)
  WHERE read_at IS NULL;

-- Notification types for filtering
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_type_recipient
  ON notifications(notification_type, profile_id, created_at DESC);

-- Consolidated notifications lookup
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_consolidation
  ON notifications(profile_id, notification_type, consolidation_key)
  WHERE consolidation_key IS NOT NULL;

-- =============================================================================
-- Rooms (Chat) Indexes
-- =============================================================================

-- User's active rooms with recent activity
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rooms_participant_updated
  ON rooms USING gin(participant_ids)
  WHERE deleted_at IS NULL;

-- Room lookup by participants (for get_or_create_room)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rooms_participants_hash
  ON rooms(md5(array_to_string(participant_ids, ',')))
  WHERE deleted_at IS NULL;

-- Unread messages per room
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rooms_unread
  ON rooms(updated_at DESC)
  WHERE unread_count > 0;

-- =============================================================================
-- Messages Indexes
-- =============================================================================

-- Messages in a room (chat history)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_room_created
  ON messages(room_id, created_at DESC);

-- Unread messages per user
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_room_read
  ON messages(room_id, sender_id, read_at)
  WHERE read_at IS NULL;

-- =============================================================================
-- User Events (Analytics) Indexes
-- =============================================================================

-- User activity timeline
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_events_user_created
  ON user_events(user_id, created_at DESC);

-- Event type aggregation
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_events_type_created
  ON user_events(event_type, created_at DESC);

-- Session-based analytics
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_events_session
  ON user_events(session_id, created_at)
  WHERE session_id IS NOT NULL;

-- =============================================================================
-- Device Tokens Indexes
-- =============================================================================

-- Tokens by user and platform (push notification sending)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_device_tokens_profile_platform
  ON device_tokens(profile_id, platform);

-- Stale token cleanup
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_device_tokens_last_used
  ON device_tokens(last_used_at)
  WHERE last_used_at IS NOT NULL;

-- =============================================================================
-- Profiles Indexes
-- =============================================================================

-- Location-based user search
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_profiles_location
  ON profiles(latitude, longitude)
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL;

-- Active users (for matching)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_profiles_active
  ON profiles(updated_at DESC)
  WHERE is_active = TRUE;

-- =============================================================================
-- Notification Queue Indexes
-- =============================================================================

-- Pending notifications (for processing)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notification_queue_pending
  ON notification_queue(scheduled_for, priority DESC)
  WHERE status = 'pending' AND scheduled_for <= NOW();

-- Failed notifications for retry
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notification_queue_failed
  ON notification_queue(next_retry_at)
  WHERE status = 'failed' AND attempts < max_attempts;

-- Consolidation lookup
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notification_queue_consolidation
  ON notification_queue(user_id, consolidation_key, status)
  WHERE consolidation_key IS NOT NULL;

-- =============================================================================
-- Sync Checkpoints Indexes
-- =============================================================================

-- Delta sync lookups
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sync_checkpoints_user_table
  ON sync_checkpoints(user_id, table_name);

-- =============================================================================
-- Rate Limit Entries Indexes
-- =============================================================================

-- Rate limit lookups (time-based cleanup)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rate_limit_entries_key_created
  ON rate_limit_entries(key, created_at DESC);

-- Cleanup of old entries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rate_limit_entries_expires
  ON rate_limit_entries(expires_at)
  WHERE expires_at IS NOT NULL;

-- =============================================================================
-- Feature Flags Indexes
-- =============================================================================

-- User-specific flag overrides
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_feature_flag_overrides_user
  ON feature_flag_overrides(user_id, flag_key)
  WHERE expires_at IS NULL OR expires_at > NOW();

-- =============================================================================
-- Metrics Indexes
-- =============================================================================

-- Function call metrics (for dashboards)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_metrics_function_calls_name_time
  ON metrics.function_calls(function_name, created_at DESC);

-- Error rate analysis
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_metrics_function_calls_errors
  ON metrics.function_calls(created_at DESC)
  WHERE error IS NOT NULL;

-- =============================================================================
-- Statistics Update
-- =============================================================================

-- Update table statistics for query planner
ANALYZE posts;
ANALYZE notifications;
ANALYZE rooms;
ANALYZE messages;
ANALYZE profiles;
ANALYZE device_tokens;

-- =============================================================================
-- Index Usage Comments
-- =============================================================================

COMMENT ON INDEX idx_posts_profile_active_created IS 'Optimizes user profile listing queries';
COMMENT ON INDEX idx_notifications_recipient_unread IS 'Optimizes unread notification badge counts';
COMMENT ON INDEX idx_rooms_participant_updated IS 'Optimizes room list queries for users';
COMMENT ON INDEX idx_user_events_user_created IS 'Optimizes user activity timeline queries';
