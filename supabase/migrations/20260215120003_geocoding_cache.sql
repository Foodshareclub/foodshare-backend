-- Persistent geocoding cache: survives cold starts unlike in-memory Map
-- Used by _shared/geocoding.ts for Nominatim result caching

CREATE TABLE IF NOT EXISTS geocoding_cache (
  address TEXT PRIMARY KEY,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  display_name TEXT,
  cached_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for TTL-based cleanup
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_geocoding_cached_at
  ON geocoding_cache(cached_at);

-- Cleanup function for expired entries (30-day TTL)
CREATE OR REPLACE FUNCTION cleanup_geocoding_cache(p_max_age_days INTEGER DEFAULT 30)
RETURNS INTEGER AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM geocoding_cache
  WHERE cached_at < NOW() - (p_max_age_days || ' days')::INTERVAL;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$ LANGUAGE plpgsql;
