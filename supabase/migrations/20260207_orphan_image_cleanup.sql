-- Orphan Image Detection
-- RPC function to find images in image_upload_metrics that are not
-- referenced by any post (posts.images) or profile (profiles.avatar_url).
-- Used by api-v1-images/cleanup endpoint.

-- Index to speed up the orphan scan (path lookups)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_image_upload_metrics_path
  ON image_upload_metrics (path);

-- find_orphan_images: returns unreferenced images older than a grace period
CREATE OR REPLACE FUNCTION find_orphan_images(
  grace_period_hours INT DEFAULT 24,
  batch_limit INT DEFAULT 100
)
RETURNS TABLE (
  metric_id BIGINT,
  bucket TEXT,
  path TEXT,
  storage TEXT,
  compressed_size BIGINT,
  uploaded_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    m.id       AS metric_id,
    m.bucket,
    m.path,
    m.storage,
    m.compressed_size,
    m.uploaded_at
  FROM image_upload_metrics m
  WHERE m.uploaded_at < NOW() - make_interval(hours => grace_period_hours)
    -- Not referenced in any post's images array
    AND NOT EXISTS (
      SELECT 1
      FROM posts p,
           LATERAL unnest(p.images) AS img
      WHERE img LIKE '%' || m.path || '%'
    )
    -- Not referenced as a profile avatar
    AND NOT EXISTS (
      SELECT 1
      FROM profiles pr
      WHERE pr.avatar_url LIKE '%' || m.path || '%'
    )
  ORDER BY m.uploaded_at ASC
  LIMIT batch_limit;
$$;

COMMENT ON FUNCTION find_orphan_images IS
  'Finds uploaded images not referenced by any post or profile. Used by api-v1-images/cleanup endpoint.';
