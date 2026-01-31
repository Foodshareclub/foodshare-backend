-- Migration: Moderation Queue for Content Review
-- Purpose: Track reported content and blocked users for moderator review
-- Date: 2026-01-28

-- Create moderation_queue table
CREATE TABLE IF NOT EXISTS moderation_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_type TEXT NOT NULL CHECK (item_type IN ('listing', 'user', 'message', 'review', 'post', 'user_block')),
    item_id UUID NOT NULL,
    reporter_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewing', 'resolved', 'dismissed')),
    reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMPTZ,
    resolution_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_moderation_queue_status ON moderation_queue(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_moderation_queue_item_type ON moderation_queue(item_type);
CREATE INDEX IF NOT EXISTS idx_moderation_queue_reporter ON moderation_queue(reporter_id);
CREATE INDEX IF NOT EXISTS idx_moderation_queue_created_at ON moderation_queue(created_at DESC);

-- RLS Policies
ALTER TABLE moderation_queue ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Admins can view all moderation items" ON moderation_queue;
DROP POLICY IF EXISTS "Users can view their own reports" ON moderation_queue;
DROP POLICY IF EXISTS "Authenticated users can report content" ON moderation_queue;
DROP POLICY IF EXISTS "Admins can update moderation items" ON moderation_queue;

-- Admins can view all moderation items
CREATE POLICY "Admins can view all moderation items"
    ON moderation_queue FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM user_roles ur
            JOIN roles r ON ur.role_id = r.id
            WHERE ur.profile_id = auth.uid()
            AND r.name IN ('admin', 'moderator')
        )
    );

-- Users can view their own reports
CREATE POLICY "Users can view their own reports"
    ON moderation_queue FOR SELECT
    USING (auth.uid() = reporter_id);

-- Authenticated users can report content
CREATE POLICY "Authenticated users can report content"
    ON moderation_queue FOR INSERT
    WITH CHECK (auth.uid() = reporter_id);

-- Admins can update moderation items
CREATE POLICY "Admins can update moderation items"
    ON moderation_queue FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM user_roles ur
            JOIN roles r ON ur.role_id = r.id
            WHERE ur.profile_id = auth.uid()
            AND r.name IN ('admin', 'moderator')
        )
    );

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_moderation_queue_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_moderation_queue_updated_at ON moderation_queue;
CREATE TRIGGER trigger_update_moderation_queue_updated_at
    BEFORE UPDATE ON moderation_queue
    FOR EACH ROW
    EXECUTE FUNCTION update_moderation_queue_updated_at();

-- Grant permissions
GRANT SELECT, INSERT ON moderation_queue TO authenticated;
GRANT UPDATE ON moderation_queue TO authenticated; -- For admins via RLS

COMMENT ON TABLE moderation_queue IS 'Queue for moderating reported content and blocked users';
COMMENT ON COLUMN moderation_queue.item_type IS 'Type of content: listing, user, message, review, post, user_block';
COMMENT ON COLUMN moderation_queue.status IS 'Review status: pending, reviewing, resolved, dismissed';
