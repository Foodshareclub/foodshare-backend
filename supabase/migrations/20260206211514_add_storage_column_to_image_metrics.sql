-- Add storage provider tracking to image upload metrics
-- Tracks whether each upload went to R2 (primary) or Supabase Storage (fallback)

ALTER TABLE image_upload_metrics
  ADD COLUMN IF NOT EXISTS storage text NOT NULL DEFAULT 'supabase';

COMMENT ON COLUMN image_upload_metrics.storage IS 'Storage provider: r2 or supabase';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_image_upload_metrics_storage
  ON image_upload_metrics (storage);
