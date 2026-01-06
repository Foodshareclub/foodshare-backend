-- Unified Notification Delivery System Tables
-- Provides logging, scheduling, preferences, and device management

-- ============================================================================
-- NOTIFICATION DELIVERY LOG
-- Tracks delivery status for all sent notifications
-- ============================================================================

CREATE TABLE IF NOT EXISTS notification_delivery_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    notification_id UUID NOT NULL,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    priority TEXT DEFAULT 'normal' CHECK (priority IN ('critical', 'high', 'normal', 'low')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed', 'scheduled', 'cancelled')),
    delivered_to TEXT[] DEFAULT '{}',
    failed_devices TEXT[] DEFAULT '{}',
    error TEXT,
    scheduled_for TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'
);

-- Indexes for efficient querying
CREATE INDEX idx_notification_delivery_user ON notification_delivery_log(user_id);
CREATE INDEX idx_notification_delivery_status ON notification_delivery_log(status);
CREATE INDEX idx_notification_delivery_type ON notification_delivery_log(type);
CREATE INDEX idx_notification_delivery_created ON notification_delivery_log(created_at DESC);
CREATE INDEX idx_notification_delivery_notification ON notification_delivery_log(notification_id);

-- ============================================================================
-- SCHEDULED NOTIFICATIONS
-- Queue for notifications scheduled for future delivery
-- ============================================================================

CREATE TABLE IF NOT EXISTS scheduled_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payload JSONB NOT NULL,
    scheduled_for TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'cancelled')),
    attempts INTEGER DEFAULT 0,
    last_attempt_at TIMESTAMPTZ,
    error TEXT,
    cancelled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for processing scheduled notifications
CREATE INDEX idx_scheduled_notifications_pending ON scheduled_notifications(scheduled_for)
    WHERE status = 'pending';
CREATE INDEX idx_scheduled_notifications_status ON scheduled_notifications(status);

-- ============================================================================
-- USER DEVICES
-- Stores device tokens for push notifications
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    platform TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
    token TEXT NOT NULL,
    is_active BOOLEAN DEFAULT true,
    app_version TEXT,
    os_version TEXT,
    device_model TEXT,
    last_seen_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, token)
);

-- Indexes
CREATE INDEX idx_user_devices_user ON user_devices(user_id);
CREATE INDEX idx_user_devices_active ON user_devices(user_id, is_active) WHERE is_active = true;
CREATE INDEX idx_user_devices_platform ON user_devices(platform);

-- ============================================================================
-- NOTIFICATION PREFERENCES
-- User-specific notification settings
-- ============================================================================

CREATE TABLE IF NOT EXISTS notification_preferences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
    push_enabled BOOLEAN DEFAULT true,
    email_enabled BOOLEAN DEFAULT true,
    sms_enabled BOOLEAN DEFAULT false,
    quiet_hours_enabled BOOLEAN DEFAULT false,
    quiet_hours_start TIME DEFAULT '22:00',
    quiet_hours_end TIME DEFAULT '08:00',
    quiet_hours_timezone TEXT DEFAULT 'UTC',
    enabled_types TEXT[] DEFAULT ARRAY[
        'new_message',
        'arrangement_confirmed',
        'arrangement_cancelled',
        'challenge_complete',
        'review_received',
        'system_announcement',
        'account_security'
    ],
    type_priorities JSONB DEFAULT '{}',
    prefer_consolidated BOOLEAN DEFAULT false,
    prefer_immediate BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index
CREATE INDEX idx_notification_preferences_user ON notification_preferences(user_id);

-- ============================================================================
-- NOTIFICATION BATCH LOG
-- Tracks batch notification operations
-- ============================================================================

CREATE TABLE IF NOT EXISTS notification_batch_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    total_count INTEGER NOT NULL,
    delivered_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,
    processing_time_ms INTEGER,
    processed_at TIMESTAMPTZ DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'
);

-- Index for analytics
CREATE INDEX idx_notification_batch_processed ON notification_batch_log(processed_at DESC);

-- ============================================================================
-- TOPIC SUBSCRIPTIONS
-- Tracks user subscriptions to notification topics
-- ============================================================================

CREATE TABLE IF NOT EXISTS notification_topic_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    topic TEXT NOT NULL,
    subscribed_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, topic)
);

-- Index
CREATE INDEX idx_topic_subscriptions_user ON notification_topic_subscriptions(user_id);
CREATE INDEX idx_topic_subscriptions_topic ON notification_topic_subscriptions(topic);

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

ALTER TABLE notification_delivery_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_batch_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_topic_subscriptions ENABLE ROW LEVEL SECURITY;

-- Users can view their own notification history
CREATE POLICY "Users can view own notifications"
    ON notification_delivery_log FOR SELECT
    USING (auth.uid() = user_id);

-- Users can manage their own devices
CREATE POLICY "Users can view own devices"
    ON user_devices FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own devices"
    ON user_devices FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own devices"
    ON user_devices FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own devices"
    ON user_devices FOR DELETE
    USING (auth.uid() = user_id);

-- Users can manage their own preferences
CREATE POLICY "Users can view own preferences"
    ON notification_preferences FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own preferences"
    ON notification_preferences FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own preferences"
    ON notification_preferences FOR UPDATE
    USING (auth.uid() = user_id);

-- Users can manage their topic subscriptions
CREATE POLICY "Users can view own subscriptions"
    ON notification_topic_subscriptions FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own subscriptions"
    ON notification_topic_subscriptions FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own subscriptions"
    ON notification_topic_subscriptions FOR DELETE
    USING (auth.uid() = user_id);

-- Service role bypass for Edge Functions
CREATE POLICY "Service role full access to delivery log"
    ON notification_delivery_log FOR ALL
    USING (auth.jwt()->>'role' = 'service_role');

CREATE POLICY "Service role full access to scheduled"
    ON scheduled_notifications FOR ALL
    USING (auth.jwt()->>'role' = 'service_role');

CREATE POLICY "Service role full access to batch log"
    ON notification_batch_log FOR ALL
    USING (auth.jwt()->>'role' = 'service_role');

-- ============================================================================
-- FUNCTIONS
-- ============================================================================

-- Function to clean up old notification logs (retention: 90 days)
CREATE OR REPLACE FUNCTION cleanup_old_notification_logs()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM notification_delivery_log
    WHERE created_at < NOW() - INTERVAL '90 days';

    GET DIAGNOSTICS deleted_count = ROW_COUNT;

    DELETE FROM notification_batch_log
    WHERE processed_at < NOW() - INTERVAL '90 days';

    RETURN deleted_count;
END;
$$;

-- Function to process scheduled notifications
CREATE OR REPLACE FUNCTION get_pending_scheduled_notifications(batch_limit INTEGER DEFAULT 100)
RETURNS SETOF scheduled_notifications
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    UPDATE scheduled_notifications
    SET status = 'processing',
        last_attempt_at = NOW(),
        attempts = attempts + 1,
        updated_at = NOW()
    WHERE id IN (
        SELECT id FROM scheduled_notifications
        WHERE status = 'pending'
          AND scheduled_for <= NOW()
        ORDER BY scheduled_for ASC
        LIMIT batch_limit
        FOR UPDATE SKIP LOCKED
    )
    RETURNING *;
END;
$$;

-- Function to mark scheduled notification as sent
CREATE OR REPLACE FUNCTION mark_notification_sent(notification_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE scheduled_notifications
    SET status = 'sent',
        updated_at = NOW()
    WHERE id = notification_id;
END;
$$;

-- Function to mark scheduled notification as failed
CREATE OR REPLACE FUNCTION mark_notification_failed(notification_id UUID, error_message TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE scheduled_notifications
    SET status = CASE
            WHEN attempts >= 3 THEN 'failed'
            ELSE 'pending'
        END,
        error = error_message,
        scheduled_for = CASE
            WHEN attempts >= 3 THEN scheduled_for
            ELSE NOW() + (attempts * INTERVAL '5 minutes')
        END,
        updated_at = NOW()
    WHERE id = notification_id;
END;
$$;

-- Function to register or update device
CREATE OR REPLACE FUNCTION upsert_user_device(
    p_user_id UUID,
    p_platform TEXT,
    p_token TEXT,
    p_app_version TEXT DEFAULT NULL,
    p_os_version TEXT DEFAULT NULL,
    p_device_model TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    device_id UUID;
BEGIN
    INSERT INTO user_devices (user_id, platform, token, app_version, os_version, device_model, last_seen_at)
    VALUES (p_user_id, p_platform, p_token, p_app_version, p_os_version, p_device_model, NOW())
    ON CONFLICT (user_id, token)
    DO UPDATE SET
        is_active = true,
        app_version = COALESCE(EXCLUDED.app_version, user_devices.app_version),
        os_version = COALESCE(EXCLUDED.os_version, user_devices.os_version),
        device_model = COALESCE(EXCLUDED.device_model, user_devices.device_model),
        last_seen_at = NOW(),
        updated_at = NOW()
    RETURNING id INTO device_id;

    RETURN device_id;
END;
$$;

-- Function to deactivate stale devices (not seen in 30 days)
CREATE OR REPLACE FUNCTION deactivate_stale_devices()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    deactivated_count INTEGER;
BEGIN
    UPDATE user_devices
    SET is_active = false,
        updated_at = NOW()
    WHERE is_active = true
      AND last_seen_at < NOW() - INTERVAL '30 days';

    GET DIAGNOSTICS deactivated_count = ROW_COUNT;

    RETURN deactivated_count;
END;
$$;

-- Function to get user notification stats
CREATE OR REPLACE FUNCTION get_notification_stats(p_user_id UUID)
RETURNS TABLE (
    total_sent BIGINT,
    total_delivered BIGINT,
    total_failed BIGINT,
    delivery_rate NUMERIC,
    by_type JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT
        COUNT(*)::BIGINT as total_sent,
        COUNT(*) FILTER (WHERE status = 'delivered')::BIGINT as total_delivered,
        COUNT(*) FILTER (WHERE status = 'failed')::BIGINT as total_failed,
        ROUND(
            COUNT(*) FILTER (WHERE status = 'delivered')::NUMERIC /
            NULLIF(COUNT(*), 0) * 100,
            2
        ) as delivery_rate,
        jsonb_object_agg(
            type,
            jsonb_build_object(
                'count', type_count,
                'delivered', delivered_count
            )
        ) as by_type
    FROM notification_delivery_log
    LEFT JOIN LATERAL (
        SELECT
            ndl.type,
            COUNT(*) as type_count,
            COUNT(*) FILTER (WHERE ndl.status = 'delivered') as delivered_count
        FROM notification_delivery_log ndl
        WHERE ndl.user_id = p_user_id
        GROUP BY ndl.type
    ) type_stats ON true
    WHERE user_id = p_user_id
      AND created_at > NOW() - INTERVAL '30 days';
END;
$$;

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_notification_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

CREATE TRIGGER scheduled_notifications_updated_at
    BEFORE UPDATE ON scheduled_notifications
    FOR EACH ROW
    EXECUTE FUNCTION update_notification_updated_at();

CREATE TRIGGER user_devices_updated_at
    BEFORE UPDATE ON user_devices
    FOR EACH ROW
    EXECUTE FUNCTION update_notification_updated_at();

CREATE TRIGGER notification_preferences_updated_at
    BEFORE UPDATE ON notification_preferences
    FOR EACH ROW
    EXECUTE FUNCTION update_notification_updated_at();

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE notification_delivery_log IS 'Tracks all notification delivery attempts and outcomes';
COMMENT ON TABLE scheduled_notifications IS 'Queue for notifications scheduled for future delivery';
COMMENT ON TABLE user_devices IS 'Push notification tokens for user devices across platforms';
COMMENT ON TABLE notification_preferences IS 'User-specific notification settings and preferences';
COMMENT ON TABLE notification_batch_log IS 'Analytics for batch notification operations';
COMMENT ON TABLE notification_topic_subscriptions IS 'User subscriptions to notification topics';
