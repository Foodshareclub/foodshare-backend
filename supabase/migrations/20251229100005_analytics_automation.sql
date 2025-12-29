-- ============================================================================
-- Analytics & Automation Infrastructure
-- Phase 4: Ultra-Thin Client Architecture
-- ============================================================================
-- This migration adds:
-- 1. Analytics tables for view tracking and API metrics
-- 2. Audit tables for post change tracking
-- 3. View tracking RPC with server-side debouncing
-- 4. Trending posts algorithm RPC
-- 5. Audit triggers for automatic change logging
-- 6. Auto-deactivation function for expired listings
-- ============================================================================

-- ============================================================================
-- 1. Analytics Tables
-- ============================================================================

-- Post view tracking with debouncing
CREATE TABLE IF NOT EXISTS public.post_views (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id INT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    viewer_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
    viewer_ip_hash TEXT, -- Hashed IP for anonymous tracking
    session_id TEXT, -- For debouncing same session views
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Composite unique constraint for debouncing
    CONSTRAINT unique_view_session UNIQUE (post_id, session_id)
);

-- Index for efficient view counting
CREATE INDEX IF NOT EXISTS idx_post_views_post_id ON post_views(post_id);
CREATE INDEX IF NOT EXISTS idx_post_views_created_at ON post_views(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_post_views_viewer ON post_views(viewer_id) WHERE viewer_id IS NOT NULL;

-- API analytics for monitoring
CREATE TABLE IF NOT EXISTS public.api_analytics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    endpoint TEXT NOT NULL,
    method TEXT NOT NULL,
    status_code INT,
    response_time_ms INT,
    user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
    error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for analytics queries
CREATE INDEX IF NOT EXISTS idx_api_analytics_endpoint ON api_analytics(endpoint, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_analytics_errors ON api_analytics(error_code) WHERE error_code IS NOT NULL;

-- RLS for analytics tables
ALTER TABLE post_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_analytics ENABLE ROW LEVEL SECURITY;

-- Views can be inserted by anyone, read only by post owner or admin
CREATE POLICY "Anyone can track views"
    ON post_views FOR INSERT
    WITH CHECK (true);

CREATE POLICY "Post owners can view their analytics"
    ON post_views FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM posts
            WHERE posts.id = post_views.post_id
            AND posts.profile_id = auth.uid()
        )
    );

-- API analytics only accessible to service role
CREATE POLICY "Service role only for api_analytics"
    ON api_analytics
    USING (false);

-- ============================================================================
-- 2. Audit Tables
-- ============================================================================

-- Create audit schema if not exists
CREATE SCHEMA IF NOT EXISTS audit;

-- Post change audit log
CREATE TABLE IF NOT EXISTS audit.post_changes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id INT NOT NULL,
    change_type TEXT NOT NULL CHECK (change_type IN ('created', 'updated', 'deleted', 'arranged', 'deactivated')),
    changed_by UUID,
    old_values JSONB,
    new_values JSONB,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for audit queries
CREATE INDEX IF NOT EXISTS idx_audit_post_changes_post ON audit.post_changes(post_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_post_changes_user ON audit.post_changes(changed_by, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_post_changes_type ON audit.post_changes(change_type, changed_at DESC);

-- ============================================================================
-- 3. Track View RPC with Server-Side Debouncing
-- ============================================================================
-- Debounces views: same session/viewer can only increment once per 30 minutes

CREATE OR REPLACE FUNCTION public.track_view(
    p_post_id INT,
    p_session_id TEXT DEFAULT NULL,
    p_viewer_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_session TEXT;
    v_viewer UUID;
    v_existing_view UUID;
    v_view_count INT;
    v_debounce_minutes INT := 30;
BEGIN
    -- Use provided values or derive from context
    v_viewer := COALESCE(p_viewer_id, auth.uid());
    v_session := COALESCE(p_session_id,
        COALESCE(v_viewer::TEXT, 'anon-' || gen_random_uuid()::TEXT));

    -- Check if post exists and is active
    IF NOT EXISTS (SELECT 1 FROM posts WHERE id = p_post_id AND is_active = true) THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', jsonb_build_object(
                'code', 'POST_NOT_FOUND',
                'message', 'Post not found or inactive'
            )
        );
    END IF;

    -- Check for recent view from same session (debouncing)
    SELECT id INTO v_existing_view
    FROM post_views
    WHERE post_id = p_post_id
      AND session_id = v_session
      AND created_at > NOW() - (v_debounce_minutes || ' minutes')::INTERVAL;

    IF v_existing_view IS NOT NULL THEN
        -- View already counted recently, just return current count
        SELECT COALESCE(post_view_counter, 0) INTO v_view_count
        FROM posts WHERE id = p_post_id;

        RETURN jsonb_build_object(
            'success', true,
            'counted', false,
            'view_count', v_view_count,
            'message', 'View already counted in this session'
        );
    END IF;

    -- Insert new view record (use ON CONFLICT for race conditions)
    INSERT INTO post_views (post_id, viewer_id, session_id)
    VALUES (p_post_id, v_viewer, v_session)
    ON CONFLICT (post_id, session_id) DO NOTHING;

    -- Increment post view counter
    UPDATE posts
    SET post_view_counter = COALESCE(post_view_counter, 0) + 1
    WHERE id = p_post_id
    RETURNING post_view_counter INTO v_view_count;

    RETURN jsonb_build_object(
        'success', true,
        'counted', true,
        'view_count', v_view_count
    );

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'success', false,
        'error', jsonb_build_object(
            'code', 'SERVER_ERROR',
            'message', SQLERRM
        )
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.track_view TO authenticated, anon;

COMMENT ON FUNCTION public.track_view IS
'Track post view with 30-minute debouncing per session.
Returns: { success, counted, view_count }';

-- ============================================================================
-- 4. Trending Posts Algorithm RPC
-- ============================================================================
-- Calculates trending score based on:
-- - Recent views (weighted by recency)
-- - Recent likes (weighted by recency)
-- - Engagement rate (likes/views)
-- - Post freshness

CREATE OR REPLACE FUNCTION public.get_trending_posts(
    p_limit INT DEFAULT 20,
    p_offset INT DEFAULT 0,
    p_hours_window INT DEFAULT 24,
    p_latitude DOUBLE PRECISION DEFAULT NULL,
    p_longitude DOUBLE PRECISION DEFAULT NULL,
    p_radius_km DOUBLE PRECISION DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_result JSONB;
BEGIN
    -- Clamp limit
    p_limit := LEAST(p_limit, 100);

    WITH trending_scores AS (
        SELECT
            p.id,
            p.post_name,
            p.post_description,
            p.images,
            p.post_type,
            p.latitude,
            p.longitude,
            p.post_address,
            p.profile_id,
            p.created_at,
            COALESCE(p.post_view_counter, 0) as view_count,
            COALESCE(p.post_like_counter, 0) as like_count,
            -- Recent views in window (weighted by recency)
            COALESCE((
                SELECT COUNT(*) * (1 - EXTRACT(EPOCH FROM (NOW() - pv.created_at)) / (p_hours_window * 3600))
                FROM post_views pv
                WHERE pv.post_id = p.id
                AND pv.created_at > NOW() - (p_hours_window || ' hours')::INTERVAL
            ), 0) as recent_views_score,
            -- Recent likes in window (weighted more heavily)
            COALESCE((
                SELECT COUNT(*) * 2 * (1 - EXTRACT(EPOCH FROM (NOW() - l.created_at)) / (p_hours_window * 3600))
                FROM likes l
                WHERE l.post_id = p.id
                AND l.challenge_id = 0 AND l.forum_id = 0
                AND l.created_at > NOW() - (p_hours_window || ' hours')::INTERVAL
            ), 0) as recent_likes_score,
            -- Freshness bonus (newer posts score higher)
            GREATEST(0, 1 - EXTRACT(EPOCH FROM (NOW() - p.created_at)) / (p_hours_window * 3600 * 7)) as freshness_score,
            -- Distance (if location provided)
            CASE
                WHEN p_latitude IS NOT NULL AND p_longitude IS NOT NULL THEN
                    ST_Distance(
                        ST_MakePoint(p.longitude, p.latitude)::geography,
                        ST_MakePoint(p_longitude, p_latitude)::geography
                    ) / 1000 -- Convert to km
                ELSE NULL
            END as distance_km
        FROM posts p
        WHERE p.is_active = true
        AND p.is_arranged = false
        -- Location filter if provided
        AND (
            p_latitude IS NULL OR p_longitude IS NULL OR p_radius_km IS NULL
            OR ST_DWithin(
                ST_MakePoint(p.longitude, p.latitude)::geography,
                ST_MakePoint(p_longitude, p_latitude)::geography,
                p_radius_km * 1000
            )
        )
    ),
    ranked_posts AS (
        SELECT
            ts.*,
            -- Combined trending score
            (
                ts.recent_views_score * 1.0 +
                ts.recent_likes_score * 2.0 +
                ts.freshness_score * 3.0 +
                -- Engagement rate bonus
                CASE
                    WHEN ts.view_count > 0 THEN (ts.like_count::FLOAT / ts.view_count) * 5.0
                    ELSE 0
                END
            ) as trending_score
        FROM trending_scores ts
    )
    SELECT jsonb_agg(
        jsonb_build_object(
            'id', rp.id,
            'post_name', rp.post_name,
            'post_description', rp.post_description,
            'images', rp.images,
            'post_type', rp.post_type,
            'latitude', rp.latitude,
            'longitude', rp.longitude,
            'post_address', rp.post_address,
            'profile_id', rp.profile_id,
            'created_at', rp.created_at,
            'view_count', rp.view_count,
            'like_count', rp.like_count,
            'trending_score', ROUND(rp.trending_score::NUMERIC, 2),
            'distance_km', ROUND(rp.distance_km::NUMERIC, 2)
        )
        ORDER BY rp.trending_score DESC
    )
    INTO v_result
    FROM (
        SELECT * FROM ranked_posts
        ORDER BY trending_score DESC
        LIMIT p_limit
        OFFSET p_offset
    ) rp;

    RETURN jsonb_build_object(
        'success', true,
        'posts', COALESCE(v_result, '[]'::JSONB),
        'window_hours', p_hours_window
    );

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'success', false,
        'error', jsonb_build_object(
            'code', 'SERVER_ERROR',
            'message', SQLERRM
        )
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_trending_posts TO authenticated, anon;

COMMENT ON FUNCTION public.get_trending_posts IS
'Get trending posts based on recent engagement and freshness.
Supports location-based filtering.
Returns: { success, posts, window_hours }';

-- ============================================================================
-- 5. Audit Triggers
-- ============================================================================

-- Function to log post changes
CREATE OR REPLACE FUNCTION audit.log_post_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_change_type TEXT;
    v_old_values JSONB;
    v_new_values JSONB;
BEGIN
    IF TG_OP = 'INSERT' THEN
        v_change_type := 'created';
        v_old_values := NULL;
        v_new_values := to_jsonb(NEW);
    ELSIF TG_OP = 'UPDATE' THEN
        -- Determine specific change type
        IF OLD.is_active = true AND NEW.is_active = false THEN
            v_change_type := 'deactivated';
        ELSIF OLD.is_arranged = false AND NEW.is_arranged = true THEN
            v_change_type := 'arranged';
        ELSE
            v_change_type := 'updated';
        END IF;

        -- Only log changed fields
        v_old_values := jsonb_build_object(
            'post_name', OLD.post_name,
            'post_description', OLD.post_description,
            'is_active', OLD.is_active,
            'is_arranged', OLD.is_arranged,
            'post_arranged_to', OLD.post_arranged_to
        );
        v_new_values := jsonb_build_object(
            'post_name', NEW.post_name,
            'post_description', NEW.post_description,
            'is_active', NEW.is_active,
            'is_arranged', NEW.is_arranged,
            'post_arranged_to', NEW.post_arranged_to
        );
    ELSIF TG_OP = 'DELETE' THEN
        v_change_type := 'deleted';
        v_old_values := to_jsonb(OLD);
        v_new_values := NULL;
    END IF;

    INSERT INTO audit.post_changes (post_id, change_type, changed_by, old_values, new_values)
    VALUES (
        COALESCE(NEW.id, OLD.id),
        v_change_type,
        auth.uid(),
        v_old_values,
        v_new_values
    );

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$;

-- Create audit trigger on posts table
DROP TRIGGER IF EXISTS audit_post_changes ON posts;
CREATE TRIGGER audit_post_changes
    AFTER INSERT OR UPDATE OR DELETE ON posts
    FOR EACH ROW
    EXECUTE FUNCTION audit.log_post_change();

-- ============================================================================
-- 6. Auto-Deactivation Functions
-- ============================================================================
-- These functions can be called by pg_cron or manually

-- Deactivate posts older than specified days
CREATE OR REPLACE FUNCTION public.deactivate_expired_posts(
    p_days_old INT DEFAULT 30
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_count INT;
BEGIN
    -- Deactivate posts that:
    -- 1. Are still active
    -- 2. Are not arranged
    -- 3. Were created more than p_days_old days ago
    WITH deactivated AS (
        UPDATE posts
        SET is_active = false
        WHERE is_active = true
        AND is_arranged = false
        AND created_at < NOW() - (p_days_old || ' days')::INTERVAL
        RETURNING id
    )
    SELECT COUNT(*) INTO v_count FROM deactivated;

    RETURN jsonb_build_object(
        'success', true,
        'deactivated_count', v_count,
        'cutoff_date', (NOW() - (p_days_old || ' days')::INTERVAL)::DATE
    );

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'success', false,
        'error', jsonb_build_object(
            'code', 'SERVER_ERROR',
            'message', SQLERRM
        )
    );
END;
$$;

-- Clean up old view records (for data retention)
CREATE OR REPLACE FUNCTION public.cleanup_old_analytics(
    p_days_retention INT DEFAULT 90
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_views_deleted INT;
    v_api_deleted INT;
BEGIN
    -- Delete old view records
    WITH deleted_views AS (
        DELETE FROM post_views
        WHERE created_at < NOW() - (p_days_retention || ' days')::INTERVAL
        RETURNING id
    )
    SELECT COUNT(*) INTO v_views_deleted FROM deleted_views;

    -- Delete old API analytics
    WITH deleted_api AS (
        DELETE FROM api_analytics
        WHERE created_at < NOW() - (p_days_retention || ' days')::INTERVAL
        RETURNING id
    )
    SELECT COUNT(*) INTO v_api_deleted FROM deleted_api;

    RETURN jsonb_build_object(
        'success', true,
        'views_deleted', v_views_deleted,
        'api_records_deleted', v_api_deleted,
        'retention_days', p_days_retention
    );

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'success', false,
        'error', jsonb_build_object(
            'code', 'SERVER_ERROR',
            'message', SQLERRM
        )
    );
END;
$$;

-- Grant execute to service role only
REVOKE ALL ON FUNCTION public.deactivate_expired_posts FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cleanup_old_analytics FROM PUBLIC;

COMMENT ON FUNCTION public.deactivate_expired_posts IS
'Deactivate posts older than specified days. Call via pg_cron daily.';

COMMENT ON FUNCTION public.cleanup_old_analytics IS
'Clean up old analytics data for data retention. Call via pg_cron weekly.';

-- ============================================================================
-- 7. User Preferences Table (for cross-device sync)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.user_preferences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    search_radius_km DOUBLE PRECISION DEFAULT 5.0,
    feed_view_mode TEXT DEFAULT 'grid' CHECK (feed_view_mode IN ('grid', 'list', 'map')),
    notifications_enabled BOOLEAN DEFAULT true,
    email_notifications BOOLEAN DEFAULT true,
    push_notifications BOOLEAN DEFAULT true,
    show_distance BOOLEAN DEFAULT true,
    preferred_categories INT[] DEFAULT '{}',
    theme TEXT DEFAULT 'system' CHECK (theme IN ('system', 'light', 'dark')),
    language TEXT DEFAULT 'en',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_user_preferences UNIQUE (profile_id)
);

-- Index for quick lookup
CREATE INDEX IF NOT EXISTS idx_user_preferences_profile ON user_preferences(profile_id);

-- RLS for user preferences
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own preferences"
    ON user_preferences FOR SELECT
    USING (profile_id = auth.uid());

CREATE POLICY "Users can insert own preferences"
    ON user_preferences FOR INSERT
    WITH CHECK (profile_id = auth.uid());

CREATE POLICY "Users can update own preferences"
    ON user_preferences FOR UPDATE
    USING (profile_id = auth.uid())
    WITH CHECK (profile_id = auth.uid());

-- Function to get or create user preferences
CREATE OR REPLACE FUNCTION public.get_user_preferences(
    p_profile_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_prefs RECORD;
BEGIN
    v_user_id := COALESCE(p_profile_id, auth.uid());

    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', jsonb_build_object(
                'code', 'AUTH_REQUIRED',
                'message', 'Authentication required'
            )
        );
    END IF;

    -- Get or create preferences
    INSERT INTO user_preferences (profile_id)
    VALUES (v_user_id)
    ON CONFLICT (profile_id) DO NOTHING;

    SELECT * INTO v_prefs
    FROM user_preferences
    WHERE profile_id = v_user_id;

    RETURN jsonb_build_object(
        'success', true,
        'preferences', jsonb_build_object(
            'search_radius_km', v_prefs.search_radius_km,
            'feed_view_mode', v_prefs.feed_view_mode,
            'notifications_enabled', v_prefs.notifications_enabled,
            'email_notifications', v_prefs.email_notifications,
            'push_notifications', v_prefs.push_notifications,
            'show_distance', v_prefs.show_distance,
            'preferred_categories', v_prefs.preferred_categories,
            'theme', v_prefs.theme,
            'language', v_prefs.language
        )
    );

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'success', false,
        'error', jsonb_build_object(
            'code', 'SERVER_ERROR',
            'message', SQLERRM
        )
    );
END;
$$;

-- Function to update user preferences
CREATE OR REPLACE FUNCTION public.update_user_preferences(
    p_preferences JSONB,
    p_profile_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
BEGIN
    v_user_id := COALESCE(p_profile_id, auth.uid());

    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', jsonb_build_object(
                'code', 'AUTH_REQUIRED',
                'message', 'Authentication required'
            )
        );
    END IF;

    -- Upsert preferences
    INSERT INTO user_preferences (
        profile_id,
        search_radius_km,
        feed_view_mode,
        notifications_enabled,
        email_notifications,
        push_notifications,
        show_distance,
        preferred_categories,
        theme,
        language
    )
    VALUES (
        v_user_id,
        COALESCE((p_preferences->>'search_radius_km')::DOUBLE PRECISION, 5.0),
        COALESCE(p_preferences->>'feed_view_mode', 'grid'),
        COALESCE((p_preferences->>'notifications_enabled')::BOOLEAN, true),
        COALESCE((p_preferences->>'email_notifications')::BOOLEAN, true),
        COALESCE((p_preferences->>'push_notifications')::BOOLEAN, true),
        COALESCE((p_preferences->>'show_distance')::BOOLEAN, true),
        COALESCE(
            (SELECT array_agg(x::INT) FROM jsonb_array_elements_text(p_preferences->'preferred_categories') x),
            '{}'::INT[]
        ),
        COALESCE(p_preferences->>'theme', 'system'),
        COALESCE(p_preferences->>'language', 'en')
    )
    ON CONFLICT (profile_id) DO UPDATE SET
        search_radius_km = COALESCE((p_preferences->>'search_radius_km')::DOUBLE PRECISION, user_preferences.search_radius_km),
        feed_view_mode = COALESCE(p_preferences->>'feed_view_mode', user_preferences.feed_view_mode),
        notifications_enabled = COALESCE((p_preferences->>'notifications_enabled')::BOOLEAN, user_preferences.notifications_enabled),
        email_notifications = COALESCE((p_preferences->>'email_notifications')::BOOLEAN, user_preferences.email_notifications),
        push_notifications = COALESCE((p_preferences->>'push_notifications')::BOOLEAN, user_preferences.push_notifications),
        show_distance = COALESCE((p_preferences->>'show_distance')::BOOLEAN, user_preferences.show_distance),
        preferred_categories = COALESCE(
            (SELECT array_agg(x::INT) FROM jsonb_array_elements_text(p_preferences->'preferred_categories') x),
            user_preferences.preferred_categories
        ),
        theme = COALESCE(p_preferences->>'theme', user_preferences.theme),
        language = COALESCE(p_preferences->>'language', user_preferences.language),
        updated_at = NOW();

    -- Return updated preferences
    RETURN get_user_preferences(v_user_id);

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'success', false,
        'error', jsonb_build_object(
            'code', 'SERVER_ERROR',
            'message', SQLERRM
        )
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_user_preferences TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_user_preferences TO authenticated;

-- ============================================================================
-- 8. Get Post Analytics RPC (for post owners)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_post_analytics(
    p_post_id INT,
    p_days INT DEFAULT 7
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_post_owner UUID;
    v_result JSONB;
BEGIN
    v_user_id := auth.uid();

    -- Check ownership
    SELECT profile_id INTO v_post_owner
    FROM posts WHERE id = p_post_id;

    IF v_post_owner IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', jsonb_build_object(
                'code', 'POST_NOT_FOUND',
                'message', 'Post not found'
            )
        );
    END IF;

    IF v_post_owner != v_user_id THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', jsonb_build_object(
                'code', 'AUTH_FORBIDDEN',
                'message', 'Not authorized to view analytics'
            )
        );
    END IF;

    -- Build analytics response
    SELECT jsonb_build_object(
        'total_views', COALESCE(p.post_view_counter, 0),
        'total_likes', COALESCE(p.post_like_counter, 0),
        'views_by_day', (
            SELECT COALESCE(jsonb_agg(
                jsonb_build_object('date', day, 'count', cnt)
                ORDER BY day
            ), '[]'::JSONB)
            FROM (
                SELECT DATE(created_at) as day, COUNT(*) as cnt
                FROM post_views
                WHERE post_id = p_post_id
                AND created_at > NOW() - (p_days || ' days')::INTERVAL
                GROUP BY DATE(created_at)
            ) daily
        ),
        'unique_viewers', (
            SELECT COUNT(DISTINCT COALESCE(viewer_id::TEXT, session_id))
            FROM post_views
            WHERE post_id = p_post_id
        ),
        'engagement_rate', CASE
            WHEN COALESCE(p.post_view_counter, 0) > 0 THEN
                ROUND((COALESCE(p.post_like_counter, 0)::NUMERIC / p.post_view_counter) * 100, 2)
            ELSE 0
        END
    )
    INTO v_result
    FROM posts p
    WHERE p.id = p_post_id;

    RETURN jsonb_build_object(
        'success', true,
        'analytics', v_result,
        'period_days', p_days
    );

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'success', false,
        'error', jsonb_build_object(
            'code', 'SERVER_ERROR',
            'message', SQLERRM
        )
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_post_analytics TO authenticated;

COMMENT ON FUNCTION public.get_post_analytics IS
'Get analytics for a post. Only accessible by post owner.
Returns: { success, analytics: { total_views, total_likes, views_by_day, unique_viewers, engagement_rate } }';

-- ============================================================================
-- Migration Complete
-- ============================================================================
