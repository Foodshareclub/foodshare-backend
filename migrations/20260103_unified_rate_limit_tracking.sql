-- =============================================================================
-- Unified Rate Limit Tracking
-- =============================================================================
-- Distributed rate limiting with multi-window support (minute, hour, burst)
-- Includes automatic TTL cleanup for scalability
-- =============================================================================

-- Rate limit entries table with multi-window tracking
CREATE TABLE IF NOT EXISTS rate_limit_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key TEXT NOT NULL,
    window_type TEXT NOT NULL CHECK (window_type IN ('minute', 'hour', 'burst')),
    count INTEGER NOT NULL DEFAULT 1,
    window_start_ms BIGINT NOT NULL,
    window_end_ms BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Composite unique constraint for upsert
    CONSTRAINT rate_limit_entries_key_window_unique
        UNIQUE (key, window_type, window_start_ms)
);

-- Index for fast lookups by key and window
CREATE INDEX IF NOT EXISTS idx_rate_limit_key_window
    ON rate_limit_entries(key, window_type, window_start_ms);

-- Index for TTL cleanup (by window_end_ms)
CREATE INDEX IF NOT EXISTS idx_rate_limit_ttl
    ON rate_limit_entries(window_end_ms);

-- =============================================================================
-- Unified Rate Limit Check RPC
-- =============================================================================
-- Supports minute, hour, and burst windows in a single call
-- Returns comprehensive rate limit status

CREATE OR REPLACE FUNCTION check_rate_limit_unified(
    p_key TEXT,
    p_minute_limit INTEGER,
    p_hour_limit INTEGER,
    p_burst_limit INTEGER,
    p_burst_window_ms BIGINT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_now_ms BIGINT := EXTRACT(EPOCH FROM NOW()) * 1000;
    v_minute_start BIGINT := v_now_ms - 60000;
    v_hour_start BIGINT := v_now_ms - 3600000;
    v_burst_start BIGINT := v_now_ms - p_burst_window_ms;
    v_minute_count INTEGER := 0;
    v_hour_count INTEGER := 0;
    v_burst_count INTEGER := 0;
    v_minute_reset BIGINT;
    v_hour_reset BIGINT;
    v_burst_reset BIGINT;
    v_allowed BOOLEAN := TRUE;
    v_retry_after_ms BIGINT := 0;
    v_burst_limit_hit BOOLEAN := FALSE;
BEGIN
    -- Clean expired entries for this key
    DELETE FROM rate_limit_entries
    WHERE key = p_key AND window_end_ms < v_now_ms;

    -- Get current counts for each window
    SELECT COALESCE(SUM(count), 0) INTO v_minute_count
    FROM rate_limit_entries
    WHERE key = p_key
      AND window_type = 'minute'
      AND window_start_ms >= v_minute_start;

    SELECT COALESCE(SUM(count), 0) INTO v_hour_count
    FROM rate_limit_entries
    WHERE key = p_key
      AND window_type = 'hour'
      AND window_start_ms >= v_hour_start;

    SELECT COALESCE(SUM(count), 0) INTO v_burst_count
    FROM rate_limit_entries
    WHERE key = p_key
      AND window_type = 'burst'
      AND window_start_ms >= v_burst_start;

    -- Calculate reset times
    v_minute_reset := v_now_ms + 60000;
    v_hour_reset := v_now_ms + 3600000;
    v_burst_reset := v_now_ms + p_burst_window_ms;

    -- Check limits in order: burst, minute, hour
    IF v_burst_count >= p_burst_limit THEN
        v_allowed := FALSE;
        v_burst_limit_hit := TRUE;
        -- Find when burst window resets
        SELECT MIN(window_end_ms) INTO v_retry_after_ms
        FROM rate_limit_entries
        WHERE key = p_key
          AND window_type = 'burst'
          AND window_start_ms >= v_burst_start;
        v_retry_after_ms := GREATEST(0, v_retry_after_ms - v_now_ms);
    ELSIF v_minute_count >= p_minute_limit THEN
        v_allowed := FALSE;
        -- Find when minute window resets
        SELECT MIN(window_end_ms) INTO v_retry_after_ms
        FROM rate_limit_entries
        WHERE key = p_key
          AND window_type = 'minute'
          AND window_start_ms >= v_minute_start;
        v_retry_after_ms := GREATEST(0, v_retry_after_ms - v_now_ms);
    ELSIF v_hour_count >= p_hour_limit THEN
        v_allowed := FALSE;
        -- Find when hour window resets
        SELECT MIN(window_end_ms) INTO v_retry_after_ms
        FROM rate_limit_entries
        WHERE key = p_key
          AND window_type = 'hour'
          AND window_start_ms >= v_hour_start;
        v_retry_after_ms := GREATEST(0, v_retry_after_ms - v_now_ms);
    END IF;

    -- If allowed, insert/update entries for all windows
    IF v_allowed THEN
        -- Minute window entry
        INSERT INTO rate_limit_entries (key, window_type, count, window_start_ms, window_end_ms)
        VALUES (p_key, 'minute', 1, v_now_ms, v_now_ms + 60000)
        ON CONFLICT (key, window_type, window_start_ms)
        DO UPDATE SET count = rate_limit_entries.count + 1, updated_at = NOW();

        -- Hour window entry (use hour-aligned start)
        INSERT INTO rate_limit_entries (key, window_type, count, window_start_ms, window_end_ms)
        VALUES (p_key, 'hour', 1, v_now_ms, v_now_ms + 3600000)
        ON CONFLICT (key, window_type, window_start_ms)
        DO UPDATE SET count = rate_limit_entries.count + 1, updated_at = NOW();

        -- Burst window entry
        INSERT INTO rate_limit_entries (key, window_type, count, window_start_ms, window_end_ms)
        VALUES (p_key, 'burst', 1, v_now_ms, v_now_ms + p_burst_window_ms)
        ON CONFLICT (key, window_type, window_start_ms)
        DO UPDATE SET count = rate_limit_entries.count + 1, updated_at = NOW();

        v_minute_count := v_minute_count + 1;
        v_hour_count := v_hour_count + 1;
        v_burst_count := v_burst_count + 1;
    END IF;

    RETURN jsonb_build_object(
        'allowed', v_allowed,
        'remaining', GREATEST(0, p_minute_limit - v_minute_count),
        'remaining_hourly', GREATEST(0, p_hour_limit - v_hour_count),
        'reset_at', v_minute_reset,
        'reset_at_hourly', v_hour_reset,
        'retry_after_ms', v_retry_after_ms,
        'burst_limit_hit', v_burst_limit_hit,
        'counts', jsonb_build_object(
            'minute', v_minute_count,
            'hour', v_hour_count,
            'burst', v_burst_count
        )
    );
END;
$$;

-- =============================================================================
-- TTL Cleanup Function
-- =============================================================================
-- Scheduled cleanup of expired rate limit entries

CREATE OR REPLACE FUNCTION cleanup_rate_limit_entries()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_deleted INTEGER;
BEGIN
    DELETE FROM rate_limit_entries
    WHERE window_end_ms < EXTRACT(EPOCH FROM NOW()) * 1000;

    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$;

-- =============================================================================
-- Simple Rate Limit Check (backwards compatible)
-- =============================================================================
-- Single-window rate limit check for simpler use cases

CREATE OR REPLACE FUNCTION check_rate_limit(
    p_key TEXT,
    p_limit INTEGER,
    p_window_ms BIGINT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_now_ms BIGINT := EXTRACT(EPOCH FROM NOW()) * 1000;
    v_window_start BIGINT := v_now_ms - p_window_ms;
    v_count INTEGER;
    v_reset_at BIGINT;
BEGIN
    -- Clean old entries
    DELETE FROM rate_limit_entries
    WHERE key = p_key AND window_end_ms < v_now_ms;

    -- Count current window
    SELECT COALESCE(SUM(count), 0) INTO v_count
    FROM rate_limit_entries
    WHERE key = p_key
      AND window_type = 'simple'
      AND window_start_ms >= v_window_start;

    IF v_count >= p_limit THEN
        -- Find earliest reset time
        SELECT MIN(window_end_ms) INTO v_reset_at
        FROM rate_limit_entries
        WHERE key = p_key
          AND window_type = 'simple'
          AND window_start_ms >= v_window_start;

        RETURN jsonb_build_object(
            'allowed', FALSE,
            'remaining', 0,
            'reset_at', v_reset_at,
            'retry_after_ms', GREATEST(0, v_reset_at - v_now_ms)
        );
    END IF;

    -- Insert new entry
    INSERT INTO rate_limit_entries (key, window_type, count, window_start_ms, window_end_ms)
    VALUES (p_key, 'simple', 1, v_now_ms, v_now_ms + p_window_ms)
    ON CONFLICT (key, window_type, window_start_ms)
    DO UPDATE SET count = rate_limit_entries.count + 1, updated_at = NOW();

    RETURN jsonb_build_object(
        'allowed', TRUE,
        'remaining', p_limit - v_count - 1,
        'reset_at', v_now_ms + p_window_ms,
        'retry_after_ms', 0
    );
END;
$$;

-- =============================================================================
-- Rate Limit Stats View
-- =============================================================================
-- For monitoring and debugging rate limits

CREATE OR REPLACE VIEW rate_limit_stats AS
SELECT
    key,
    window_type,
    SUM(count) as total_requests,
    COUNT(*) as entry_count,
    MIN(window_start_ms) as first_request_ms,
    MAX(window_end_ms) as last_window_end_ms,
    MAX(updated_at) as last_updated
FROM rate_limit_entries
WHERE window_end_ms > EXTRACT(EPOCH FROM NOW()) * 1000
GROUP BY key, window_type
ORDER BY total_requests DESC;

-- =============================================================================
-- Permissions
-- =============================================================================

-- Allow service role to call rate limit functions
GRANT EXECUTE ON FUNCTION check_rate_limit_unified TO service_role;
GRANT EXECUTE ON FUNCTION check_rate_limit TO service_role;
GRANT EXECUTE ON FUNCTION cleanup_rate_limit_entries TO service_role;

-- Service role needs table access
GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limit_entries TO service_role;
GRANT SELECT ON rate_limit_stats TO service_role;

-- =============================================================================
-- Comments
-- =============================================================================

COMMENT ON TABLE rate_limit_entries IS 'Distributed rate limit tracking with multi-window support';
COMMENT ON FUNCTION check_rate_limit_unified IS 'Unified rate limit check with minute, hour, and burst windows';
COMMENT ON FUNCTION check_rate_limit IS 'Simple single-window rate limit check (backwards compatible)';
COMMENT ON FUNCTION cleanup_rate_limit_entries IS 'TTL cleanup for expired rate limit entries';
COMMENT ON VIEW rate_limit_stats IS 'Current rate limit statistics for monitoring';
