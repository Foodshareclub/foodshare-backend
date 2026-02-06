-- Products with location privacy (Supabase function)
-- Replaces /api/products to reduce Vercel function calls

CREATE OR REPLACE FUNCTION get_products_with_privacy(
  p_type TEXT DEFAULT NULL,
  p_search TEXT DEFAULT NULL,
  p_user_id UUID DEFAULT NULL,
  p_cursor BIGINT DEFAULT NULL,
  p_limit INTEGER DEFAULT 20,
  p_locations_only BOOLEAN DEFAULT FALSE,
  p_requesting_user_id UUID DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  result JSON;
  query_text TEXT;
BEGIN
  -- Apply location privacy unless user owns the post
  WITH filtered_posts AS (
    SELECT 
      *,
      CASE 
        WHEN profile_id = p_requesting_user_id THEN location_json
        ELSE ST_AsGeoJSON(
          ST_Translate(
            ST_GeomFromGeoJSON(location_json::text),
            (random() - 0.5) * 0.002, -- ~200m offset
            (random() - 0.5) * 0.002
          )
        )::json
      END as privacy_location_json
    FROM posts_with_location
    WHERE is_active = true
      AND (p_type IS NULL OR p_type = 'all' OR post_type = p_type)
      AND (p_search IS NULL OR post_name ILIKE '%' || p_search || '%')
      AND (p_user_id IS NULL OR profile_id = p_user_id)
      AND (p_cursor IS NULL OR id < p_cursor)
    ORDER BY id DESC
    LIMIT p_limit + 1
  )
  SELECT json_build_object(
    'data', json_agg(
      CASE 
        WHEN p_locations_only THEN 
          json_build_object(
            'id', id,
            'location_json', privacy_location_json,
            'post_name', post_name,
            'post_type', post_type,
            'images', images
          )
        ELSE 
          to_json(filtered_posts.*) || json_build_object('location_json', privacy_location_json)
      END
    ),
    'hasMore', count(*) > p_limit,
    'nextCursor', CASE WHEN count(*) > p_limit THEN 
      (SELECT id FROM filtered_posts ORDER BY id DESC LIMIT 1 OFFSET p_limit)
    END
  )
  INTO result
  FROM filtered_posts;
  
  RETURN result;
END;
$$;
