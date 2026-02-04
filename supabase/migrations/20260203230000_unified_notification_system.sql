-- Unified Notification System Tables
-- Supports email, push, SMS, and in-app notifications with comprehensive tracking

-- =============================================================================
-- notification_delivery_log
-- Central log for all notification deliveries across all channels
-- =============================================================================

CREATE TABLE IF NOT EXISTS notification_delivery_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    notification_id UUID NOT NULL,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    channels JSONB NOT NULL DEFAULT '[]'::jsonb,
    status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed', 'scheduled')),
    delivered_at TIMESTAMPTZ,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_notification_delivery_log_user_id
    ON notification_delivery_log(user_id);
CREATE INDEX IF NOT EXISTS idx_notification_delivery_log_notification_id
    ON notification_delivery_log(notification_id);
CREATE INDEX IF NOT EXISTS idx_notification_delivery_log_status
    ON notification_delivery_log(status);
CREATE INDEX IF NOT EXISTS idx_notification_delivery_log_created_at
    ON notification_delivery_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_delivery_log_type
    ON notification_delivery_log(type);

-- RLS Policies
ALTER TABLE notification_delivery_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own notification logs"
    ON notification_delivery_log
    FOR SELECT
    USING (auth.uid() = user_id);

-- Service role can do everything
CREATE POLICY "Service role can manage notification logs"
    ON notification_delivery_log
    FOR ALL
    USING (auth.jwt()->>'role' = 'service_role')
    WITH CHECK (auth.jwt()->>'role' = 'service_role');

-- =============================================================================
-- notification_queue
-- Queue for scheduled and delayed notifications
-- =============================================================================

CREATE TABLE IF NOT EXISTS notification_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'delivered', 'failed', 'cancelled')),
    scheduled_for TIMESTAMPTZ,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_notification_queue_user_id
    ON notification_queue(user_id);
CREATE INDEX IF NOT EXISTS idx_notification_queue_status
    ON notification_queue(status);
CREATE INDEX IF NOT EXISTS idx_notification_queue_scheduled_for
    ON notification_queue(scheduled_for)
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_notification_queue_created_at
    ON notification_queue(created_at DESC);

-- RLS Policies
ALTER TABLE notification_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own queued notifications"
    ON notification_queue
    FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Service role can manage notification queue"
    ON notification_queue
    FOR ALL
    USING (auth.jwt()->>'role' = 'service_role')
    WITH CHECK (auth.jwt()->>'role' = 'service_role');

-- =============================================================================
-- notification_digest_queue
-- Queue for digest batching (hourly, daily, weekly)
-- =============================================================================

CREATE TABLE IF NOT EXISTS notification_digest_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    notification_type TEXT NOT NULL,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    frequency TEXT NOT NULL CHECK (frequency IN ('hourly', 'daily', 'weekly')),
    scheduled_for TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_notification_digest_queue_user_id
    ON notification_digest_queue(user_id);
CREATE INDEX IF NOT EXISTS idx_notification_digest_queue_frequency_status
    ON notification_digest_queue(frequency, status);
CREATE INDEX IF NOT EXISTS idx_notification_digest_queue_scheduled_for
    ON notification_digest_queue(scheduled_for)
    WHERE status = 'pending';

-- RLS Policies
ALTER TABLE notification_digest_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can manage digest queue"
    ON notification_digest_queue
    FOR ALL
    USING (auth.jwt()->>'role' = 'service_role')
    WITH CHECK (auth.jwt()->>'role' = 'service_role');

-- =============================================================================
-- in_app_notifications
-- Storage for in-app notifications delivered via Supabase Realtime
-- =============================================================================

CREATE TABLE IF NOT EXISTS in_app_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    data JSONB DEFAULT '{}'::jsonb,
    image_url TEXT,
    action_url TEXT,
    category TEXT NOT NULL DEFAULT 'system',
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_in_app_notifications_user_id
    ON in_app_notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_in_app_notifications_user_id_unread
    ON in_app_notifications(user_id)
    WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_in_app_notifications_created_at
    ON in_app_notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_in_app_notifications_category
    ON in_app_notifications(category);

-- RLS Policies
ALTER TABLE in_app_notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own in-app notifications"
    ON in_app_notifications
    FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can update their own in-app notifications"
    ON in_app_notifications
    FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Service role can insert in-app notifications"
    ON in_app_notifications
    FOR INSERT
    WITH CHECK (auth.jwt()->>'role' = 'service_role');

-- =============================================================================
-- email_suppressions
-- Email addresses that should not receive emails (bounces, complaints, unsubscribes)
-- =============================================================================

CREATE TABLE IF NOT EXISTS email_suppressions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL UNIQUE,
    reason TEXT NOT NULL,
    source TEXT, -- bounce, complaint, unsubscribe, manual
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_email_suppressions_email
    ON email_suppressions(email);
CREATE INDEX IF NOT EXISTS idx_email_suppressions_expires_at
    ON email_suppressions(expires_at)
    WHERE expires_at IS NOT NULL;

-- RLS Policies
ALTER TABLE email_suppressions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can manage email suppressions"
    ON email_suppressions
    FOR ALL
    USING (auth.jwt()->>'role' = 'service_role')
    WITH CHECK (auth.jwt()->>'role' = 'service_role');

-- =============================================================================
-- Helper Functions
-- =============================================================================

-- Drop existing functions first to allow return type changes
DROP FUNCTION IF EXISTS get_pending_digest_notifications(TEXT, INTEGER);
DROP FUNCTION IF EXISTS mark_digest_notifications_sent(UUID[]);
DROP FUNCTION IF EXISTS get_unread_notification_count(UUID);
DROP FUNCTION IF EXISTS mark_all_notifications_read(UUID);
DROP FUNCTION IF EXISTS cleanup_old_notifications();

-- Function to get pending digest notifications grouped by user
CREATE OR REPLACE FUNCTION get_pending_digest_notifications(
    p_frequency TEXT,
    p_limit INTEGER DEFAULT 100
)
RETURNS TABLE (
    user_id UUID,
    items JSONB,
    item_count INTEGER
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        ndq.user_id,
        jsonb_agg(
            jsonb_build_object(
                'id', ndq.id,
                'type', ndq.notification_type,
                'category', ndq.category,
                'title', ndq.title,
                'body', ndq.body,
                'data', ndq.data,
                'created_at', ndq.created_at
            ) ORDER BY ndq.created_at DESC
        ) AS items,
        COUNT(*)::INTEGER AS item_count
    FROM notification_digest_queue ndq
    WHERE ndq.frequency = p_frequency
        AND ndq.status = 'pending'
        AND ndq.scheduled_for <= NOW()
    GROUP BY ndq.user_id
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to mark digest notifications as sent
CREATE OR REPLACE FUNCTION mark_digest_notifications_sent(
    p_notification_ids UUID[]
)
RETURNS VOID AS $$
BEGIN
    UPDATE notification_digest_queue
    SET
        status = 'sent',
        sent_at = NOW()
    WHERE id = ANY(p_notification_ids);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to get unread in-app notification count
CREATE OR REPLACE FUNCTION get_unread_notification_count(
    p_user_id UUID
)
RETURNS INTEGER AS $$
DECLARE
    v_count INTEGER;
BEGIN
    SELECT COUNT(*)::INTEGER INTO v_count
    FROM in_app_notifications
    WHERE user_id = p_user_id
        AND read_at IS NULL;

    RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to mark all in-app notifications as read
CREATE OR REPLACE FUNCTION mark_all_notifications_read(
    p_user_id UUID
)
RETURNS VOID AS $$
BEGIN
    UPDATE in_app_notifications
    SET read_at = NOW()
    WHERE user_id = p_user_id
        AND read_at IS NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to cleanup old notifications
CREATE OR REPLACE FUNCTION cleanup_old_notifications()
RETURNS VOID AS $$
BEGIN
    -- Delete delivered notifications older than 90 days
    DELETE FROM notification_delivery_log
    WHERE created_at < NOW() - INTERVAL '90 days'
        AND status = 'delivered';

    -- Delete failed notifications older than 30 days
    DELETE FROM notification_delivery_log
    WHERE created_at < NOW() - INTERVAL '30 days'
        AND status = 'failed';

    -- Delete old queue items
    DELETE FROM notification_queue
    WHERE created_at < NOW() - INTERVAL '30 days'
        AND status IN ('delivered', 'failed', 'cancelled');

    -- Delete sent digest items older than 7 days
    DELETE FROM notification_digest_queue
    WHERE created_at < NOW() - INTERVAL '7 days'
        AND status = 'sent';

    -- Delete read in-app notifications older than 30 days
    DELETE FROM in_app_notifications
    WHERE read_at < NOW() - INTERVAL '30 days';

    -- Delete expired email suppressions
    DELETE FROM email_suppressions
    WHERE expires_at IS NOT NULL
        AND expires_at < NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- Triggers
-- =============================================================================

-- Update timestamp trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_notification_delivery_log_updated_at
    BEFORE UPDATE ON notification_delivery_log
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_notification_queue_updated_at
    BEFORE UPDATE ON notification_queue
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- =============================================================================
-- Comments
-- =============================================================================

COMMENT ON TABLE notification_delivery_log IS 'Central log for all notification deliveries across all channels';
COMMENT ON TABLE notification_queue IS 'Queue for scheduled and delayed notifications';
COMMENT ON TABLE notification_digest_queue IS 'Queue for digest batching (hourly, daily, weekly)';
COMMENT ON TABLE in_app_notifications IS 'Storage for in-app notifications delivered via Supabase Realtime';
COMMENT ON TABLE email_suppressions IS 'Email addresses that should not receive emails';

COMMENT ON FUNCTION get_pending_digest_notifications IS 'Get pending digest notifications grouped by user';
COMMENT ON FUNCTION mark_digest_notifications_sent IS 'Mark digest notifications as sent';
COMMENT ON FUNCTION get_unread_notification_count IS 'Get count of unread in-app notifications for a user';
COMMENT ON FUNCTION mark_all_notifications_read IS 'Mark all in-app notifications as read for a user';
COMMENT ON FUNCTION cleanup_old_notifications IS 'Cleanup old notification records (run via cron)';
