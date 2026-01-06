-- Migration: Phase 26 - Batch Favorites RPC Function
-- Created: 2026-01-03
-- Purpose: Enable batch toggle of favorites for efficient offline sync
--
-- Supports:
-- 1. Toggling multiple favorites in a single call
-- 2. Mixed add/remove operations
-- 3. Returns updated states for all posts
-- 4. Maximum 50 items per batch

-- =============================================================================
-- Batch Toggle Favorites RPC
-- =============================================================================

DROP FUNCTION IF EXISTS batch_toggle_favorites(UUID, JSONB);

CREATE OR REPLACE FUNCTION batch_toggle_favorites(
    p_user_id UUID,
    p_operations JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_op RECORD;
    v_results JSONB := '[]'::JSONB;
    v_was_added BOOLEAN;
    v_like_count INTEGER;
    v_op_count INTEGER := 0;
    v_max_ops CONSTANT INTEGER := 50;
BEGIN
    -- Validate user
    IF p_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'User ID required'
        );
    END IF;

    -- Count operations
    SELECT COUNT(*) INTO v_op_count
    FROM jsonb_array_elements(p_operations);

    IF v_op_count > v_max_ops THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', format('Maximum %s operations per batch', v_max_ops)
        );
    END IF;

    IF v_op_count = 0 THEN
        RETURN jsonb_build_object(
            'success', true,
            'results', '[]'::JSONB,
            'processed', 0
        );
    END IF;

    -- Process each operation
    FOR v_op IN
        SELECT
            (elem->>'post_id')::INTEGER as post_id,
            (elem->>'action')::TEXT as action,
            elem->>'correlation_id' as correlation_id
        FROM jsonb_array_elements(p_operations) as elem
    LOOP
        BEGIN
            IF v_op.action = 'add' THEN
                -- Try to insert
                INSERT INTO favorites (user_id, post_id)
                VALUES (p_user_id, v_op.post_id)
                ON CONFLICT (user_id, post_id) DO NOTHING;

                IF FOUND THEN
                    -- Increment counter
                    UPDATE posts
                    SET post_like_counter = COALESCE(post_like_counter, 0) + 1
                    WHERE id = v_op.post_id
                    RETURNING post_like_counter INTO v_like_count;

                    v_was_added := TRUE;
                ELSE
                    -- Already exists
                    SELECT post_like_counter INTO v_like_count
                    FROM posts WHERE id = v_op.post_id;

                    v_was_added := TRUE;  -- Still favorited
                END IF;

            ELSIF v_op.action = 'remove' THEN
                -- Try to delete
                DELETE FROM favorites
                WHERE user_id = p_user_id AND post_id = v_op.post_id;

                IF FOUND THEN
                    -- Decrement counter
                    UPDATE posts
                    SET post_like_counter = GREATEST(0, COALESCE(post_like_counter, 0) - 1)
                    WHERE id = v_op.post_id
                    RETURNING post_like_counter INTO v_like_count;
                ELSE
                    -- Wasn't favorited
                    SELECT post_like_counter INTO v_like_count
                    FROM posts WHERE id = v_op.post_id;
                END IF;

                v_was_added := FALSE;

            ELSIF v_op.action = 'toggle' THEN
                -- Toggle: try insert, if fails then delete
                INSERT INTO favorites (user_id, post_id)
                VALUES (p_user_id, v_op.post_id)
                ON CONFLICT (user_id, post_id) DO NOTHING;

                IF FOUND THEN
                    v_was_added := TRUE;
                    UPDATE posts
                    SET post_like_counter = COALESCE(post_like_counter, 0) + 1
                    WHERE id = v_op.post_id
                    RETURNING post_like_counter INTO v_like_count;
                ELSE
                    DELETE FROM favorites
                    WHERE user_id = p_user_id AND post_id = v_op.post_id;

                    v_was_added := FALSE;
                    UPDATE posts
                    SET post_like_counter = GREATEST(0, COALESCE(post_like_counter, 0) - 1)
                    WHERE id = v_op.post_id
                    RETURNING post_like_counter INTO v_like_count;
                END IF;

            ELSE
                RAISE EXCEPTION 'Invalid action: %', v_op.action;
            END IF;

            -- Add result
            v_results := v_results || jsonb_build_object(
                'post_id', v_op.post_id,
                'correlation_id', v_op.correlation_id,
                'success', true,
                'is_favorited', v_was_added,
                'like_count', COALESCE(v_like_count, 0)
            );

        EXCEPTION WHEN OTHERS THEN
            -- Add error result
            v_results := v_results || jsonb_build_object(
                'post_id', v_op.post_id,
                'correlation_id', v_op.correlation_id,
                'success', false,
                'error', SQLERRM
            );
        END;
    END LOOP;

    RETURN jsonb_build_object(
        'success', true,
        'results', v_results,
        'processed', v_op_count
    );
END;
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION batch_toggle_favorites(UUID, JSONB) TO authenticated;

-- =============================================================================
-- Get Favorites Status for Multiple Posts
-- =============================================================================

DROP FUNCTION IF EXISTS get_favorites_status(UUID, INTEGER[]);

CREATE OR REPLACE FUNCTION get_favorites_status(
    p_user_id UUID,
    p_post_ids INTEGER[]
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_results JSONB := '[]'::JSONB;
BEGIN
    SELECT jsonb_agg(
        jsonb_build_object(
            'post_id', p.id,
            'is_favorited', f.post_id IS NOT NULL,
            'like_count', COALESCE(p.post_like_counter, 0)
        )
    ) INTO v_results
    FROM unnest(p_post_ids) as pid(id)
    JOIN posts p ON p.id = pid.id
    LEFT JOIN favorites f ON f.post_id = p.id AND f.user_id = p_user_id;

    RETURN jsonb_build_object(
        'success', true,
        'statuses', COALESCE(v_results, '[]'::JSONB)
    );
END;
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION get_favorites_status(UUID, INTEGER[]) TO authenticated;

-- =============================================================================
-- Comments
-- =============================================================================

COMMENT ON FUNCTION batch_toggle_favorites IS
'Batch toggle favorites for efficient offline sync. Supports add/remove/toggle actions. Max 50 operations. Phase 26.1';

COMMENT ON FUNCTION get_favorites_status IS
'Get favorite status for multiple posts in a single call. Phase 26.1';
