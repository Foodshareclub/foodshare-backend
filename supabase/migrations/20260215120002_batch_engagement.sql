-- Batch engagement RPC: replace 3 queries with single call for feed engagement data
-- Used by api-v1-engagement for batch post engagement checks

CREATE OR REPLACE FUNCTION get_batch_engagement(
  p_post_ids BIGINT[],
  p_user_id UUID DEFAULT NULL
)
RETURNS JSONB AS $$
  SELECT COALESCE(
    jsonb_object_agg(
      post_id::TEXT,
      jsonb_build_object(
        'likeCount', like_count,
        'isLiked', COALESCE(is_liked, false),
        'isBookmarked', COALESCE(is_bookmarked, false)
      )
    ),
    '{}'::JSONB
  )
  FROM (
    SELECT
      p.id AS post_id,
      (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id) AS like_count,
      (SELECT EXISTS(SELECT 1 FROM post_likes pl WHERE pl.post_id = p.id AND pl.profile_id = p_user_id)) AS is_liked,
      (SELECT EXISTS(SELECT 1 FROM post_bookmarks pb WHERE pb.post_id = p.id AND pb.profile_id = p_user_id)) AS is_bookmarked
    FROM UNNEST(p_post_ids) AS p(id)
  ) aggregated;
$$ LANGUAGE SQL STABLE;
