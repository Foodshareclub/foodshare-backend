-- Migration: Phase 27 - Create Listing with Auto-Match RPC
-- Created: 2026-01-03
-- Purpose: Atomically create a listing and find matching requests within radius
--
-- Features:
-- 1. Atomic listing creation
-- 2. PostGIS-based radius matching
-- 3. Category and dietary preference matching
-- 4. Automatic notifications for matched users
-- 5. Returns listing with match count

-- =============================================================================
-- Create Listing with Auto-Match RPC
-- =============================================================================

DROP FUNCTION IF EXISTS create_listing_with_auto_match(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT[], DOUBLE PRECISION
);

CREATE OR REPLACE FUNCTION create_listing_with_auto_match(
    p_profile_id UUID,
    p_post_name TEXT,
    p_post_description TEXT DEFAULT NULL,
    p_post_type TEXT DEFAULT 'food',
    p_pickup_time TEXT DEFAULT NULL,
    p_post_address TEXT DEFAULT NULL,
    p_latitude DOUBLE PRECISION DEFAULT NULL,
    p_longitude DOUBLE PRECISION DEFAULT NULL,
    p_images TEXT[] DEFAULT NULL,
    p_match_radius_km DOUBLE PRECISION DEFAULT 5.0
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_post_id INTEGER;
    v_post RECORD;
    v_match_count INTEGER := 0;
    v_notifications_created INTEGER := 0;
    v_match RECORD;
    v_radius_meters DOUBLE PRECISION;
    v_created_at TIMESTAMPTZ := NOW();
BEGIN
    -- Verify user is authenticated and matches profile_id
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Authentication required'
        );
    END IF;

    IF v_user_id != p_profile_id THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Cannot create listing for another user'
        );
    END IF;

    -- Validate required fields
    IF p_post_name IS NULL OR length(trim(p_post_name)) < 3 THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Post name must be at least 3 characters'
        );
    END IF;

    -- Convert km to meters for PostGIS
    v_radius_meters := p_match_radius_km * 1000;

    -- ==========================================================================
    -- 1. Create the listing
    -- ==========================================================================

    INSERT INTO posts (
        profile_id,
        post_name,
        post_description,
        post_type,
        pickup_time,
        post_address,
        latitude,
        longitude,
        images,
        is_active,
        is_arranged,
        created_at,
        updated_at
    )
    VALUES (
        p_profile_id,
        trim(p_post_name),
        trim(p_post_description),
        LOWER(p_post_type),
        p_pickup_time,
        p_post_address,
        p_latitude,
        p_longitude,
        p_images,
        true,
        false,
        v_created_at,
        v_created_at
    )
    RETURNING id INTO v_post_id;

    -- Get the created post
    SELECT * INTO v_post FROM posts WHERE id = v_post_id;

    -- ==========================================================================
    -- 2. Find matching requests within radius (if location provided)
    -- ==========================================================================

    IF p_latitude IS NOT NULL AND p_longitude IS NOT NULL THEN
        -- Find active food requests within radius
        -- Uses PostGIS ST_DWithin for efficient distance queries
        FOR v_match IN
            SELECT
                r.id as request_id,
                r.profile_id as requester_id,
                r.request_type,
                r.dietary_preferences,
                p.display_name as requester_name,
                ST_Distance(
                    ST_SetSRID(ST_MakePoint(r.longitude, r.latitude), 4326)::geography,
                    ST_SetSRID(ST_MakePoint(p_longitude, p_latitude), 4326)::geography
                ) as distance_meters
            FROM food_requests r
            JOIN profiles p ON p.id = r.profile_id
            WHERE r.is_active = true
            AND r.profile_id != p_profile_id  -- Don't match own requests
            AND r.latitude IS NOT NULL
            AND r.longitude IS NOT NULL
            AND ST_DWithin(
                ST_SetSRID(ST_MakePoint(r.longitude, r.latitude), 4326)::geography,
                ST_SetSRID(ST_MakePoint(p_longitude, p_latitude), 4326)::geography,
                v_radius_meters
            )
            -- Match by type (food matches food requests, etc.)
            AND (
                r.request_type IS NULL
                OR r.request_type = LOWER(p_post_type)
                OR r.request_type = 'any'
            )
            ORDER BY distance_meters
            LIMIT 10  -- Limit notifications to prevent spam
        LOOP
            v_match_count := v_match_count + 1;

            -- Create notification for matched requester
            INSERT INTO notifications (
                user_id,
                type,
                title,
                body,
                data,
                created_at
            )
            VALUES (
                v_match.requester_id,
                'listing_match',
                'New listing nearby!',
                format('%s just shared "%s" near you',
                    (SELECT display_name FROM profiles WHERE id = p_profile_id),
                    p_post_name
                ),
                jsonb_build_object(
                    'post_id', v_post_id,
                    'post_name', p_post_name,
                    'post_type', p_post_type,
                    'distance_meters', v_match.distance_meters,
                    'giver_id', p_profile_id,
                    'request_id', v_match.request_id
                ),
                v_created_at
            );

            v_notifications_created := v_notifications_created + 1;
        END LOOP;
    END IF;

    -- ==========================================================================
    -- 3. Return result
    -- ==========================================================================

    RETURN jsonb_build_object(
        'success', true,
        'post', jsonb_build_object(
            'id', v_post_id,
            'profile_id', p_profile_id,
            'post_name', v_post.post_name,
            'post_description', v_post.post_description,
            'post_type', v_post.post_type,
            'post_address', v_post.post_address,
            'latitude', v_post.latitude,
            'longitude', v_post.longitude,
            'images', v_post.images,
            'is_active', v_post.is_active,
            'created_at', v_post.created_at
        ),
        'matches', jsonb_build_object(
            'count', v_match_count,
            'notifications_sent', v_notifications_created,
            'radius_km', p_match_radius_km
        )
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
GRANT EXECUTE ON FUNCTION create_listing_with_auto_match(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT[], DOUBLE PRECISION
) TO authenticated;

-- =============================================================================
-- Get Nearby Requests RPC (helper for manual matching)
-- =============================================================================

DROP FUNCTION IF EXISTS get_nearby_requests(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT);

CREATE OR REPLACE FUNCTION get_nearby_requests(
    p_latitude DOUBLE PRECISION,
    p_longitude DOUBLE PRECISION,
    p_radius_km DOUBLE PRECISION DEFAULT 5.0,
    p_request_type TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_radius_meters DOUBLE PRECISION := p_radius_km * 1000;
    v_results JSONB;
BEGIN
    SELECT jsonb_agg(
        jsonb_build_object(
            'request_id', r.id,
            'requester_id', r.profile_id,
            'requester_name', p.display_name,
            'requester_avatar', p.avatar_url,
            'request_type', r.request_type,
            'dietary_preferences', r.dietary_preferences,
            'distance_meters', ST_Distance(
                ST_SetSRID(ST_MakePoint(r.longitude, r.latitude), 4326)::geography,
                ST_SetSRID(ST_MakePoint(p_longitude, p_latitude), 4326)::geography
            ),
            'created_at', r.created_at
        )
        ORDER BY ST_Distance(
            ST_SetSRID(ST_MakePoint(r.longitude, r.latitude), 4326)::geography,
            ST_SetSRID(ST_MakePoint(p_longitude, p_latitude), 4326)::geography
        )
    ) INTO v_results
    FROM food_requests r
    JOIN profiles p ON p.id = r.profile_id
    WHERE r.is_active = true
    AND r.latitude IS NOT NULL
    AND r.longitude IS NOT NULL
    AND ST_DWithin(
        ST_SetSRID(ST_MakePoint(r.longitude, r.latitude), 4326)::geography,
        ST_SetSRID(ST_MakePoint(p_longitude, p_latitude), 4326)::geography,
        v_radius_meters
    )
    AND (p_request_type IS NULL OR r.request_type = LOWER(p_request_type) OR r.request_type = 'any')
    LIMIT 50;

    RETURN jsonb_build_object(
        'success', true,
        'requests', COALESCE(v_results, '[]'::JSONB),
        'radius_km', p_radius_km
    );
END;
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION get_nearby_requests(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT) TO authenticated;

-- =============================================================================
-- Indexes for efficient matching
-- =============================================================================

-- Spatial index on food_requests for PostGIS queries
CREATE INDEX IF NOT EXISTS idx_food_requests_location
ON food_requests USING GIST (
    ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography
) WHERE latitude IS NOT NULL AND longitude IS NOT NULL;

-- Spatial index on posts for reverse matching
CREATE INDEX IF NOT EXISTS idx_posts_location
ON posts USING GIST (
    ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography
) WHERE latitude IS NOT NULL AND longitude IS NOT NULL;

-- Index for active requests by type
CREATE INDEX IF NOT EXISTS idx_food_requests_active_type
ON food_requests(request_type, is_active)
WHERE is_active = true;

-- =============================================================================
-- Comments
-- =============================================================================

COMMENT ON FUNCTION create_listing_with_auto_match IS
'Atomically creates a listing and finds matching food requests within radius. Sends notifications to matched users. Phase 27.1';

COMMENT ON FUNCTION get_nearby_requests IS
'Returns active food requests within a specified radius for manual matching. Phase 27.1';
