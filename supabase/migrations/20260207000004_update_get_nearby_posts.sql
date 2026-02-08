-- Migration: Update get_nearby_posts RPCs to return fridge-specific columns
-- Purpose: Include metadata, fridge_id, has_pantry, available_hours, location_type, condition
-- Note: Two overloaded versions exist - updating both

-- =============================================================================
-- Version 1: Legacy (uses direct posts table query)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.get_nearby_posts(
    user_lat double precision,
    user_lng double precision,
    radius_meters double precision DEFAULT 5000,
    post_type_filter text DEFAULT NULL::text,
    page_limit integer DEFAULT 50,
    page_cursor integer DEFAULT 0
) RETURNS TABLE(
    id bigint,
    profile_id uuid,
    post_name text,
    post_description text,
    post_type text,
    pickup_time text,
    available_hours text,
    post_address text,
    post_stripped_address text,
    latitude double precision,
    longitude double precision,
    images text[],
    is_active boolean,
    is_arranged boolean,
    post_arranged_to uuid,
    post_arranged_at timestamp with time zone,
    post_views integer,
    post_like_counter integer,
    has_pantry boolean,
    condition character varying,
    network text,
    website text,
    donation text,
    donation_rules text,
    category_id bigint,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    distance_meters double precision,
    -- New fridge columns
    metadata jsonb,
    fridge_id text,
    location_type text
)
LANGUAGE plpgsql STABLE
SET search_path TO 'public', 'extensions'
AS $$
BEGIN
    RETURN QUERY
    SELECT
        p.id, p.profile_id, p.post_name, p.post_description, p.post_type,
        p.pickup_time, p.available_hours, p.post_address, p.post_stripped_address,
        extensions.ST_Y(p.location::extensions.geometry),
        extensions.ST_X(p.location::extensions.geometry),
        p.images, p.is_active, p.is_arranged, p.post_arranged_to, p.post_arranged_at,
        p.post_views, p.post_like_counter, p.has_pantry, p.condition,
        p.network, p.website, p.donation, p.donation_rules, p.category_id,
        p.created_at, p.updated_at,
        extensions.ST_Distance(
            p.location,
            extensions.ST_SetSRID(extensions.ST_MakePoint(user_lng, user_lat), 4326)::extensions.geography
        ),
        -- New fridge columns
        p.metadata,
        p.fridge_id,
        p.location_type
    FROM public.posts p
    WHERE p.is_active = true
      AND p.is_arranged = false
      AND p.location IS NOT NULL
      AND extensions.ST_DWithin(
          p.location,
          extensions.ST_SetSRID(extensions.ST_MakePoint(user_lng, user_lat), 4326)::extensions.geography,
          radius_meters
      )
      AND (post_type_filter IS NULL OR p.post_type = post_type_filter)
    ORDER BY extensions.ST_Distance(
        p.location,
        extensions.ST_SetSRID(extensions.ST_MakePoint(user_lng, user_lat), 4326)::extensions.geography
    ) ASC
    LIMIT page_limit
    OFFSET page_cursor;
END;
$$;

-- =============================================================================
-- Version 2: Modern (uses posts_with_location view, blocked_users filtering)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.get_nearby_posts(
    p_latitude double precision,
    p_longitude double precision,
    p_radius_meters integer,
    p_user_id uuid DEFAULT NULL::uuid,
    p_post_type text DEFAULT NULL::text,
    p_limit integer DEFAULT 50,
    p_offset integer DEFAULT 0
) RETURNS TABLE(
    id bigint,
    profile_id uuid,
    post_name text,
    post_description text,
    post_type text,
    pickup_time text,
    post_address text,
    post_stripped_address text,
    latitude double precision,
    longitude double precision,
    images text[],
    is_active boolean,
    is_arranged boolean,
    post_views integer,
    category_id bigint,
    tags text[],
    quantity text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    distance_meters double precision,
    -- New fridge columns
    metadata jsonb,
    fridge_id text,
    has_pantry boolean,
    available_hours text,
    location_type text,
    condition character varying
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT
        p.id, p.profile_id, p.post_name, p.post_description, p.post_type,
        p.pickup_time, p.post_address, p.post_stripped_address,
        p.latitude, p.longitude, p.images, p.is_active, p.is_arranged,
        p.post_views, p.category_id, p.tags, p.quantity,
        p.created_at, p.updated_at,
        ST_Distance(
            p.location::geography,
            ST_SetSRID(ST_MakePoint(p_longitude, p_latitude), 4326)::geography
        ) AS distance_meters,
        -- New fridge columns
        p.metadata,
        p.fridge_id,
        p.has_pantry,
        p.available_hours,
        p.location_type,
        p.condition
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
$$;
