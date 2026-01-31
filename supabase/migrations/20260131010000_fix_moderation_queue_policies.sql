-- ============================================================================
-- FIX MODERATION QUEUE RLS POLICIES
-- ============================================================================
-- Version: 1.0.0
-- Date: 2026-01-31
--
-- Fixes the RLS policies that failed in 20260128203651_moderation_queue.sql
-- The original migration used incorrect column references (role instead of
-- joining user_roles to roles table via role_id).
-- ============================================================================

-- Drop existing broken policies if they exist
DROP POLICY IF EXISTS "Admins can view all moderation items" ON moderation_queue;
DROP POLICY IF EXISTS "Users can view their own reports" ON moderation_queue;
DROP POLICY IF EXISTS "Authenticated users can report content" ON moderation_queue;
DROP POLICY IF EXISTS "Admins can update moderation items" ON moderation_queue;

-- Admins can view all moderation items (fixed: join user_roles to roles)
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

-- Admins can update moderation items (fixed: join user_roles to roles)
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

-- Confirm success
DO $$
BEGIN
    RAISE NOTICE '✅ Moderation queue RLS policies fixed successfully';
END $$;
