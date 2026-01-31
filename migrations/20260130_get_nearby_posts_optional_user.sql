-- Make user_id optional for anonymous location-based queries
-- Maintains blocking filter for authenticated users
-- Skips blocking filter when user_id is NULL

-- Drop existing function (different parameter order)
DROP FUNCTION IF EXISTS get_nearby_posts(UUID, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER, TEXT, INTEGER, INTEGER);

CREATE OR REPLACE FUNCTION get_nearby_posts(
    p_latitude DOUBLE PRECISION,
    p_longitude DOUBLE PRECISION,
    p_radius_meters INTEGER,
    p_user_id UUID DEFAULT NULL,  -- NOW OPTIONAL (moved after required params)
    p_post_type TEXT DEFAULT NULL,
    p_limit INTEGER DEFAULT 50,
    p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
    id INTEGER,
    profile_id UUID,
    post_name TEXT,
    post_description TEXT,
    post_type TEXT,
    pickup_time TEXT,
    available_hours TEXT,
    post_address TEXT,
    post_stripped_address TEXT,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    images TEXT[],
    is_active BOOLEAN,
    is_arranged BOOLEAN,
    post_arranged_to UUID,
    post_arranged_at TIMESTAMPTZ,
    post_views INTEGER,
    post_like_counter INTEGER,
    has_pantry BOOLEAN,
    condition TEXT,
    network TEXT,
    website TEXT,
    donation TEXT,
    donation_rules TEXT,
    category_id INTEGER,
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
        p.available_hours,
        p.post_address,
        p.post_stripped_address,
        p.latitude,
        p.longitude,
        p.images,
        p.is_active,
        p.is_arranged,
        p.post_arranged_to,
        p.post_arranged_at,
        p.post_views,
        p.post_like_counter,
        p.has_pantry,
        p.condition,
        p.network,
        p.website,
        p.donation,
        p.donation_rules,
        p.category_id,
        p.created_at,
        p.updated_at,
        ST_Distance(
            p.location::geography,
            ST_SetSRID(ST_MakePoint(p_longitude, p_latitude), 4326)::geography
        ) AS distance_meters
    FROM posts_with_location p
    WHERE
        -- PostGIS distance filter
        ST_DWithin(
            p.location::geography,
            ST_SetSRID(ST_MakePoint(p_longitude, p_latitude), 4326)::geography,
            p_radius_meters
        )
        -- Active and not arranged
        AND p.is_active = true
        AND p.is_arranged = false
        -- Optional post type filter
        AND (p_post_type IS NULL OR p.post_type = p_post_type)
        -- BLOCKING FILTER: Only apply if user_id provided
        AND (
            p_user_id IS NULL
            OR NOT EXISTS (
                SELECT 1
                FROM blocked_users bu
                WHERE bu.blocker_id = p_user_id
                AND bu.blocked_id = p.profile_id
            )
        )
    ORDER BY distance_meters ASC
    LIMIT p_limit
    OFFSET p_offset;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Grant execute to authenticated and anonymous users
GRANT EXECUTE ON FUNCTION get_nearby_posts(DOUBLE PRECISION, DOUBLE PRECISION, INTEGER, UUID, TEXT, INTEGER, INTEGER) TO authenticated, anon;

-- Add comment
COMMENT ON FUNCTION get_nearby_posts(DOUBLE PRECISION, DOUBLE PRECISION, INTEGER, UUID, TEXT, INTEGER, INTEGER) IS
'Fetch posts near a location with optional user blocking filter.
When p_user_id is NULL (anonymous), returns all nearby posts.
When p_user_id is provided (authenticated), excludes blocked users.';
