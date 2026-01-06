-- Migration: Phase 25 - Complete Transaction with Notifications RPC
-- Created: 2026-01-03
-- Purpose: Atomic transaction completion with notifications and stats updates
--
-- This RPC handles the final step after food exchange:
-- 1. Update transaction status to 'completed'
-- 2. Update giver's items_shared count
-- 3. Update receiver's items_received count
-- 4. Create notifications for both parties (review prompts)
-- 5. Update chat room status to 'completed'

-- =============================================================================
-- Complete Transaction RPC
-- =============================================================================

DROP FUNCTION IF EXISTS complete_transaction_with_notifications(UUID, UUID);

CREATE OR REPLACE FUNCTION complete_transaction_with_notifications(
    p_transaction_id UUID,
    p_room_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_transaction RECORD;
    v_post RECORD;
    v_giver_notification_id UUID;
    v_receiver_notification_id UUID;
    v_completed_at TIMESTAMPTZ := NOW();
BEGIN
    -- Verify user is authenticated
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Authentication required'
        );
    END IF;

    -- Get transaction details
    SELECT t.*, p.post_name, p.profile_id as post_owner_id
    INTO v_transaction
    FROM transactions t
    JOIN posts p ON p.id = t.post_id
    WHERE t.id = p_transaction_id;

    IF v_transaction IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Transaction not found'
        );
    END IF;

    -- Verify user is part of transaction (giver or receiver)
    IF v_user_id NOT IN (v_transaction.giver_id, v_transaction.receiver_id) THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Only transaction participants can complete it'
        );
    END IF;

    -- Verify transaction is in 'arranged' status
    IF v_transaction.status != 'arranged' THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', format('Transaction cannot be completed from status: %s', v_transaction.status)
        );
    END IF;

    -- ==========================================================================
    -- Atomic updates begin
    -- ==========================================================================

    -- 1. Update transaction status to completed
    UPDATE transactions
    SET
        status = 'completed',
        completed_at = v_completed_at,
        completed_by = v_user_id,
        updated_at = v_completed_at
    WHERE id = p_transaction_id;

    -- 2. Update post status
    UPDATE posts
    SET
        is_active = false,
        is_arranged = true,
        updated_at = v_completed_at
    WHERE id = v_transaction.post_id;

    -- 3. Update giver's items_shared count
    UPDATE profiles
    SET
        items_shared = COALESCE(items_shared, 0) + 1,
        updated_at = v_completed_at
    WHERE id = v_transaction.giver_id;

    -- 4. Update receiver's items_received count
    UPDATE profiles
    SET
        items_received = COALESCE(items_received, 0) + 1,
        updated_at = v_completed_at
    WHERE id = v_transaction.receiver_id;

    -- 5. Create notification for giver (review prompt)
    INSERT INTO notifications (
        user_id, type, title, body, data, created_at
    )
    VALUES (
        v_transaction.giver_id,
        'review_prompt',
        'Share Complete!',
        'How was your experience? Leave a review',
        jsonb_build_object(
            'transaction_id', p_transaction_id,
            'post_id', v_transaction.post_id,
            'reviewee_id', v_transaction.receiver_id,
            'transaction_type', 'shared'
        ),
        v_completed_at
    )
    RETURNING id INTO v_giver_notification_id;

    -- 6. Create notification for receiver (review prompt)
    INSERT INTO notifications (
        user_id, type, title, body, data, created_at
    )
    VALUES (
        v_transaction.receiver_id,
        'review_prompt',
        'Food Received!',
        'How was your experience? Leave a review',
        jsonb_build_object(
            'transaction_id', p_transaction_id,
            'post_id', v_transaction.post_id,
            'reviewee_id', v_transaction.giver_id,
            'transaction_type', 'received'
        ),
        v_completed_at
    )
    RETURNING id INTO v_receiver_notification_id;

    -- 7. Update chat room if provided
    IF p_room_id IS NOT NULL THEN
        UPDATE chat_rooms
        SET
            arrangement_status = 'completed',
            updated_at = v_completed_at
        WHERE id = p_room_id;
    END IF;

    -- ==========================================================================
    -- Return success result
    -- ==========================================================================

    RETURN jsonb_build_object(
        'success', true,
        'transaction_id', p_transaction_id,
        'post_id', v_transaction.post_id,
        'giver_id', v_transaction.giver_id,
        'receiver_id', v_transaction.receiver_id,
        'completed_at', v_completed_at,
        'completed_by', v_user_id,
        'notifications_sent', 2,
        'giver_notification_id', v_giver_notification_id,
        'receiver_notification_id', v_receiver_notification_id
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
GRANT EXECUTE ON FUNCTION complete_transaction_with_notifications(UUID, UUID) TO authenticated;

-- =============================================================================
-- Get Transaction Details RPC (helper function)
-- =============================================================================

DROP FUNCTION IF EXISTS get_transaction_details(UUID);

CREATE OR REPLACE FUNCTION get_transaction_details(
    p_transaction_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_result JSONB;
BEGIN
    SELECT jsonb_build_object(
        'transaction_id', t.id,
        'post_id', t.post_id,
        'post_name', p.post_name,
        'giver_id', t.giver_id,
        'receiver_id', t.receiver_id,
        'status', t.status,
        'created_at', t.created_at,
        'completed_at', t.completed_at,
        'giver', jsonb_build_object(
            'id', giver.id,
            'display_name', giver.display_name,
            'avatar_url', giver.avatar_url
        ),
        'receiver', jsonb_build_object(
            'id', receiver.id,
            'display_name', receiver.display_name,
            'avatar_url', receiver.avatar_url
        ),
        'can_complete', t.status = 'arranged' AND v_user_id IN (t.giver_id, t.receiver_id),
        'can_review', t.status = 'completed' AND NOT EXISTS (
            SELECT 1 FROM reviews r
            WHERE r.transaction_id = t.id
            AND r.reviewer_id = v_user_id
        )
    ) INTO v_result
    FROM transactions t
    JOIN posts p ON p.id = t.post_id
    JOIN profiles giver ON giver.id = t.giver_id
    JOIN profiles receiver ON receiver.id = t.receiver_id
    WHERE t.id = p_transaction_id
    AND (t.giver_id = v_user_id OR t.receiver_id = v_user_id);

    IF v_result IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Transaction not found or access denied'
        );
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'transaction', v_result
    );
END;
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION get_transaction_details(UUID) TO authenticated;

-- =============================================================================
-- Add index for efficient transaction lookups
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_transactions_status_participants
ON transactions(status, giver_id, receiver_id);

CREATE INDEX IF NOT EXISTS idx_transactions_post_id
ON transactions(post_id);

-- =============================================================================
-- Comments
-- =============================================================================

COMMENT ON FUNCTION complete_transaction_with_notifications IS
'Atomically completes a transaction: updates status, increments user counts, creates review prompt notifications for both parties. Phase 25.1';

COMMENT ON FUNCTION get_transaction_details IS
'Returns detailed transaction information with participant profiles. Phase 25.1';
