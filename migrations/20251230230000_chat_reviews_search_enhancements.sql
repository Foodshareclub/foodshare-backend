-- =============================================================================
-- Chat, Reviews, and Search Enhancements Migration
-- =============================================================================
-- Adds missing RPC functions for:
-- - Chat: send_message, get_room_messages, mark_messages_read
-- - Reviews: submit_review, can_review_post
-- - Search: advanced search with dietary preferences, saved filters, search history
-- =============================================================================

-- =============================================================================
-- PART 1: Chat Functions
-- =============================================================================

-- get_room_messages: Paginated message history for a chat room
CREATE OR REPLACE FUNCTION get_room_messages(
  p_room_id UUID,
  p_user_id UUID,
  p_limit INT DEFAULT 50,
  p_cursor TIMESTAMPTZ DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
  v_is_member BOOLEAN;
BEGIN
  -- Verify user is a member of this room
  SELECT EXISTS(
    SELECT 1 FROM room_members
    WHERE room_id = p_room_id AND profile_id = p_user_id
  ) INTO v_is_member;

  IF NOT v_is_member THEN
    RETURN jsonb_build_object(
      'success', FALSE,
      'error', 'Not a member of this room'
    );
  END IF;

  -- Get messages with sender info
  SELECT jsonb_build_object(
    'success', TRUE,
    'messages', COALESCE(
      (SELECT jsonb_agg(msg_data ORDER BY created_at DESC)
       FROM (
         SELECT jsonb_build_object(
           'id', m.id,
           'room_id', m.room_id,
           'sender_id', m.profile_id,
           'sender_name', p.display_name,
           'sender_avatar', p.avatar_url,
           'content', m.content,
           'message_type', COALESCE(m.message_type, 'text'),
           'created_at', m.created_at,
           'is_from_me', m.profile_id = p_user_id
         ) AS msg_data,
         m.created_at
         FROM messages m
         JOIN profiles p ON p.id = m.profile_id
         WHERE m.room_id = p_room_id
           AND (p_cursor IS NULL OR m.created_at < p_cursor)
         ORDER BY m.created_at DESC
         LIMIT p_limit
       ) msgs),
      '[]'::JSONB
    ),
    'has_more', (
      SELECT COUNT(*) > p_limit
      FROM messages m
      WHERE m.room_id = p_room_id
        AND (p_cursor IS NULL OR m.created_at < p_cursor)
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- send_message: Send a message to a chat room
CREATE OR REPLACE FUNCTION send_message(
  p_room_id UUID,
  p_sender_id UUID,
  p_content TEXT,
  p_message_type TEXT DEFAULT 'text'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_message_id UUID;
  v_is_member BOOLEAN;
  v_result JSONB;
BEGIN
  -- Verify sender is a member of this room
  SELECT EXISTS(
    SELECT 1 FROM room_members
    WHERE room_id = p_room_id AND profile_id = p_sender_id
  ) INTO v_is_member;

  IF NOT v_is_member THEN
    RETURN jsonb_build_object(
      'success', FALSE,
      'error', 'Not a member of this room'
    );
  END IF;

  -- Validate content
  IF p_content IS NULL OR trim(p_content) = '' THEN
    RETURN jsonb_build_object(
      'success', FALSE,
      'error', 'Message content cannot be empty'
    );
  END IF;

  -- Insert the message
  INSERT INTO messages (room_id, profile_id, content, message_type, created_at)
  VALUES (p_room_id, p_sender_id, trim(p_content), p_message_type, NOW())
  RETURNING id INTO v_message_id;

  -- Update room's last message info
  UPDATE chat_rooms
  SET last_message_at = NOW(),
      updated_at = NOW()
  WHERE id = p_room_id;

  -- Increment unread count for other members
  UPDATE room_members
  SET unread_count = unread_count + 1
  WHERE room_id = p_room_id
    AND profile_id != p_sender_id;

  -- Return the created message
  SELECT jsonb_build_object(
    'success', TRUE,
    'message', jsonb_build_object(
      'id', m.id,
      'room_id', m.room_id,
      'sender_id', m.profile_id,
      'content', m.content,
      'message_type', m.message_type,
      'created_at', m.created_at
    )
  )
  INTO v_result
  FROM messages m
  WHERE m.id = v_message_id;

  RETURN v_result;
END;
$$;

-- mark_messages_read: Mark all messages in a room as read
CREATE OR REPLACE FUNCTION mark_messages_read(
  p_room_id UUID,
  p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Update the member's last read time and reset unread count
  UPDATE room_members
  SET last_read_at = NOW(),
      unread_count = 0
  WHERE room_id = p_room_id
    AND profile_id = p_user_id;

  RETURN jsonb_build_object(
    'success', TRUE,
    'room_id', p_room_id
  );
END;
$$;

-- =============================================================================
-- PART 2: Review Functions
-- =============================================================================

-- submit_review: Submit a review for a completed transaction
CREATE OR REPLACE FUNCTION submit_review(
  p_reviewer_id UUID,
  p_reviewee_id UUID,
  p_post_id UUID,
  p_rating INT,
  p_comment TEXT DEFAULT NULL,
  p_transaction_type TEXT DEFAULT 'shared'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_review_id INT;
  v_result JSONB;
BEGIN
  -- Validate rating
  IF p_rating < 1 OR p_rating > 5 THEN
    RETURN jsonb_build_object(
      'success', FALSE,
      'error', 'Rating must be between 1 and 5'
    );
  END IF;

  -- Validate transaction_type
  IF p_transaction_type NOT IN ('shared', 'received') THEN
    RETURN jsonb_build_object(
      'success', FALSE,
      'error', 'Transaction type must be shared or received'
    );
  END IF;

  -- Cannot review yourself
  IF p_reviewer_id = p_reviewee_id THEN
    RETURN jsonb_build_object(
      'success', FALSE,
      'error', 'Cannot review yourself'
    );
  END IF;

  -- Check if already reviewed
  IF EXISTS(
    SELECT 1 FROM reviews
    WHERE reviewer_id = p_reviewer_id
      AND reviewee_id = p_reviewee_id
      AND post_id = p_post_id
  ) THEN
    RETURN jsonb_build_object(
      'success', FALSE,
      'error', 'You have already reviewed this transaction'
    );
  END IF;

  -- Insert the review
  INSERT INTO reviews (reviewer_id, reviewee_id, post_id, rating, comment, transaction_type, created_at)
  VALUES (p_reviewer_id, p_reviewee_id, p_post_id, p_rating, NULLIF(trim(COALESCE(p_comment, '')), ''), p_transaction_type, NOW())
  RETURNING id INTO v_review_id;

  -- Update reviewee's rating stats
  UPDATE profiles
  SET rating_count = COALESCE(rating_count, 0) + 1,
      rating_average = (
        SELECT AVG(rating)::NUMERIC(3,2)
        FROM reviews
        WHERE reviewee_id = p_reviewee_id
      )
  WHERE id = p_reviewee_id;

  -- Return success with review data
  SELECT jsonb_build_object(
    'success', TRUE,
    'review', jsonb_build_object(
      'id', r.id,
      'rating', r.rating,
      'comment', r.comment,
      'transaction_type', r.transaction_type,
      'created_at', r.created_at
    )
  )
  INTO v_result
  FROM reviews r
  WHERE r.id = v_review_id;

  RETURN v_result;
END;
$$;

-- can_review_post: Check if user can review a specific post transaction
CREATE OR REPLACE FUNCTION can_review_post(
  p_user_id UUID,
  p_post_id UUID,
  p_other_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_already_reviewed BOOLEAN;
BEGIN
  -- Check if already reviewed
  SELECT EXISTS(
    SELECT 1 FROM reviews
    WHERE reviewer_id = p_user_id
      AND reviewee_id = p_other_user_id
      AND post_id = p_post_id
  ) INTO v_already_reviewed;

  RETURN jsonb_build_object(
    'can_review', NOT v_already_reviewed,
    'already_reviewed', v_already_reviewed
  );
END;
$$;

-- =============================================================================
-- PART 3: Advanced Search
-- =============================================================================

-- Saved filters table
CREATE TABLE IF NOT EXISTS saved_filters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  filters JSONB NOT NULL,
  is_default BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Search history table
CREATE TABLE IF NOT EXISTS search_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  query TEXT NOT NULL,
  filters JSONB,
  result_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE saved_filters ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_history ENABLE ROW LEVEL SECURITY;

-- RLS policies for saved_filters
CREATE POLICY saved_filters_select ON saved_filters
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY saved_filters_insert ON saved_filters
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY saved_filters_update ON saved_filters
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY saved_filters_delete ON saved_filters
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- RLS policies for search_history
CREATE POLICY search_history_select ON search_history
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY search_history_insert ON search_history
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY search_history_delete ON search_history
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- Indexes
CREATE INDEX IF NOT EXISTS idx_saved_filters_user ON saved_filters(user_id, is_default DESC);
CREATE INDEX IF NOT EXISTS idx_search_history_user ON search_history(user_id, created_at DESC);

-- save_filter_preset: Save a filter preset
CREATE OR REPLACE FUNCTION save_filter_preset(
  p_user_id UUID,
  p_name TEXT,
  p_filters JSONB,
  p_is_default BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_preset_id UUID;
BEGIN
  -- If setting as default, unset other defaults
  IF p_is_default THEN
    UPDATE saved_filters
    SET is_default = FALSE, updated_at = NOW()
    WHERE user_id = p_user_id AND is_default = TRUE;
  END IF;

  -- Insert new preset
  INSERT INTO saved_filters (user_id, name, filters, is_default)
  VALUES (p_user_id, p_name, p_filters, p_is_default)
  RETURNING id INTO v_preset_id;

  RETURN jsonb_build_object(
    'success', TRUE,
    'preset_id', v_preset_id
  );
END;
$$;

-- get_filter_presets: Get user's saved filter presets
CREATE OR REPLACE FUNCTION get_filter_presets(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN jsonb_build_object(
    'presets', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
        'id', id,
        'name', name,
        'filters', filters,
        'is_default', is_default,
        'created_at', created_at
      ) ORDER BY is_default DESC, created_at DESC)
       FROM saved_filters
       WHERE user_id = p_user_id),
      '[]'::JSONB
    )
  );
END;
$$;

-- get_search_history: Get user's recent searches
CREATE OR REPLACE FUNCTION get_search_history(
  p_user_id UUID,
  p_limit INT DEFAULT 10
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN jsonb_build_object(
    'history', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
        'id', id,
        'query', query,
        'result_count', result_count,
        'created_at', created_at
      ) ORDER BY created_at DESC)
       FROM (
         SELECT DISTINCT ON (query) *
         FROM search_history
         WHERE user_id = p_user_id
         ORDER BY query, created_at DESC
       ) unique_searches
       LIMIT p_limit),
      '[]'::JSONB
    )
  );
END;
$$;

-- record_search: Record a search query
CREATE OR REPLACE FUNCTION record_search(
  p_user_id UUID,
  p_query TEXT,
  p_filters JSONB DEFAULT NULL,
  p_result_count INT DEFAULT 0
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO search_history (user_id, query, filters, result_count)
  VALUES (p_user_id, p_query, p_filters, p_result_count);

  -- Keep only last 100 searches per user
  DELETE FROM search_history
  WHERE id IN (
    SELECT id FROM search_history
    WHERE user_id = p_user_id
    ORDER BY created_at DESC
    OFFSET 100
  );
END;
$$;

-- clear_search_history: Clear user's search history
CREATE OR REPLACE FUNCTION clear_search_history(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM search_history WHERE user_id = p_user_id;
END;
$$;

-- search_food_items_advanced: Extended search with dietary preferences
CREATE OR REPLACE FUNCTION search_food_items_advanced(
  p_search_query TEXT,
  p_latitude DOUBLE PRECISION DEFAULT NULL,
  p_longitude DOUBLE PRECISION DEFAULT NULL,
  p_radius_km INT DEFAULT 50,
  p_limit INT DEFAULT 20,
  p_offset INT DEFAULT 0,
  p_categories TEXT[] DEFAULT NULL,
  p_post_types TEXT[] DEFAULT NULL,
  p_dietary_preferences TEXT[] DEFAULT NULL,
  p_freshness_hours INT DEFAULT NULL,
  p_sort_by TEXT DEFAULT 'relevance'
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ts_query TSQUERY;
  v_has_location BOOLEAN;
  v_result JSONB;
BEGIN
  v_has_location := p_latitude IS NOT NULL AND p_longitude IS NOT NULL;

  -- Parse search query
  IF p_search_query IS NOT NULL AND trim(p_search_query) != '' THEN
    BEGIN
      v_ts_query := websearch_to_tsquery('english', p_search_query);
    EXCEPTION WHEN OTHERS THEN
      v_ts_query := plainto_tsquery('english', p_search_query);
    END;
  END IF;

  SELECT jsonb_build_object(
    'success', TRUE,
    'items', COALESCE(
      (SELECT jsonb_agg(item_data)
       FROM (
         SELECT jsonb_build_object(
           'id', fi.id,
           'post_name', fi.post_name,
           'description', fi.description,
           'post_type', fi.post_type,
           'images', fi.images,
           'latitude', fi.latitude,
           'longitude', fi.longitude,
           'pickup_address', fi.pickup_address,
           'category_id', fi.category_id,
           'profile_id', fi.profile_id,
           'profile_username', p.username,
           'profile_avatar_url', p.avatar_url,
           'created_at', fi.created_at,
           'distance_km', CASE
             WHEN v_has_location AND fi.latitude IS NOT NULL THEN
               ROUND((6371 * acos(
                 cos(radians(p_latitude)) * cos(radians(fi.latitude)) *
                 cos(radians(fi.longitude) - radians(p_longitude)) +
                 sin(radians(p_latitude)) * sin(radians(fi.latitude))
               ))::NUMERIC, 2)
             ELSE NULL
           END
         ) AS item_data
         FROM food_items fi
         LEFT JOIN profiles_foodshare p ON p.id = fi.profile_id
         WHERE fi.is_active = TRUE
           AND fi.deleted_at IS NULL
           -- Text search
           AND (v_ts_query IS NULL OR (
             to_tsvector('english', COALESCE(fi.post_name, '')) ||
             to_tsvector('english', COALESCE(fi.description, ''))
           ) @@ v_ts_query)
           -- Category filter
           AND (p_categories IS NULL OR fi.category_id IN (
             SELECT c.id FROM categories c WHERE c.slug = ANY(p_categories)
           ))
           -- Post type filter
           AND (p_post_types IS NULL OR fi.post_type = ANY(p_post_types))
           -- Dietary preferences (stored in post metadata)
           AND (p_dietary_preferences IS NULL OR fi.dietary_info && p_dietary_preferences)
           -- Freshness filter
           AND (p_freshness_hours IS NULL OR fi.created_at > NOW() - (p_freshness_hours || ' hours')::INTERVAL)
           -- Distance filter
           AND (NOT v_has_location OR fi.latitude IS NULL OR (
             6371 * acos(
               cos(radians(p_latitude)) * cos(radians(fi.latitude)) *
               cos(radians(fi.longitude) - radians(p_longitude)) +
               sin(radians(p_latitude)) * sin(radians(fi.latitude))
             )
           ) <= p_radius_km)
         ORDER BY
           CASE p_sort_by
             WHEN 'distance' THEN
               CASE WHEN v_has_location AND fi.latitude IS NOT NULL THEN
                 6371 * acos(
                   cos(radians(p_latitude)) * cos(radians(fi.latitude)) *
                   cos(radians(fi.longitude) - radians(p_longitude)) +
                   sin(radians(p_latitude)) * sin(radians(fi.latitude))
                 )
               ELSE 999999 END
             WHEN 'newest' THEN 0
             ELSE 0 -- relevance handled by ts_rank
           END,
           CASE WHEN p_sort_by = 'newest' THEN fi.created_at ELSE NULL END DESC NULLS LAST,
           fi.created_at DESC
         LIMIT p_limit
         OFFSET p_offset
       ) items),
      '[]'::JSONB
    ),
    'total_count', (
      SELECT COUNT(*)
      FROM food_items fi
      WHERE fi.is_active = TRUE
        AND fi.deleted_at IS NULL
        AND (v_ts_query IS NULL OR (
          to_tsvector('english', COALESCE(fi.post_name, '')) ||
          to_tsvector('english', COALESCE(fi.description, ''))
        ) @@ v_ts_query)
        AND (p_categories IS NULL OR fi.category_id IN (
          SELECT c.id FROM categories c WHERE c.slug = ANY(p_categories)
        ))
        AND (p_post_types IS NULL OR fi.post_type = ANY(p_post_types))
        AND (p_dietary_preferences IS NULL OR fi.dietary_info && p_dietary_preferences)
        AND (p_freshness_hours IS NULL OR fi.created_at > NOW() - (p_freshness_hours || ' hours')::INTERVAL)
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- =============================================================================
-- Grant Permissions
-- =============================================================================

GRANT EXECUTE ON FUNCTION get_room_messages TO authenticated;
GRANT EXECUTE ON FUNCTION send_message TO authenticated;
GRANT EXECUTE ON FUNCTION mark_messages_read TO authenticated;
GRANT EXECUTE ON FUNCTION submit_review TO authenticated;
GRANT EXECUTE ON FUNCTION can_review_post TO authenticated;
GRANT EXECUTE ON FUNCTION save_filter_preset TO authenticated;
GRANT EXECUTE ON FUNCTION get_filter_presets TO authenticated;
GRANT EXECUTE ON FUNCTION get_search_history TO authenticated;
GRANT EXECUTE ON FUNCTION record_search TO authenticated;
GRANT EXECUTE ON FUNCTION clear_search_history TO authenticated;
GRANT EXECUTE ON FUNCTION search_food_items_advanced TO authenticated;

-- =============================================================================
-- Comments
-- =============================================================================

COMMENT ON FUNCTION get_room_messages IS 'Get paginated message history for a chat room';
COMMENT ON FUNCTION send_message IS 'Send a message to a chat room with validation';
COMMENT ON FUNCTION mark_messages_read IS 'Mark all messages in a room as read for a user';
COMMENT ON FUNCTION submit_review IS 'Submit a review for a completed food transaction';
COMMENT ON FUNCTION can_review_post IS 'Check if user can review a specific post transaction';
COMMENT ON FUNCTION save_filter_preset IS 'Save a search filter preset for quick access';
COMMENT ON FUNCTION get_filter_presets IS 'Get user saved filter presets';
COMMENT ON FUNCTION get_search_history IS 'Get user recent search history (deduplicated)';
COMMENT ON FUNCTION record_search IS 'Record a search query for history';
COMMENT ON FUNCTION clear_search_history IS 'Clear user search history';
COMMENT ON FUNCTION search_food_items_advanced IS 'Advanced search with dietary preferences, freshness, and multiple sort options';
