-- Migration: Phase 29 - Submit Review with Notifications RPC
-- Created: 2026-01-03
-- Purpose: Atomically submit a review and update user stats with notifications
--
-- Features:
-- 1. Insert review atomically
-- 2. Prevent duplicate reviews for same transaction
-- 3. Update reviewed user's average rating and review count
-- 4. Create notification for reviewed user
-- 5. Return review with updated stats

-- =============================================================================
-- Submit Review with Notifications RPC
-- =============================================================================

DROP FUNCTION IF EXISTS submit_review_with_notifications(UUID, INTEGER, TEXT, TEXT);

CREATE OR REPLACE FUNCTION submit_review_with_notifications(
    p_transaction_id UUID,
    p_rating INTEGER,
    p_comment TEXT DEFAULT NULL,
    p_transaction_type TEXT DEFAULT 'shared'  -- 'shared' or 'received'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_review_id UUID;
    v_transaction RECORD;
    v_reviewee_id UUID;
    v_reviewer_name TEXT;
    v_new_avg_rating NUMERIC(3,2);
    v_new_review_count INTEGER;
    v_notification_id UUID;
    v_created_at TIMESTAMPTZ := NOW();
BEGIN
    -- Verify user is authenticated
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Authentication required'
        );
    END IF;

    -- Validate rating
    IF p_rating < 1 OR p_rating > 5 THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Rating must be between 1 and 5'
        );
    END IF;

    -- Get transaction details
    SELECT * INTO v_transaction
    FROM transactions
    WHERE id = p_transaction_id;

    IF v_transaction IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Transaction not found'
        );
    END IF;

    -- Verify user is part of transaction
    IF v_user_id NOT IN (v_transaction.giver_id, v_transaction.receiver_id) THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'You are not a participant in this transaction'
        );
    END IF;

    -- Verify transaction is completed
    IF v_transaction.status != 'completed' THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Can only review completed transactions'
        );
    END IF;

    -- Determine who is being reviewed
    IF v_user_id = v_transaction.giver_id THEN
        v_reviewee_id := v_transaction.receiver_id;
    ELSE
        v_reviewee_id := v_transaction.giver_id;
    END IF;

    -- Check for existing review
    IF EXISTS (
        SELECT 1 FROM reviews
        WHERE transaction_id = p_transaction_id
        AND reviewer_id = v_user_id
    ) THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'You have already reviewed this transaction'
        );
    END IF;

    -- Get reviewer's name for notification
    SELECT display_name INTO v_reviewer_name
    FROM profiles WHERE id = v_user_id;

    -- ==========================================================================
    -- Atomic operations begin
    -- ==========================================================================

    -- 1. Insert the review
    INSERT INTO reviews (
        transaction_id,
        reviewer_id,
        reviewee_id,
        rating,
        comment,
        transaction_type,
        created_at
    )
    VALUES (
        p_transaction_id,
        v_user_id,
        v_reviewee_id,
        p_rating,
        p_comment,
        p_transaction_type,
        v_created_at
    )
    RETURNING id INTO v_review_id;

    -- 2. Update reviewee's average rating and count
    UPDATE profiles
    SET
        avg_rating = (
            SELECT COALESCE(AVG(rating), 0)
            FROM reviews
            WHERE reviewee_id = v_reviewee_id
        ),
        review_count = (
            SELECT COUNT(*)
            FROM reviews
            WHERE reviewee_id = v_reviewee_id
        ),
        updated_at = v_created_at
    WHERE id = v_reviewee_id
    RETURNING avg_rating, review_count INTO v_new_avg_rating, v_new_review_count;

    -- 3. Create notification for reviewee
    INSERT INTO notifications (
        user_id,
        type,
        title,
        body,
        data,
        created_at
    )
    VALUES (
        v_reviewee_id,
        'new_review',
        'New Review!',
        format('%s left you a %s-star review', v_reviewer_name, p_rating),
        jsonb_build_object(
            'review_id', v_review_id,
            'transaction_id', p_transaction_id,
            'reviewer_id', v_user_id,
            'rating', p_rating,
            'has_comment', p_comment IS NOT NULL
        ),
        v_created_at
    )
    RETURNING id INTO v_notification_id;

    -- ==========================================================================
    -- Return result
    -- ==========================================================================

    RETURN jsonb_build_object(
        'success', true,
        'review', jsonb_build_object(
            'id', v_review_id,
            'transaction_id', p_transaction_id,
            'reviewer_id', v_user_id,
            'reviewee_id', v_reviewee_id,
            'rating', p_rating,
            'comment', p_comment,
            'transaction_type', p_transaction_type,
            'created_at', v_created_at
        ),
        'reviewee_stats', jsonb_build_object(
            'user_id', v_reviewee_id,
            'new_avg_rating', v_new_avg_rating,
            'new_review_count', v_new_review_count
        ),
        'notification_id', v_notification_id
    );

EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', SQLERRM
        );
END;
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION submit_review_with_notifications(UUID, INTEGER, TEXT, TEXT) TO authenticated;

-- =============================================================================
-- Get Pending Reviews RPC
-- =============================================================================

DROP FUNCTION IF EXISTS get_pending_reviews();

CREATE OR REPLACE FUNCTION get_pending_reviews()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_results JSONB;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Authentication required'
        );
    END IF;

    -- Find completed transactions where user hasn't left a review
    SELECT jsonb_agg(
        jsonb_build_object(
            'transaction_id', t.id,
            'post_id', t.post_id,
            'post_name', p.post_name,
            'other_user', jsonb_build_object(
                'id', other.id,
                'display_name', other.display_name,
                'avatar_url', other.avatar_url
            ),
            'transaction_type', CASE
                WHEN t.giver_id = v_user_id THEN 'shared'
                ELSE 'received'
            END,
            'completed_at', t.completed_at
        )
        ORDER BY t.completed_at DESC
    ) INTO v_results
    FROM transactions t
    JOIN posts p ON p.id = t.post_id
    JOIN profiles other ON other.id = CASE
        WHEN t.giver_id = v_user_id THEN t.receiver_id
        ELSE t.giver_id
    END
    WHERE t.status = 'completed'
    AND (t.giver_id = v_user_id OR t.receiver_id = v_user_id)
    AND NOT EXISTS (
        SELECT 1 FROM reviews r
        WHERE r.transaction_id = t.id
        AND r.reviewer_id = v_user_id
    );

    RETURN jsonb_build_object(
        'success', true,
        'pending_reviews', COALESCE(v_results, '[]'::JSONB),
        'count', COALESCE(jsonb_array_length(v_results), 0)
    );
END;
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION get_pending_reviews() TO authenticated;

-- =============================================================================
-- Get User Review Stats RPC
-- =============================================================================

DROP FUNCTION IF EXISTS get_user_review_stats(UUID);

CREATE OR REPLACE FUNCTION get_user_review_stats(
    p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_stats JSONB;
    v_distribution JSONB;
BEGIN
    -- Get rating distribution
    SELECT jsonb_object_agg(rating::text, count) INTO v_distribution
    FROM (
        SELECT rating, COUNT(*) as count
        FROM reviews
        WHERE reviewee_id = p_user_id
        GROUP BY rating
    ) dist;

    -- Get overall stats
    SELECT jsonb_build_object(
        'user_id', p_user_id,
        'avg_rating', COALESCE(p.avg_rating, 0),
        'review_count', COALESCE(p.review_count, 0),
        'items_shared', COALESCE(p.items_shared, 0),
        'items_received', COALESCE(p.items_received, 0),
        'rating_distribution', COALESCE(v_distribution, jsonb_build_object(
            '1', 0, '2', 0, '3', 0, '4', 0, '5', 0
        )),
        'recent_reviews', (
            SELECT COALESCE(jsonb_agg(
                jsonb_build_object(
                    'id', r.id,
                    'rating', r.rating,
                    'comment', r.comment,
                    'reviewer_name', reviewer.display_name,
                    'reviewer_avatar', reviewer.avatar_url,
                    'created_at', r.created_at
                )
                ORDER BY r.created_at DESC
            ), '[]'::JSONB)
            FROM reviews r
            JOIN profiles reviewer ON reviewer.id = r.reviewer_id
            WHERE r.reviewee_id = p_user_id
            LIMIT 5
        )
    ) INTO v_stats
    FROM profiles p
    WHERE p.id = p_user_id;

    IF v_stats IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'User not found'
        );
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'stats', v_stats
    );
END;
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION get_user_review_stats(UUID) TO authenticated;

-- =============================================================================
-- Indexes for efficient review queries
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_reviews_transaction
ON reviews(transaction_id);

CREATE INDEX IF NOT EXISTS idx_reviews_reviewee
ON reviews(reviewee_id);

CREATE INDEX IF NOT EXISTS idx_reviews_reviewer
ON reviews(reviewer_id);

CREATE INDEX IF NOT EXISTS idx_transactions_status_participants
ON transactions(status, giver_id, receiver_id);

-- =============================================================================
-- Comments
-- =============================================================================

COMMENT ON FUNCTION submit_review_with_notifications IS
'Atomically submits a review, updates user stats, and creates a notification. Prevents duplicates. Phase 29.1';

COMMENT ON FUNCTION get_pending_reviews IS
'Returns completed transactions where the user has not yet left a review. Phase 29.1';

COMMENT ON FUNCTION get_user_review_stats IS
'Returns comprehensive review statistics for a user including rating distribution. Phase 29.1';
