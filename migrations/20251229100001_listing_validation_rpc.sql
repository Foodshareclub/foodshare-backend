-- Migration: Listing Validation RPC Functions
-- Purpose: Server-side validation for listings (thin client architecture)
-- Supports: Cross-platform apps (iOS, Android, Web)

-- =============================================================================
-- Validation RPC Functions
-- =============================================================================

-- Function to validate listing data before creation
-- Returns validation result with errors array and sanitized data
CREATE OR REPLACE FUNCTION public.validate_listing(
    p_title TEXT,
    p_description TEXT DEFAULT NULL,
    p_images TEXT[] DEFAULT NULL,
    p_post_type TEXT DEFAULT 'food',
    p_latitude DOUBLE PRECISION DEFAULT NULL,
    p_longitude DOUBLE PRECISION DEFAULT NULL,
    p_pickup_address TEXT DEFAULT NULL,
    p_pickup_time TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    v_errors JSONB := '[]'::JSONB;
    v_title TEXT;
    v_description TEXT;
    v_valid_types TEXT[] := ARRAY['food', 'things', 'borrow', 'wanted', 'zerowaste', 'vegan'];
BEGIN
    -- Sanitize title (trim whitespace)
    v_title := TRIM(COALESCE(p_title, ''));
    v_description := TRIM(COALESCE(p_description, ''));

    -- ==========================================================================
    -- Title Validation
    -- ==========================================================================
    IF v_title = '' THEN
        v_errors := v_errors || jsonb_build_object(
            'field', 'title',
            'code', 'VALIDATION_REQUIRED',
            'message', 'Title is required'
        );
    ELSIF LENGTH(v_title) < 3 THEN
        v_errors := v_errors || jsonb_build_object(
            'field', 'title',
            'code', 'VALIDATION_TOO_SHORT',
            'message', 'Title must be at least 3 characters'
        );
    ELSIF LENGTH(v_title) > 100 THEN
        v_errors := v_errors || jsonb_build_object(
            'field', 'title',
            'code', 'VALIDATION_TOO_LONG',
            'message', 'Title must be less than 100 characters'
        );
    END IF;

    -- ==========================================================================
    -- Description Validation (optional but has max length)
    -- ==========================================================================
    IF v_description <> '' AND LENGTH(v_description) > 2000 THEN
        v_errors := v_errors || jsonb_build_object(
            'field', 'description',
            'code', 'VALIDATION_TOO_LONG',
            'message', 'Description must be less than 2000 characters'
        );
    END IF;

    -- ==========================================================================
    -- Images Validation
    -- ==========================================================================
    IF p_images IS NULL OR array_length(p_images, 1) IS NULL OR array_length(p_images, 1) < 1 THEN
        v_errors := v_errors || jsonb_build_object(
            'field', 'images',
            'code', 'VALIDATION_REQUIRED',
            'message', 'At least one image is required'
        );
    ELSIF array_length(p_images, 1) > 3 THEN
        v_errors := v_errors || jsonb_build_object(
            'field', 'images',
            'code', 'VALIDATION_TOO_MANY',
            'message', 'Maximum 3 images allowed'
        );
    END IF;

    -- ==========================================================================
    -- Post Type Validation
    -- ==========================================================================
    IF p_post_type IS NULL OR NOT (p_post_type = ANY(v_valid_types)) THEN
        v_errors := v_errors || jsonb_build_object(
            'field', 'postType',
            'code', 'VALIDATION_INVALID',
            'message', 'Invalid post type. Must be one of: ' || array_to_string(v_valid_types, ', ')
        );
    END IF;

    -- ==========================================================================
    -- Location Validation
    -- ==========================================================================
    IF p_latitude IS NULL OR p_longitude IS NULL THEN
        v_errors := v_errors || jsonb_build_object(
            'field', 'location',
            'code', 'VALIDATION_REQUIRED',
            'message', 'Location coordinates are required'
        );
    ELSIF p_latitude < -90 OR p_latitude > 90 THEN
        v_errors := v_errors || jsonb_build_object(
            'field', 'latitude',
            'code', 'VALIDATION_INVALID',
            'message', 'Latitude must be between -90 and 90'
        );
    ELSIF p_longitude < -180 OR p_longitude > 180 THEN
        v_errors := v_errors || jsonb_build_object(
            'field', 'longitude',
            'code', 'VALIDATION_INVALID',
            'message', 'Longitude must be between -180 and 180'
        );
    END IF;

    -- ==========================================================================
    -- Return Result
    -- ==========================================================================
    RETURN jsonb_build_object(
        'valid', jsonb_array_length(v_errors) = 0,
        'errors', v_errors,
        'sanitized', CASE WHEN jsonb_array_length(v_errors) = 0 THEN
            jsonb_build_object(
                'title', v_title,
                'description', CASE WHEN v_description = '' THEN NULL ELSE v_description END,
                'images', p_images,
                'postType', p_post_type,
                'latitude', p_latitude,
                'longitude', p_longitude,
                'pickupAddress', TRIM(COALESCE(p_pickup_address, '')),
                'pickupTime', TRIM(COALESCE(p_pickup_time, ''))
            )
        ELSE NULL END
    );
END;
$$;

-- Function to validate update listing data
CREATE OR REPLACE FUNCTION public.validate_listing_update(
    p_listing_id INT,
    p_title TEXT DEFAULT NULL,
    p_description TEXT DEFAULT NULL,
    p_is_active BOOLEAN DEFAULT NULL,
    p_is_arranged BOOLEAN DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    v_errors JSONB := '[]'::JSONB;
    v_title TEXT;
    v_description TEXT;
    v_listing_exists BOOLEAN;
    v_is_owner BOOLEAN;
BEGIN
    -- Check if listing exists
    SELECT EXISTS(SELECT 1 FROM public.posts WHERE id = p_listing_id) INTO v_listing_exists;

    IF NOT v_listing_exists THEN
        v_errors := v_errors || jsonb_build_object(
            'field', 'listingId',
            'code', 'RESOURCE_NOT_FOUND',
            'message', 'Listing not found'
        );
        RETURN jsonb_build_object('valid', false, 'errors', v_errors, 'sanitized', NULL);
    END IF;

    -- Check ownership (caller must own the listing)
    SELECT profile_id = auth.uid() INTO v_is_owner FROM public.posts WHERE id = p_listing_id;

    IF NOT v_is_owner THEN
        v_errors := v_errors || jsonb_build_object(
            'field', 'listingId',
            'code', 'RESOURCE_FORBIDDEN',
            'message', 'You can only update your own listings'
        );
        RETURN jsonb_build_object('valid', false, 'errors', v_errors, 'sanitized', NULL);
    END IF;

    -- Validate title if provided
    IF p_title IS NOT NULL THEN
        v_title := TRIM(p_title);
        IF LENGTH(v_title) < 3 THEN
            v_errors := v_errors || jsonb_build_object(
                'field', 'title',
                'code', 'VALIDATION_TOO_SHORT',
                'message', 'Title must be at least 3 characters'
            );
        ELSIF LENGTH(v_title) > 100 THEN
            v_errors := v_errors || jsonb_build_object(
                'field', 'title',
                'code', 'VALIDATION_TOO_LONG',
                'message', 'Title must be less than 100 characters'
            );
        END IF;
    END IF;

    -- Validate description if provided
    IF p_description IS NOT NULL THEN
        v_description := TRIM(p_description);
        IF LENGTH(v_description) > 2000 THEN
            v_errors := v_errors || jsonb_build_object(
                'field', 'description',
                'code', 'VALIDATION_TOO_LONG',
                'message', 'Description must be less than 2000 characters'
            );
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'valid', jsonb_array_length(v_errors) = 0,
        'errors', v_errors,
        'sanitized', CASE WHEN jsonb_array_length(v_errors) = 0 THEN
            jsonb_build_object(
                'listingId', p_listing_id,
                'title', v_title,
                'description', v_description,
                'isActive', p_is_active,
                'isArranged', p_is_arranged
            )
        ELSE NULL END
    );
END;
$$;

-- =============================================================================
-- Grants
-- =============================================================================

-- Grant execute to authenticated users (they call this before creating listings)
GRANT EXECUTE ON FUNCTION public.validate_listing TO authenticated;
GRANT EXECUTE ON FUNCTION public.validate_listing_update TO authenticated;

-- Service role also needs access for Edge Functions
GRANT EXECUTE ON FUNCTION public.validate_listing TO service_role;
GRANT EXECUTE ON FUNCTION public.validate_listing_update TO service_role;

-- =============================================================================
-- Comments
-- =============================================================================

COMMENT ON FUNCTION public.validate_listing IS
'Server-side validation for listing creation. Returns { valid, errors[], sanitized }.
Called by iOS/Android clients before creating a listing to ensure data integrity.
This is the single source of truth for validation rules.';

COMMENT ON FUNCTION public.validate_listing_update IS
'Server-side validation for listing updates. Checks ownership and validates provided fields.
Returns { valid, errors[], sanitized }.';
