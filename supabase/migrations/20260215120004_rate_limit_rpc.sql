-- Distributed rate limiting: database-backed rate limit store for multi-instance deployments
-- Used by _shared/rate-limiter.ts checkDistributedRateLimit()

CREATE TABLE IF NOT EXISTS rate_limit_entries (
  id BIGSERIAL PRIMARY KEY,
  key TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

-- Index for fast lookups and cleanup
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rate_limit_key_created
  ON rate_limit_entries(key, created_at);

-- Auto-cleanup: partition-style TTL using created_at
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rate_limit_cleanup
  ON rate_limit_entries(created_at);

-- RPC function for atomic rate limit check + increment
CREATE OR REPLACE FUNCTION check_rate_limit(
  p_key TEXT,
  p_limit INTEGER,
  p_window_ms BIGINT
) RETURNS JSONB AS $$
DECLARE
  v_now BIGINT := (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT;
  v_window_start BIGINT := v_now - p_window_ms;
  v_count INTEGER;
  v_reset_at BIGINT;
BEGIN
  -- Clean old entries for this key
  DELETE FROM rate_limit_entries
  WHERE key = p_key AND created_at < v_window_start;

  -- Count current window entries
  SELECT COUNT(*) INTO v_count
  FROM rate_limit_entries
  WHERE key = p_key AND created_at >= v_window_start;

  -- Check if limit exceeded
  IF v_count >= p_limit THEN
    SELECT MIN(created_at) + p_window_ms INTO v_reset_at
    FROM rate_limit_entries
    WHERE key = p_key AND created_at >= v_window_start;

    RETURN jsonb_build_object(
      'allowed', false,
      'remaining', 0,
      'reset_at', v_reset_at,
      'retry_after_ms', v_reset_at - v_now
    );
  END IF;

  -- Insert new entry (allowed)
  INSERT INTO rate_limit_entries (key, created_at)
  VALUES (p_key, v_now);

  RETURN jsonb_build_object(
    'allowed', true,
    'remaining', p_limit - v_count - 1,
    'reset_at', v_now + p_window_ms,
    'retry_after_ms', 0
  );
END;
$$ LANGUAGE plpgsql;

-- Periodic cleanup function (call from cron or health check)
CREATE OR REPLACE FUNCTION cleanup_rate_limit_entries(p_max_age_ms BIGINT DEFAULT 3600000)
RETURNS INTEGER AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM rate_limit_entries
  WHERE created_at < (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT - p_max_age_ms;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$ LANGUAGE plpgsql;
