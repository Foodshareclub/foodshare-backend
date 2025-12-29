-- Migration: Listing Operations RPC Functions
-- Purpose: Transactional CRUD operations for listings (thin client architecture)
-- Supports: Cross-platform apps (iOS, Android, Web)

-- =============================================================================
-- CREATE LISTING (Transactional)
-- =============================================================================

-- Function to create a listing with validation in a single transaction
-- Returns the created listing or validation errors
CREATE OR REPLACE FUNCTION public.create_listing_transactional(
    p_profile_id UUID,
    p_title TEXT,
    p_description TEXT DEFAULT NULL,
    p_post_type TEXT DEFAULT 'food',
    p_images TEXT[] DEFAULT NULL,
    p_latitude DOUBLE PRECISION DEFAULT NULL,
    p_longitude DOUBLE PRECISION DEFAULT NULL,
    p_pickup_address TEXT DEFAULT NULL,
    p_pickup_time TEXT DEFAULT NULL,
    p_category_id INT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_validation JSONB;
    v_post_id INT;
    v_result JSONB;
    v_sanitized JSONB;
BEGIN
    -- Verify caller is the profile owner
    IF p_profile_id != auth.uid() THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', jsonb_build_object(
                'code', 'AUTH_FORBIDDEN',
                'message', 'You can only create listings for yourself'
            ),
            'listing', NULL
        );
    END IF;

    -- Validate listing data first
    v_validation := public.validate_listing(
        p_title, p_description, p_images, p_post_type, p_latitude, p_longitude, p_pickup_address, p_pickup_time
    );

    -- If validation failed, return errors
    IF NOT (v_validation->>'valid')::BOOLEAN THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', jsonb_build_object(
                'code', 'VALIDATION_ERROR',
                'message', 'Listing validation failed',
                'details', v_validation->'errors'
            ),
            'listing', NULL
        );
    END IF;

    v_sanitized := v_validation->'sanitized';

    -- Insert the listing
    INSERT INTO public.posts (
        profile_id,
        post_name,
        post_description,
        post_type,
        images,
        latitude,
        longitude,
        post_address,
        pickup_time,
        category_id,
        is_active,
        is_arranged,
        post_views,
        post_like_counter
    ) VALUES (
        p_profile_id,
        v_sanitized->>'title',
        NULLIF(v_sanitized->>'description', ''),
        v_sanitized->>'postType',
        p_images,
        (v_sanitized->>'latitude')::DOUBLE PRECISION,
        (v_sanitized->>'longitude')::DOUBLE PRECISION,
        NULLIF(v_sanitized->>'pickupAddress', ''),
        NULLIF(v_sanitized->>'pickupTime', ''),
        p_category_id,
        true,
        false,
        0,
        0
    )
    RETURNING id INTO v_post_id;

    -- Log the creation activity
    INSERT INTO public.post_activity_logs (post_id, actor_id, activity_type, metadata)
    VALUES (v_post_id, p_profile_id, 'created', jsonb_build_object(
        'post_type', v_sanitized->>'postType',
        'has_images', array_length(p_images, 1) > 0
    ));

    -- Build result with created listing
    SELECT jsonb_build_object(
        'success', true,
        'error', NULL,
        'listing', jsonb_build_object(
            'id', p.id,
            'profileId', p.profile_id,
            'postName', p.post_name,
            'postDescription', p.post_description,
            'postType', p.post_type,
            'images', p.images,
            'latitude', p.latitude,
            'longitude', p.longitude,
            'postAddress', p.post_address,
            'pickupTime', p.pickup_time,
            'categoryId', p.category_id,
            'isActive', p.is_active,
            'isArranged', p.is_arranged,
            'postViews', p.post_views,
            'postLikeCounter', p.post_like_counter,
            'createdAt', p.created_at
        )
    ) INTO v_result
    FROM public.posts p
    WHERE p.id = v_post_id;

    RETURN v_result;
END;
$$;

-- =============================================================================
-- UPDATE LISTING (Transactional)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.update_listing_transactional(
    p_listing_id INT,
    p_title TEXT DEFAULT NULL,
    p_description TEXT DEFAULT NULL,
    p_is_active BOOLEAN DEFAULT NULL,
    p_pickup_address TEXT DEFAULT NULL,
    p_pickup_time TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_validation JSONB;
    v_existing RECORD;
    v_result JSONB;
BEGIN
    -- Get existing listing
    SELECT * INTO v_existing FROM public.posts WHERE id = p_listing_id;

    IF v_existing IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', jsonb_build_object(
                'code', 'RESOURCE_NOT_FOUND',
                'message', 'Listing not found'
            ),
            'listing', NULL
        );
    END IF;

    -- Verify ownership
    IF v_existing.profile_id != auth.uid() THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', jsonb_build_object(
                'code', 'AUTH_FORBIDDEN',
                'message', 'You can only update your own listings'
            ),
            'listing', NULL
        );
    END IF;

    -- Validate update data
    v_validation := public.validate_listing_update(p_listing_id, p_title, p_description, p_is_active, NULL);

    IF NOT (v_validation->>'valid')::BOOLEAN THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', jsonb_build_object(
                'code', 'VALIDATION_ERROR',
                'message', 'Update validation failed',
                'details', v_validation->'errors'
            ),
            'listing', NULL
        );
    END IF;

    -- Update the listing (only non-null values)
    UPDATE public.posts
    SET
        post_name = COALESCE(NULLIF(TRIM(p_title), ''), post_name),
        post_description = CASE WHEN p_description IS NOT NULL THEN NULLIF(TRIM(p_description), '') ELSE post_description END,
        is_active = COALESCE(p_is_active, is_active),
        post_address = CASE WHEN p_pickup_address IS NOT NULL THEN NULLIF(TRIM(p_pickup_address), '') ELSE post_address END,
        pickup_time = CASE WHEN p_pickup_time IS NOT NULL THEN NULLIF(TRIM(p_pickup_time), '') ELSE pickup_time END,
        updated_at = now()
    WHERE id = p_listing_id;

    -- Log the update activity
    INSERT INTO public.post_activity_logs (post_id, actor_id, activity_type, metadata)
    VALUES (p_listing_id, auth.uid(), 'updated', jsonb_build_object(
        'fields_updated', jsonb_strip_nulls(jsonb_build_object(
            'title', p_title,
            'description', p_description,
            'is_active', p_is_active
        ))
    ));

    -- Return updated listing
    SELECT jsonb_build_object(
        'success', true,
        'error', NULL,
        'listing', jsonb_build_object(
            'id', p.id,
            'profileId', p.profile_id,
            'postName', p.post_name,
            'postDescription', p.post_description,
            'postType', p.post_type,
            'images', p.images,
            'latitude', p.latitude,
            'longitude', p.longitude,
            'postAddress', p.post_address,
            'pickupTime', p.pickup_time,
            'isActive', p.is_active,
            'isArranged', p.is_arranged,
            'createdAt', p.created_at,
            'updatedAt', p.updated_at
        )
    ) INTO v_result
    FROM public.posts p
    WHERE p.id = p_listing_id;

    RETURN v_result;
END;
$$;

-- =============================================================================
-- ARRANGE POST (Atomic with Audit)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.arrange_post(
    p_post_id INT,
    p_requester_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_post RECORD;
    v_result JSONB;
BEGIN
    -- Lock the post row to prevent race conditions
    SELECT * INTO v_post
    FROM public.posts
    WHERE id = p_post_id
    FOR UPDATE;

    IF v_post IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', jsonb_build_object(
                'code', 'RESOURCE_NOT_FOUND',
                'message', 'Post not found'
            ),
            'post', NULL,
            'notifyUserId', NULL
        );
    END IF;

    -- Check if already arranged
    IF v_post.is_arranged THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', jsonb_build_object(
                'code', 'RESOURCE_CONFLICT',
                'message', 'This post is already arranged'
            ),
            'post', NULL,
            'notifyUserId', NULL
        );
    END IF;

    -- Check if post is active
    IF NOT v_post.is_active THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', jsonb_build_object(
                'code', 'RESOURCE_UNAVAILABLE',
                'message', 'This post is no longer available'
            ),
            'post', NULL,
            'notifyUserId', NULL
        );
    END IF;

    -- Verify requester is not the owner (can't arrange own post)
    IF v_post.profile_id = p_requester_id THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', jsonb_build_object(
                'code', 'VALIDATION_ERROR',
                'message', 'You cannot arrange your own post'
            ),
            'post', NULL,
            'notifyUserId', NULL
        );
    END IF;

    -- Verify caller is the requester
    IF p_requester_id != auth.uid() THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', jsonb_build_object(
                'code', 'AUTH_FORBIDDEN',
                'message', 'You can only arrange posts for yourself'
            ),
            'post', NULL,
            'notifyUserId', NULL
        );
    END IF;

    -- Update the post
    UPDATE public.posts
    SET
        is_arranged = true,
        post_arranged_to = p_requester_id,
        post_arranged_at = now(),
        updated_at = now()
    WHERE id = p_post_id;

    -- Log the arrangement activity
    INSERT INTO public.post_activity_logs (post_id, actor_id, activity_type, metadata)
    VALUES (p_post_id, p_requester_id, 'arranged', jsonb_build_object(
        'sharer_id', v_post.profile_id,
        'requester_id', p_requester_id,
        'arranged_at', now()
    ));

    -- Return result with notify info for push notification
    SELECT jsonb_build_object(
        'success', true,
        'error', NULL,
        'post', jsonb_build_object(
            'id', p.id,
            'profileId', p.profile_id,
            'postName', p.post_name,
            'isArranged', p.is_arranged,
            'postArrangedTo', p.post_arranged_to,
            'postArrangedAt', p.post_arranged_at
        ),
        'notifyUserId', v_post.profile_id -- Sharer should be notified
    ) INTO v_result
    FROM public.posts p
    WHERE p.id = p_post_id;

    RETURN v_result;
END;
$$;

-- =============================================================================
-- CANCEL ARRANGEMENT (Atomic with Audit)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.cancel_arrangement(
    p_post_id INT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_post RECORD;
    v_result JSONB;
    v_caller_id UUID;
    v_notify_users UUID[];
BEGIN
    v_caller_id := auth.uid();

    -- Lock the post row
    SELECT * INTO v_post
    FROM public.posts
    WHERE id = p_post_id
    FOR UPDATE;

    IF v_post IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', jsonb_build_object(
                'code', 'RESOURCE_NOT_FOUND',
                'message', 'Post not found'
            ),
            'notifyUserIds', NULL
        );
    END IF;

    -- Check if arranged
    IF NOT v_post.is_arranged THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', jsonb_build_object(
                'code', 'RESOURCE_CONFLICT',
                'message', 'This post is not currently arranged'
            ),
            'notifyUserIds', NULL
        );
    END IF;

    -- Verify caller is either the owner or the arranged user
    IF v_caller_id != v_post.profile_id AND v_caller_id != v_post.post_arranged_to THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', jsonb_build_object(
                'code', 'AUTH_FORBIDDEN',
                'message', 'Only the owner or arranged user can cancel'
            ),
            'notifyUserIds', NULL
        );
    END IF;

    -- Build notify list (both parties except caller)
    v_notify_users := ARRAY[]::UUID[];
    IF v_post.profile_id != v_caller_id THEN
        v_notify_users := array_append(v_notify_users, v_post.profile_id);
    END IF;
    IF v_post.post_arranged_to IS NOT NULL AND v_post.post_arranged_to != v_caller_id THEN
        v_notify_users := array_append(v_notify_users, v_post.post_arranged_to);
    END IF;

    -- Log cancellation activity BEFORE clearing the data
    INSERT INTO public.post_activity_logs (post_id, actor_id, activity_type, metadata)
    VALUES (p_post_id, v_caller_id, 'arrangement_cancelled', jsonb_build_object(
        'cancelled_by', v_caller_id,
        'previous_sharer', v_post.profile_id,
        'previous_requester', v_post.post_arranged_to,
        'cancelled_at', now()
    ));

    -- Clear arrangement
    UPDATE public.posts
    SET
        is_arranged = false,
        post_arranged_to = NULL,
        post_arranged_at = NULL,
        updated_at = now()
    WHERE id = p_post_id;

    RETURN jsonb_build_object(
        'success', true,
        'error', NULL,
        'postId', p_post_id,
        'postName', v_post.post_name,
        'notifyUserIds', v_notify_users
    );
END;
$$;

-- =============================================================================
-- DEACTIVATE POST (Mark as completed/collected)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.deactivate_post(
    p_post_id INT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_post RECORD;
    v_caller_id UUID;
BEGIN
    v_caller_id := auth.uid();

    -- Get post
    SELECT * INTO v_post FROM public.posts WHERE id = p_post_id;

    IF v_post IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', jsonb_build_object(
                'code', 'RESOURCE_NOT_FOUND',
                'message', 'Post not found'
            )
        );
    END IF;

    -- Verify caller is owner or arranged user
    IF v_caller_id != v_post.profile_id AND v_caller_id != v_post.post_arranged_to THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', jsonb_build_object(
                'code', 'AUTH_FORBIDDEN',
                'message', 'Only the owner or arranged user can deactivate'
            )
        );
    END IF;

    -- Deactivate
    UPDATE public.posts
    SET
        is_active = false,
        updated_at = now()
    WHERE id = p_post_id;

    -- Log activity
    INSERT INTO public.post_activity_logs (post_id, actor_id, activity_type, metadata)
    VALUES (p_post_id, v_caller_id, 'deactivated', jsonb_build_object(
        'deactivated_by', v_caller_id,
        'was_arranged', v_post.is_arranged,
        'deactivated_at', now()
    ));

    RETURN jsonb_build_object(
        'success', true,
        'error', NULL,
        'postId', p_post_id
    );
END;
$$;

-- =============================================================================
-- Grants
-- =============================================================================

GRANT EXECUTE ON FUNCTION public.create_listing_transactional TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_listing_transactional TO authenticated;
GRANT EXECUTE ON FUNCTION public.arrange_post TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_arrangement TO authenticated;
GRANT EXECUTE ON FUNCTION public.deactivate_post TO authenticated;

-- Service role for Edge Functions
GRANT EXECUTE ON FUNCTION public.create_listing_transactional TO service_role;
GRANT EXECUTE ON FUNCTION public.update_listing_transactional TO service_role;
GRANT EXECUTE ON FUNCTION public.arrange_post TO service_role;
GRANT EXECUTE ON FUNCTION public.cancel_arrangement TO service_role;
GRANT EXECUTE ON FUNCTION public.deactivate_post TO service_role;

-- =============================================================================
-- Comments
-- =============================================================================

COMMENT ON FUNCTION public.create_listing_transactional IS
'Creates a listing with server-side validation in a single transaction.
Returns: { success, error, listing }
Validates, inserts, logs activity, and returns the created listing.';

COMMENT ON FUNCTION public.update_listing_transactional IS
'Updates a listing with validation and ownership check.
Returns: { success, error, listing }
Only updates provided non-null fields.';

COMMENT ON FUNCTION public.arrange_post IS
'Atomically arranges a post for pickup with race condition protection.
Returns: { success, error, post, notifyUserId }
Uses row-level locking to prevent double arrangements.';

COMMENT ON FUNCTION public.cancel_arrangement IS
'Cancels an arrangement. Can be called by either owner or arranged user.
Returns: { success, error, notifyUserIds }
Returns list of users to notify about cancellation.';

COMMENT ON FUNCTION public.deactivate_post IS
'Deactivates a post (marks as completed/collected).
Returns: { success, error, postId }
Can be called by owner or arranged user.';
