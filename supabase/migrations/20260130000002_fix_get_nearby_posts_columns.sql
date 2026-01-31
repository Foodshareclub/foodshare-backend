-- Fix get_nearby_posts to match actual posts_with_location schema
-- Removes non-existent columns that were causing 42703 errors

DROP FUNCTION IF EXISTS get_nearby_posts(DOUBLE PRECISION, DOUBLE PRECISION, INTEGER, UUID, TEXT, INTEGER, INTEGER);

CREATE OR REPLACE FUNCTION get_nearby_posts(
    p_latitude DOUBLE PRECISION,
    p_longitude DOUBLE PRECISION,
    p_radius_meters INTEGER,
    p_user_id UUID DEFAULT NULL,
    p_post_type TEXT DEFAULT NULL,
    p_limit INTEGER DEFAULT 50,
    p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
    id BIGINT,
    profile_id UUID,
    post_name TEXT,
    post_description TEXT,
    post_type TEXT,
    pickup_time TEXT,
    post_address TEXT,
    post_stripped_address TEXT,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    images TEXT[],
    is_active BOOLEAN,
    is_arranged BOOLEAN,
    post_views INTEGER,
    category_id BIGINT,
    tags TEXT[],
    quantity TEXT,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    distance_meters DOUBLE PRECISION
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        p.id,
        p.profile_id,
        p.post_name,
        p.post_description,
        p.post_type,
        p.pickup_time,
        p.post_address,
        p.post_stripped_address,
        p.latitude,
        p.longitude,
        p.images,
        p.is_active,
        p.is_arranged,
        p.post_views,
        p.category_id,
        p.tags,
        p.quantity,
        p.created_at,
        p.updated_at,
        ST_Distance(
            p.location::geography,
            ST_SetSRID(ST_MakePoint(p_longitude, p_latitude), 4326)::geography
        ) AS distance_meters
    FROM posts_with_location p
    WHERE
        ST_DWithin(
            p.location::geography,
            ST_SetSRID(ST_MakePoint(p_longitude, p_latitude), 4326)::geography,
            p_radius_meters
        )
        AND p.is_active = true
        AND p.is_arranged = false
        AND (p_post_type IS NULL OR p.post_type = p_post_type)
        AND (
            p_user_id IS NULL
            OR NOT EXISTS (
                SELECT 1
                FROM blocked_users bu
                WHERE bu.user_id = p_user_id
                AND bu.blocked_user_id = p.profile_id
            )
        )
    ORDER BY distance_meters ASC
    LIMIT p_limit
    OFFSET p_offset;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION get_nearby_posts(DOUBLE PRECISION, DOUBLE PRECISION, INTEGER, UUID, TEXT, INTEGER, INTEGER) TO authenticated, anon;

COMMENT ON FUNCTION get_nearby_posts(DOUBLE PRECISION, DOUBLE PRECISION, INTEGER, UUID, TEXT, INTEGER, INTEGER) IS
'Fetch posts near a location with optional user blocking filter.
When p_user_id is NULL (anonymous), returns all nearby posts.
When p_user_id is provided (authenticated), excludes blocked users.';
