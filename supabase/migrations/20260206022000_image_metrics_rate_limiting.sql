-- Image Upload Metrics & Rate Limiting
-- Production-ready monitoring and abuse prevention

-- Rate limiting table
CREATE TABLE IF NOT EXISTS user_rate_limits (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  key TEXT NOT NULL, -- e.g., 'image_upload_count'
  count INTEGER NOT NULL DEFAULT 0,
  reset_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, key)
);

CREATE INDEX IF NOT EXISTS idx_user_rate_limits_user_key ON user_rate_limits(user_id, key);
CREATE INDEX IF NOT EXISTS idx_user_rate_limits_reset ON user_rate_limits(reset_at);

-- Metrics table for monitoring
CREATE TABLE IF NOT EXISTS image_upload_metrics (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  bucket TEXT NOT NULL,
  path TEXT NOT NULL,
  original_size BIGINT NOT NULL,
  compressed_size BIGINT NOT NULL,
  saved_bytes BIGINT NOT NULL,
  compression_method TEXT NOT NULL, -- 'tinypng', 'cloudinary', 'none'
  processing_time_ms INTEGER NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_image_metrics_user ON image_upload_metrics(user_id);
CREATE INDEX IF NOT EXISTS idx_image_metrics_bucket ON image_upload_metrics(bucket);
CREATE INDEX IF NOT EXISTS idx_image_metrics_uploaded ON image_upload_metrics(uploaded_at DESC);

-- Metrics dashboard views
CREATE OR REPLACE VIEW image_upload_stats AS
SELECT
  bucket,
  COUNT(*) as total_uploads,
  SUM(original_size) as total_original_size,
  SUM(compressed_size) as total_compressed_size,
  SUM(saved_bytes) as total_saved_bytes,
  ROUND(AVG(processing_time_ms)) as avg_processing_time_ms,
  COUNT(DISTINCT user_id) as unique_users,
  DATE_TRUNC('day', uploaded_at) as upload_date
FROM image_upload_metrics
WHERE uploaded_at > NOW() - INTERVAL '30 days'
GROUP BY bucket, DATE_TRUNC('day', uploaded_at)
ORDER BY upload_date DESC, bucket;

CREATE OR REPLACE VIEW compression_efficiency AS
SELECT
  compression_method,
  COUNT(*) as uses,
  ROUND(AVG(saved_bytes::NUMERIC / NULLIF(original_size, 0) * 100), 2) as avg_savings_percent,
  SUM(saved_bytes) as total_saved_bytes,
  ROUND(AVG(processing_time_ms)) as avg_time_ms
FROM image_upload_metrics
WHERE uploaded_at > NOW() - INTERVAL '7 days'
GROUP BY compression_method
ORDER BY uses DESC;

CREATE OR REPLACE VIEW top_uploaders AS
SELECT
  user_id,
  COUNT(*) as upload_count,
  SUM(original_size) as total_size_uploaded,
  SUM(saved_bytes) as total_saved,
  MAX(uploaded_at) as last_upload
FROM image_upload_metrics
WHERE uploaded_at > NOW() - INTERVAL '30 days'
  AND user_id IS NOT NULL
GROUP BY user_id
ORDER BY upload_count DESC
LIMIT 100;

-- Cost tracking view (estimate based on storage)
CREATE OR REPLACE VIEW storage_costs AS
SELECT
  bucket,
  SUM(compressed_size) / 1024.0 / 1024.0 / 1024.0 as total_gb,
  ROUND((SUM(compressed_size) / 1024.0 / 1024.0 / 1024.0 * 0.021)::NUMERIC, 2) as estimated_monthly_cost_usd,
  COUNT(*) as file_count
FROM image_upload_metrics
WHERE uploaded_at > NOW() - INTERVAL '30 days'
GROUP BY bucket
ORDER BY total_gb DESC;

-- RLS policies
ALTER TABLE user_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE image_upload_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own rate limits"
  ON user_rate_limits FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can view own metrics"
  ON image_upload_metrics FOR SELECT
  USING (auth.uid() = user_id);

-- Service role can insert metrics
CREATE POLICY "Service can insert metrics"
  ON image_upload_metrics FOR INSERT
  WITH CHECK (true);

-- Cleanup old metrics (keep 90 days)
CREATE OR REPLACE FUNCTION cleanup_old_image_metrics()
RETURNS void AS $$
BEGIN
  DELETE FROM image_upload_metrics
  WHERE uploaded_at < NOW() - INTERVAL '90 days';
END;
$$ LANGUAGE plpgsql;

-- Schedule cleanup (weekly)
SELECT cron.schedule(
  'cleanup-image-metrics',
  '0 3 * * 0', -- Sunday 3am
  'SELECT cleanup_old_image_metrics();'
);

COMMENT ON TABLE user_rate_limits IS 'Rate limiting for image uploads (100/day per user)';
COMMENT ON TABLE image_upload_metrics IS 'Tracks all image uploads for monitoring and cost analysis';
COMMENT ON VIEW image_upload_stats IS 'Daily upload statistics by bucket';
COMMENT ON VIEW compression_efficiency IS 'Compression method performance comparison';
COMMENT ON VIEW top_uploaders IS 'Top 100 users by upload volume (last 30 days)';
COMMENT ON VIEW storage_costs IS 'Estimated storage costs by bucket';
