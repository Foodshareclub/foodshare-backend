-- Migration: Blocked Users Complete (Apple App Review requirement)
-- Purpose: User blocking functionality with instant feed filtering
-- Date: 2026-01-28

-- Create blocked_users table
CREATE TABLE IF NOT EXISTS blocked_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    blocked_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    reason TEXT,
    blocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Prevent duplicate blocks
    UNIQUE(user_id, blocked_user_id),
    
    -- Prevent self-blocking
    CONSTRAINT no_self_block CHECK (user_id != blocked_user_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_blocked_users_user_id ON blocked_users(user_id);
CREATE INDEX IF NOT EXISTS idx_blocked_users_blocked_user_id ON blocked_users(blocked_user_id);
CREATE INDEX IF NOT EXISTS idx_blocked_users_blocked_at ON blocked_users(blocked_at DESC);

-- RLS Policies
ALTER TABLE blocked_users ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Users can view their own blocked users" ON blocked_users;
DROP POLICY IF EXISTS "Users can block other users" ON blocked_users;
DROP POLICY IF EXISTS "Users can unblock users" ON blocked_users;

-- Users can view their own blocked list
CREATE POLICY "Users can view their own blocked users"
    ON blocked_users FOR SELECT
    USING (auth.uid() = user_id);

-- Users can block other users
CREATE POLICY "Users can block other users"
    ON blocked_users FOR INSERT
    WITH CHECK (auth.uid() = user_id AND user_id != blocked_user_id);

-- Users can unblock users they blocked
CREATE POLICY "Users can unblock users"
    ON blocked_users FOR DELETE
    USING (auth.uid() = user_id);

-- Function to check if user is blocked
DROP FUNCTION IF EXISTS is_user_blocked(UUID, UUID);
CREATE FUNCTION is_user_blocked(
    p_user_id UUID,
    p_target_user_id UUID
) RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM blocked_users
        WHERE user_id = p_user_id
        AND blocked_user_id = p_target_user_id
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to filter blocked users from queries (bidirectional)
DROP FUNCTION IF EXISTS is_blocked_by_user(UUID, UUID);
CREATE FUNCTION is_blocked_by_user(
    p_user_id UUID,
    p_target_user_id UUID
) RETURNS BOOLEAN AS $$
BEGIN
    -- Check both directions: if user blocked target OR target blocked user
    RETURN EXISTS (
        SELECT 1 FROM blocked_users
        WHERE (user_id = p_user_id AND blocked_user_id = p_target_user_id)
           OR (user_id = p_target_user_id AND blocked_user_id = p_user_id)
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- Trigger to notify developer when user is blocked (Apple requirement)
CREATE OR REPLACE FUNCTION notify_user_blocked()
RETURNS TRIGGER AS $$
BEGIN
    -- Insert into moderation queue for review
    INSERT INTO moderation_queue (
        item_type,
        item_id,
        reporter_id,
        reason,
        status
    ) VALUES (
        'user_block',
        NEW.blocked_user_id,
        NEW.user_id,
        COALESCE(NEW.reason, 'User blocked'),
        'pending'
    )
    ON CONFLICT DO NOTHING;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_notify_user_blocked ON blocked_users;
CREATE TRIGGER trigger_notify_user_blocked
    AFTER INSERT ON blocked_users
    FOR EACH ROW
    EXECUTE FUNCTION notify_user_blocked();

-- Grant permissions
GRANT SELECT, INSERT, DELETE ON blocked_users TO authenticated;
GRANT EXECUTE ON FUNCTION is_user_blocked TO authenticated;
GRANT EXECUTE ON FUNCTION is_blocked_by_user TO authenticated;

COMMENT ON TABLE blocked_users IS 'User blocking for content moderation - Apple App Review requirement';
COMMENT ON FUNCTION is_blocked_by_user IS 'Check if users have blocked each other (bidirectional)';
COMMENT ON FUNCTION notify_user_blocked IS 'Notify developers when user is blocked for moderation review';
