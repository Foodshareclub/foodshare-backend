-- get_feed_initial_data: Combines categories + feed items + trending into single call
-- Reduces 3 API calls to 1 for initial feed load
-- Used by FeedViewModel.loadInitialData()

CREATE OR REPLACE FUNCTION get_feed_initial_data(
    p_latitude DOUBLE PRECISION,
    p_longitude DOUBLE PRECISION,
    p_radius_km DOUBLE PRECISION DEFAULT 10,
    p_feed_limit INT DEFAULT 20,
    p_trending_limit INT DEFAULT 5,
    p_post_type TEXT DEFAULT NULL,
    p_category_id BIGINT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_search_radius_m DOUBLE PRECISION;
    v_trending_radius_m DOUBLE PRECISION;
    v_result JSONB;
BEGIN
    v_search_radius_m := p_radius_km * 1000;
    v_trending_radius_m := p_radius_km * 1000 * 2; -- Wider radius for trending

    WITH
    -- Categories (static, no location filter)
    active_categories AS (
        SELECT id, name, description, icon_url, color, sort_order
        FROM categories
        WHERE is_active = TRUE
        ORDER BY sort_order ASC
    ),
    -- Feed items (location-filtered)
    feed_posts AS (
        SELECT
            p.*,
            ROUND((extensions.ST_Distance(
                p.location,
                extensions.ST_SetSRID(extensions.ST_MakePoint(p_longitude, p_latitude), 4326)::extensions.geography
            ) / 1000)::NUMERIC, 2) AS distance_km,
            EXTRACT(EPOCH FROM (NOW() - p.created_at)) / 3600 AS age_hours
        FROM posts p
        WHERE
            extensions.ST_DWithin(
                p.location,
                extensions.ST_SetSRID(extensions.ST_MakePoint(p_longitude, p_latitude), 4326)::extensions.geography,
                v_search_radius_m
            )
            AND p.is_arranged = FALSE
            AND p.is_active = TRUE
            AND p.location IS NOT NULL
            AND (p_category_id IS NULL OR p.category_id = p_category_id)
            AND (p_post_type IS NULL OR p.post_type = p_post_type)
        ORDER BY p.created_at DESC
        LIMIT p_feed_limit
    ),
    -- Trending items (wider radius, engagement-sorted)
    trending_posts AS (
        SELECT
            p.*,
            COALESCE(p.post_views, 0) + COALESCE(p.post_like_counter, 0) * 2 AS engagement_score,
            ROUND((extensions.ST_Distance(
                p.location,
                extensions.ST_SetSRID(extensions.ST_MakePoint(p_longitude, p_latitude), 4326)::extensions.geography
            ) / 1000)::NUMERIC, 2) AS distance_km,
            EXTRACT(EPOCH FROM (NOW() - p.created_at)) / 3600 AS age_hours
        FROM posts p
        WHERE
            extensions.ST_DWithin(
                p.location,
                extensions.ST_SetSRID(extensions.ST_MakePoint(p_longitude, p_latitude), 4326)::extensions.geography,
                v_trending_radius_m
            )
            AND p.is_arranged = FALSE
            AND p.is_active = TRUE
            AND p.location IS NOT NULL
        ORDER BY (COALESCE(p.post_views, 0) + COALESCE(p.post_like_counter, 0) * 2) DESC, p.created_at DESC
        LIMIT p_trending_limit
    ),
    -- Feed stats
    feed_stats AS (
        SELECT
            COUNT(*) AS total_count,
            COUNT(*) FILTER (WHERE post_type = 'food') AS food_count,
            COUNT(*) FILTER (WHERE post_type = 'fridge') AS fridge_count,
            COUNT(*) FILTER (WHERE age_hours > 48) AS urgent_count
        FROM feed_posts
    )
    SELECT jsonb_build_object(
        'success', true,
        'categories', COALESCE(
            (SELECT jsonb_agg(
                jsonb_build_object(
                    'id', c.id,
                    'name', c.name,
                    'description', c.description,
                    'iconUrl', c.icon_url,
                    'color', c.color,
                    'sortOrder', c.sort_order
                ) ORDER BY c.sort_order
            ) FROM active_categories c),
            '[]'::jsonb
        ),
        'feedItems', COALESCE(
            (SELECT jsonb_agg(
                jsonb_build_object(
                    'id', fp.id,
                    'postName', fp.post_name,
                    'postType', fp.post_type,
                    'postDescription', fp.post_description,
                    'postAddress', fp.post_address,
                    'images', fp.images,
                    'distanceKm', fp.distance_km,
                    'ageHours', ROUND(fp.age_hours::NUMERIC, 1),
                    'postViews', COALESCE(fp.post_views, 0),
                    'postLikeCounter', COALESCE(fp.post_like_counter, 0),
                    'profileId', fp.profile_id,
                    'createdAt', fp.created_at,
                    'categoryId', fp.category_id,
                    'pickupTime', fp.pickup_time,
                    'availableHours', fp.available_hours
                ) ORDER BY fp.created_at DESC
            ) FROM feed_posts fp),
            '[]'::jsonb
        ),
        'trendingItems', COALESCE(
            (SELECT jsonb_agg(
                jsonb_build_object(
                    'id', tp.id,
                    'postName', tp.post_name,
                    'postType', tp.post_type,
                    'postDescription', tp.post_description,
                    'postAddress', tp.post_address,
                    'images', tp.images,
                    'engagementScore', tp.engagement_score,
                    'distanceKm', tp.distance_km,
                    'ageHours', ROUND(tp.age_hours::NUMERIC, 1),
                    'postViews', COALESCE(tp.post_views, 0),
                    'postLikeCounter', COALESCE(tp.post_like_counter, 0),
                    'profileId', tp.profile_id,
                    'createdAt', tp.created_at,
                    'categoryId', tp.category_id,
                    'pickupTime', tp.pickup_time
                ) ORDER BY tp.engagement_score DESC
            ) FROM trending_posts tp),
            '[]'::jsonb
        ),
        'stats', (SELECT row_to_json(s)::jsonb FROM feed_stats s),
        'metadata', jsonb_build_object(
            'searchRadiusKm', p_radius_km,
            'trendingRadiusKm', p_radius_km * 2,
            'feedLimit', p_feed_limit,
            'trendingLimit', p_trending_limit,
            'calculatedAt', NOW()
        )
    ) INTO v_result;

    RETURN v_result;
END;
$$;
