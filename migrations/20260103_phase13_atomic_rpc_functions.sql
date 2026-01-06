-- ============================================================================
-- Phase 13: Atomic RPC Functions for Cross-Platform Consistency
-- ============================================================================
-- These RPC functions ensure atomic operations and iOS/Android parity.
-- ============================================================================

-- ============================================================================
-- 13.1 Filter Preset Management
-- ============================================================================

-- Set a filter preset as the default (atomic)
CREATE OR REPLACE FUNCTION set_filter_preset_default(
    p_preset_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_result JSONB;
BEGIN
    -- Verify ownership
    IF NOT EXISTS (
        SELECT 1 FROM filter_presets
        WHERE id = p_preset_id AND user_id = v_user_id
    ) THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Preset not found or unauthorized'
        );
    END IF;

    -- Atomic: Clear all defaults and set new one in single transaction
    UPDATE filter_presets
    SET is_default = false
    WHERE user_id = v_user_id AND is_default = true;

    UPDATE filter_presets
    SET is_default = true, updated_at = NOW()
    WHERE id = p_preset_id;

    SELECT jsonb_build_object(
        'success', true,
        'preset_id', p_preset_id,
        'is_default', true
    ) INTO v_result;

    RETURN v_result;
END;
$$;

-- ============================================================================
-- 13.2 Review Statistics (Server-Side Aggregation)
-- ============================================================================

-- Get comprehensive review statistics for a user
CREATE OR REPLACE FUNCTION get_user_review_stats(
    p_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_target_user UUID := COALESCE(p_user_id, auth.uid());
    v_result JSONB;
BEGIN
    SELECT jsonb_build_object(
        'user_id', v_target_user,
        'average_rating', COALESCE(AVG(rating), 0),
        'total_reviews', COUNT(*),
        'distribution', jsonb_build_object(
            'five_star', COUNT(*) FILTER (WHERE rating = 5),
            'four_star', COUNT(*) FILTER (WHERE rating = 4),
            'three_star', COUNT(*) FILTER (WHERE rating = 3),
            'two_star', COUNT(*) FILTER (WHERE rating = 2),
            'one_star', COUNT(*) FILTER (WHERE rating = 1)
        ),
        'recent_reviews', (
            SELECT COALESCE(jsonb_agg(
                jsonb_build_object(
                    'id', r.id,
                    'rating', r.rating,
                    'comment', r.comment,
                    'created_at', r.created_at,
                    'reviewer_name', p.nickname
                ) ORDER BY r.created_at DESC
            ), '[]'::jsonb)
            FROM reviews r
            LEFT JOIN profiles p ON r.reviewer_id = p.id
            WHERE r.reviewed_user_id = v_target_user
            LIMIT 5
        )
    ) INTO v_result
    FROM reviews
    WHERE reviewed_user_id = v_target_user;

    RETURN COALESCE(v_result, jsonb_build_object(
        'user_id', v_target_user,
        'average_rating', 0,
        'total_reviews', 0,
        'distribution', jsonb_build_object(
            'five_star', 0, 'four_star', 0, 'three_star', 0,
            'two_star', 0, 'one_star', 0
        ),
        'recent_reviews', '[]'::jsonb
    ));
END;
$$;

-- Get pending reviews for authenticated user
CREATE OR REPLACE FUNCTION get_pending_reviews()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_result JSONB;
BEGIN
    -- Find completed transactions without reviews
    SELECT jsonb_build_object(
        'pending_count', COUNT(*),
        'pending_reviews', COALESCE(jsonb_agg(
            jsonb_build_object(
                'transaction_id', t.id,
                'post_id', t.post_id,
                'post_name', p.post_name,
                'other_user_id', CASE
                    WHEN t.giver_id = v_user_id THEN t.receiver_id
                    ELSE t.giver_id
                END,
                'other_user_name', CASE
                    WHEN t.giver_id = v_user_id THEN receiver.nickname
                    ELSE giver.nickname
                END,
                'completed_at', t.completed_at,
                'type', CASE
                    WHEN t.giver_id = v_user_id THEN 'given'
                    ELSE 'received'
                END
            ) ORDER BY t.completed_at DESC
        ), '[]'::jsonb)
    ) INTO v_result
    FROM transactions t
    JOIN posts p ON t.post_id = p.id
    LEFT JOIN profiles giver ON t.giver_id = giver.id
    LEFT JOIN profiles receiver ON t.receiver_id = receiver.id
    WHERE t.status = 'completed'
      AND (t.giver_id = v_user_id OR t.receiver_id = v_user_id)
      AND NOT EXISTS (
          SELECT 1 FROM reviews r
          WHERE r.transaction_id = t.id
            AND r.reviewer_id = v_user_id
      );

    RETURN COALESCE(v_result, jsonb_build_object(
        'pending_count', 0,
        'pending_reviews', '[]'::jsonb
    ));
END;
$$;

-- ============================================================================
-- 13.3 OAuth Profile Sync (Atomic UPSERT)
-- ============================================================================

-- Complete OAuth and sync profile atomically
CREATE OR REPLACE FUNCTION complete_oauth_and_sync_profile(
    p_user_id UUID,
    p_email TEXT,
    p_nickname TEXT DEFAULT NULL,
    p_avatar_url TEXT DEFAULT NULL,
    p_provider TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_profile_id UUID;
    v_is_new BOOLEAN := false;
    v_result JSONB;
BEGIN
    -- Atomic UPSERT: Create or update profile in single operation
    INSERT INTO profiles (id, email, nickname, avatar_url, created_at, updated_at)
    VALUES (
        p_user_id,
        p_email,
        COALESCE(p_nickname, SPLIT_PART(p_email, '@', 1)),
        p_avatar_url,
        NOW(),
        NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
        email = EXCLUDED.email,
        nickname = COALESCE(NULLIF(profiles.nickname, ''), p_nickname, profiles.nickname),
        avatar_url = COALESCE(p_avatar_url, profiles.avatar_url),
        updated_at = NOW()
    RETURNING id INTO v_profile_id;

    -- Check if this was a new profile
    SELECT (created_at > NOW() - INTERVAL '5 seconds') INTO v_is_new
    FROM profiles WHERE id = p_user_id;

    -- Log OAuth sign-in if we have an oauth_log table
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'oauth_log') THEN
        INSERT INTO oauth_log (user_id, provider, created_at)
        VALUES (p_user_id, p_provider, NOW())
        ON CONFLICT DO NOTHING;
    END IF;

    -- Return full profile
    SELECT jsonb_build_object(
        'success', true,
        'is_new_user', v_is_new,
        'profile', jsonb_build_object(
            'id', id,
            'email', email,
            'nickname', nickname,
            'avatar_url', avatar_url,
            'created_at', created_at
        )
    ) INTO v_result
    FROM profiles WHERE id = p_user_id;

    RETURN v_result;
END;
$$;

-- ============================================================================
-- 13.4 Listing Arrangement (Atomic Multi-Table Update)
-- ============================================================================

-- Mark listing as arranged with atomic multi-table update
CREATE OR REPLACE FUNCTION mark_listing_arranged(
    p_post_id INTEGER,
    p_receiver_id UUID,
    p_room_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_giver_id UUID;
    v_notification_id UUID;
    v_transaction_id UUID;
    v_result JSONB;
BEGIN
    -- Verify ownership
    SELECT user_id INTO v_giver_id
    FROM posts WHERE id = p_post_id;

    IF v_giver_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Listing not found'
        );
    END IF;

    IF v_giver_id != v_user_id THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Only the listing owner can mark as arranged'
        );
    END IF;

    -- Atomic: Update listing status
    UPDATE posts
    SET
        status = 'arranged',
        arranged_to = p_receiver_id,
        arranged_at = NOW(),
        updated_at = NOW()
    WHERE id = p_post_id;

    -- Atomic: Create transaction record
    INSERT INTO transactions (post_id, giver_id, receiver_id, status, created_at)
    VALUES (p_post_id, v_giver_id, p_receiver_id, 'arranged', NOW())
    RETURNING id INTO v_transaction_id;

    -- Atomic: Send notification to receiver
    INSERT INTO notifications (
        user_id, type, title, body, data, created_at
    )
    VALUES (
        p_receiver_id,
        'listing_arranged',
        'Food Arranged!',
        'A listing has been arranged for you',
        jsonb_build_object(
            'post_id', p_post_id,
            'giver_id', v_giver_id,
            'transaction_id', v_transaction_id
        ),
        NOW()
    )
    RETURNING id INTO v_notification_id;

    -- Atomic: Update chat room if provided
    IF p_room_id IS NOT NULL THEN
        UPDATE chat_rooms
        SET
            arrangement_status = 'arranged',
            updated_at = NOW()
        WHERE id = p_room_id;
    END IF;

    SELECT jsonb_build_object(
        'success', true,
        'post_id', p_post_id,
        'transaction_id', v_transaction_id,
        'notification_sent', v_notification_id IS NOT NULL,
        'arranged_at', NOW()
    ) INTO v_result;

    RETURN v_result;
END;
$$;

-- Get arrangement status for a listing
CREATE OR REPLACE FUNCTION get_arrangement_status(
    p_post_id INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_result JSONB;
BEGIN
    SELECT jsonb_build_object(
        'post_id', p.id,
        'status', p.status,
        'arranged_to', p.arranged_to,
        'arranged_at', p.arranged_at,
        'giver', jsonb_build_object(
            'id', giver.id,
            'nickname', giver.nickname,
            'avatar_url', giver.avatar_url
        ),
        'receiver', CASE WHEN receiver.id IS NOT NULL THEN
            jsonb_build_object(
                'id', receiver.id,
                'nickname', receiver.nickname,
                'avatar_url', receiver.avatar_url
            )
        ELSE NULL END,
        'transaction', (
            SELECT jsonb_build_object(
                'id', t.id,
                'status', t.status,
                'created_at', t.created_at,
                'completed_at', t.completed_at
            )
            FROM transactions t
            WHERE t.post_id = p.id
            ORDER BY t.created_at DESC
            LIMIT 1
        )
    ) INTO v_result
    FROM posts p
    LEFT JOIN profiles giver ON p.user_id = giver.id
    LEFT JOIN profiles receiver ON p.arranged_to = receiver.id
    WHERE p.id = p_post_id;

    RETURN COALESCE(v_result, jsonb_build_object(
        'error', 'Listing not found'
    ));
END;
$$;

-- ============================================================================
-- Grant Permissions
-- ============================================================================

GRANT EXECUTE ON FUNCTION set_filter_preset_default(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION get_user_review_stats(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION get_pending_reviews() TO authenticated;
GRANT EXECUTE ON FUNCTION complete_oauth_and_sync_profile(UUID, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION mark_listing_arranged(INTEGER, UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION get_arrangement_status(INTEGER) TO authenticated;

-- ============================================================================
-- Comments
-- ============================================================================

COMMENT ON FUNCTION set_filter_preset_default IS
'Atomically sets a filter preset as the default, clearing previous default. Phase 13.1';

COMMENT ON FUNCTION get_user_review_stats IS
'Returns comprehensive review statistics with distribution and recent reviews. Phase 13.2';

COMMENT ON FUNCTION get_pending_reviews IS
'Returns transactions awaiting reviews from the current user. Phase 13.2';

COMMENT ON FUNCTION complete_oauth_and_sync_profile IS
'Atomic UPSERT for OAuth profile creation/sync. Phase 13.3';

COMMENT ON FUNCTION mark_listing_arranged IS
'Atomically updates listing, creates transaction, and sends notification. Phase 13.4';

COMMENT ON FUNCTION get_arrangement_status IS
'Returns current arrangement status for a listing. Phase 13.4';
