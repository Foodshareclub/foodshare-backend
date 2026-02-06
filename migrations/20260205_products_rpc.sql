-- Replace /api/products with direct Supabase calls
-- This eliminates Vercel function invocations

-- Function to get products with location privacy
CREATE OR REPLACE FUNCTION get_products_paginated(
  p_type TEXT DEFAULT NULL,
  p_search TEXT DEFAULT NULL,
  p_user_id UUID DEFAULT NULL,
  p_cursor BIGINT DEFAULT NULL,
  p_limit INTEGER DEFAULT 20,
  p_locations_only BOOLEAN DEFAULT FALSE,
  p_requesting_user_id UUID DEFAULT auth.uid()
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result JSON;
  items JSON[];
  has_more BOOLEAN := FALSE;
  next_cursor BIGINT;
BEGIN
  -- Build query with privacy-aware location handling
  WITH filtered_posts AS (
    SELECT 
      p.*,
      -- Apply location privacy: exact for owner, ~200m offset for others
      CASE 
        WHEN p.profile_id = p_requesting_user_id THEN p.location_json
        ELSE (
          SELECT json_build_object(
            'type', 'Point',
            'coordinates', json_build_array(
              (p.location_json->'coordinates'->>0)::float + (random() - 0.5) * 0.002,
              (p.location_json->'coordinates'->>1)::float + (random() - 0.5) * 0.002
            )
          )
        )
      END as safe_location_json
    FROM posts_with_location p
    WHERE p.is_active = true
      AND (p_type IS NULL OR p_type = 'all' OR p.post_type = p_type)
      AND (p_search IS NULL OR p.post_name ILIKE '%' || p_search || '%')
      AND (p_user_id IS NULL OR p.profile_id = p_user_id)
      AND (p_cursor IS NULL OR p.id < p_cursor)
    ORDER BY p.id DESC
    LIMIT p_limit + 1
  ),
  paginated_results AS (
    SELECT 
      fp.*,
      ROW_NUMBER() OVER () as rn,
      COUNT(*) OVER () as total_count
    FROM filtered_posts fp
  )
  SELECT 
    json_agg(
      CASE 
        WHEN p_locations_only THEN 
          json_build_object(
            'id', pr.id,
            'location_json', pr.safe_location_json,
            'post_name', pr.post_name,
            'post_type', pr.post_type,
            'images', pr.images
          )
        ELSE 
          to_json(pr) || json_build_object('location_json', pr.safe_location_json)
      END
    ) FILTER (WHERE pr.rn <= p_limit),
    CASE WHEN MAX(pr.total_count) > p_limit THEN TRUE ELSE FALSE END,
    CASE WHEN MAX(pr.total_count) > p_limit THEN 
      (SELECT id FROM paginated_results WHERE rn = p_limit)
    END
  INTO items, has_more, next_cursor
  FROM paginated_results pr;

  -- Build response
  SELECT json_build_object(
    'data', COALESCE(items, '[]'::json),
    'hasMore', COALESCE(has_more, false),
    'nextCursor', next_cursor
  ) INTO result;

  RETURN result;
END;
$$;

-- Function to get single product by ID
CREATE OR REPLACE FUNCTION get_product_by_id(
  p_id BIGINT,
  p_requesting_user_id UUID DEFAULT auth.uid()
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result JSON;
  is_owner BOOLEAN := FALSE;
BEGIN
  -- Check if requesting user owns this product
  SELECT (profile_id = p_requesting_user_id) INTO is_owner
  FROM posts_with_location 
  WHERE id = p_id AND is_active = true;

  -- Get product with appropriate location privacy
  SELECT 
    CASE 
      WHEN is_owner THEN to_json(p)
      ELSE to_json(p) || json_build_object(
        'location_json', 
        json_build_object(
          'type', 'Point',
          'coordinates', json_build_array(
            (p.location_json->'coordinates'->>0)::float + (random() - 0.5) * 0.002,
            (p.location_json->'coordinates'->>1)::float + (random() - 0.5) * 0.002
          )
        )
      )
    END
  INTO result
  FROM posts_with_location p
  WHERE p.id = p_id AND p.is_active = true;

  RETURN result;
END;
$$;
