-- Migration: Observability Infrastructure
-- Purpose: API metrics, dashboard aggregations, and circuit breaker tracking
-- Supports: Cross-platform apps (iOS, Android, Web)

-- =============================================================================
-- Create Metrics Schema
-- =============================================================================
CREATE SCHEMA IF NOT EXISTS metrics;

GRANT USAGE ON SCHEMA metrics TO authenticated;
GRANT USAGE ON SCHEMA metrics TO service_role;

-- =============================================================================
-- API Request Metrics Table
-- =============================================================================
-- Tracks individual API requests for performance monitoring
CREATE TABLE metrics.api_requests (
    id BIGSERIAL PRIMARY KEY,
    endpoint TEXT NOT NULL,
    method TEXT NOT NULL DEFAULT 'GET',
    status_code INT,
    response_time_ms INT NOT NULL,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    app_platform TEXT NOT NULL DEFAULT 'unknown', -- 'ios', 'android', 'web'
    app_version TEXT,
    request_size_bytes INT,
    response_size_bytes INT,
    error_type TEXT, -- null if success, else error category
    cache_hit BOOLEAN DEFAULT false,
    region TEXT, -- deployment region if applicable
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for common query patterns
CREATE INDEX idx_api_requests_endpoint_time
    ON metrics.api_requests(endpoint, created_at DESC);

CREATE INDEX idx_api_requests_platform_time
    ON metrics.api_requests(app_platform, created_at DESC);

CREATE INDEX idx_api_requests_user_time
    ON metrics.api_requests(user_id, created_at DESC)
    WHERE user_id IS NOT NULL;

CREATE INDEX idx_api_requests_errors
    ON metrics.api_requests(error_type, created_at DESC)
    WHERE error_type IS NOT NULL;

CREATE INDEX idx_api_requests_created_at
    ON metrics.api_requests(created_at DESC);

-- =============================================================================
-- Hourly Statistics Aggregation Table
-- =============================================================================
-- Pre-computed hourly rollups for dashboard performance
CREATE TABLE metrics.api_hourly_stats (
    hour TIMESTAMPTZ NOT NULL,
    endpoint TEXT NOT NULL,
    platform TEXT NOT NULL,
    request_count INT NOT NULL DEFAULT 0,
    error_count INT NOT NULL DEFAULT 0,
    p50_ms INT,
    p95_ms INT,
    p99_ms INT,
    avg_ms INT,
    max_ms INT,
    min_ms INT,
    cache_hit_count INT DEFAULT 0,
    unique_users INT DEFAULT 0,
    total_request_bytes BIGINT DEFAULT 0,
    total_response_bytes BIGINT DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (hour, endpoint, platform)
);

CREATE INDEX idx_hourly_stats_hour ON metrics.api_hourly_stats(hour DESC);
CREATE INDEX idx_hourly_stats_endpoint ON metrics.api_hourly_stats(endpoint, hour DESC);

-- =============================================================================
-- Circuit Breaker Events Table
-- =============================================================================
-- Tracks circuit breaker state changes for debugging and alerting
CREATE TABLE metrics.circuit_breaker_events (
    id BIGSERIAL PRIMARY KEY,
    circuit_name TEXT NOT NULL,
    state TEXT NOT NULL, -- 'closed', 'open', 'half_open'
    previous_state TEXT,
    failure_count INT NOT NULL DEFAULT 0,
    success_count INT NOT NULL DEFAULT 0,
    consecutive_failures INT NOT NULL DEFAULT 0,
    trigger_reason TEXT, -- what caused the state change
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    app_platform TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_circuit_events_name_time
    ON metrics.circuit_breaker_events(circuit_name, created_at DESC);

CREATE INDEX idx_circuit_events_state
    ON metrics.circuit_breaker_events(state, created_at DESC);

-- =============================================================================
-- Error Rate Tracking Table
-- =============================================================================
-- Aggregated error rates for alerting
CREATE TABLE metrics.error_rates (
    id BIGSERIAL PRIMARY KEY,
    window_start TIMESTAMPTZ NOT NULL,
    window_end TIMESTAMPTZ NOT NULL,
    endpoint TEXT,
    platform TEXT,
    total_requests INT NOT NULL,
    error_count INT NOT NULL,
    error_rate DECIMAL(5, 4) NOT NULL, -- e.g., 0.0523 = 5.23%
    alert_triggered BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_error_rates_window
    ON metrics.error_rates(window_start DESC, window_end);

-- =============================================================================
-- Health Check History Table
-- =============================================================================
-- Tracks health check results over time
CREATE TABLE metrics.health_checks (
    id BIGSERIAL PRIMARY KEY,
    service TEXT NOT NULL, -- 'database', 'redis', 'storage', 'auth', 'edge_functions'
    status TEXT NOT NULL, -- 'healthy', 'degraded', 'unhealthy'
    response_time_ms INT,
    details JSONB,
    error_message TEXT,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_health_checks_service_time
    ON metrics.health_checks(service, checked_at DESC);

CREATE INDEX idx_health_checks_status
    ON metrics.health_checks(status, checked_at DESC)
    WHERE status != 'healthy';

-- =============================================================================
-- Functions
-- =============================================================================

-- Function to record an API request metric
CREATE OR REPLACE FUNCTION metrics.record_request(
    p_endpoint TEXT,
    p_method TEXT DEFAULT 'GET',
    p_status_code INT DEFAULT 200,
    p_response_time_ms INT DEFAULT 0,
    p_user_id UUID DEFAULT NULL,
    p_app_platform TEXT DEFAULT 'unknown',
    p_app_version TEXT DEFAULT NULL,
    p_request_size INT DEFAULT NULL,
    p_response_size INT DEFAULT NULL,
    p_error_type TEXT DEFAULT NULL,
    p_cache_hit BOOLEAN DEFAULT false
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_id BIGINT;
BEGIN
    INSERT INTO metrics.api_requests (
        endpoint, method, status_code, response_time_ms,
        user_id, app_platform, app_version,
        request_size_bytes, response_size_bytes,
        error_type, cache_hit
    ) VALUES (
        p_endpoint, p_method, p_status_code, p_response_time_ms,
        p_user_id, p_app_platform, p_app_version,
        p_request_size, p_response_size,
        p_error_type, p_cache_hit
    )
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

-- Function to record a circuit breaker event
CREATE OR REPLACE FUNCTION metrics.record_circuit_event(
    p_circuit_name TEXT,
    p_state TEXT,
    p_previous_state TEXT DEFAULT NULL,
    p_failure_count INT DEFAULT 0,
    p_success_count INT DEFAULT 0,
    p_consecutive_failures INT DEFAULT 0,
    p_trigger_reason TEXT DEFAULT NULL,
    p_user_id UUID DEFAULT NULL,
    p_app_platform TEXT DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_id BIGINT;
BEGIN
    INSERT INTO metrics.circuit_breaker_events (
        circuit_name, state, previous_state,
        failure_count, success_count, consecutive_failures,
        trigger_reason, user_id, app_platform
    ) VALUES (
        p_circuit_name, p_state, p_previous_state,
        p_failure_count, p_success_count, p_consecutive_failures,
        p_trigger_reason, p_user_id, p_app_platform
    )
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

-- Function to compute hourly statistics (call via pg_cron every hour)
CREATE OR REPLACE FUNCTION metrics.compute_hourly_stats(
    p_hour TIMESTAMPTZ DEFAULT date_trunc('hour', now() - interval '1 hour')
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_count INT;
BEGIN
    INSERT INTO metrics.api_hourly_stats (
        hour, endpoint, platform,
        request_count, error_count,
        p50_ms, p95_ms, p99_ms, avg_ms, max_ms, min_ms,
        cache_hit_count, unique_users,
        total_request_bytes, total_response_bytes
    )
    SELECT
        p_hour as hour,
        endpoint,
        app_platform as platform,
        COUNT(*) as request_count,
        COUNT(*) FILTER (WHERE error_type IS NOT NULL) as error_count,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY response_time_ms)::INT as p50_ms,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY response_time_ms)::INT as p95_ms,
        percentile_cont(0.99) WITHIN GROUP (ORDER BY response_time_ms)::INT as p99_ms,
        AVG(response_time_ms)::INT as avg_ms,
        MAX(response_time_ms) as max_ms,
        MIN(response_time_ms) as min_ms,
        COUNT(*) FILTER (WHERE cache_hit = true) as cache_hit_count,
        COUNT(DISTINCT user_id) as unique_users,
        COALESCE(SUM(request_size_bytes), 0) as total_request_bytes,
        COALESCE(SUM(response_size_bytes), 0) as total_response_bytes
    FROM metrics.api_requests
    WHERE created_at >= p_hour
      AND created_at < p_hour + interval '1 hour'
    GROUP BY endpoint, app_platform
    ON CONFLICT (hour, endpoint, platform) DO UPDATE SET
        request_count = EXCLUDED.request_count,
        error_count = EXCLUDED.error_count,
        p50_ms = EXCLUDED.p50_ms,
        p95_ms = EXCLUDED.p95_ms,
        p99_ms = EXCLUDED.p99_ms,
        avg_ms = EXCLUDED.avg_ms,
        max_ms = EXCLUDED.max_ms,
        min_ms = EXCLUDED.min_ms,
        cache_hit_count = EXCLUDED.cache_hit_count,
        unique_users = EXCLUDED.unique_users,
        total_request_bytes = EXCLUDED.total_request_bytes,
        total_response_bytes = EXCLUDED.total_response_bytes;

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

-- Function to get current error rate for alerting
CREATE OR REPLACE FUNCTION metrics.get_error_rate(
    p_minutes INT DEFAULT 5,
    p_endpoint TEXT DEFAULT NULL,
    p_platform TEXT DEFAULT NULL
)
RETURNS TABLE (
    total_requests BIGINT,
    error_count BIGINT,
    error_rate DECIMAL(5, 4)
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    RETURN QUERY
    SELECT
        COUNT(*)::BIGINT as total_requests,
        COUNT(*) FILTER (WHERE error_type IS NOT NULL)::BIGINT as error_count,
        CASE
            WHEN COUNT(*) > 0
            THEN (COUNT(*) FILTER (WHERE error_type IS NOT NULL)::DECIMAL / COUNT(*)::DECIMAL)
            ELSE 0.0
        END as error_rate
    FROM metrics.api_requests
    WHERE created_at > now() - (p_minutes || ' minutes')::interval
      AND (p_endpoint IS NULL OR endpoint = p_endpoint)
      AND (p_platform IS NULL OR app_platform = p_platform);
END;
$$;

-- Function to get P95 latency for alerting
CREATE OR REPLACE FUNCTION metrics.get_p95_latency(
    p_minutes INT DEFAULT 5,
    p_endpoint TEXT DEFAULT NULL
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_p95 INT;
BEGIN
    SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY response_time_ms)::INT
    INTO v_p95
    FROM metrics.api_requests
    WHERE created_at > now() - (p_minutes || ' minutes')::interval
      AND (p_endpoint IS NULL OR endpoint = p_endpoint);

    RETURN COALESCE(v_p95, 0);
END;
$$;

-- Function to cleanup old metrics data (call via pg_cron daily)
CREATE OR REPLACE FUNCTION metrics.cleanup_old_data(
    p_raw_retention_days INT DEFAULT 7,
    p_stats_retention_days INT DEFAULT 90
)
RETURNS TABLE (
    deleted_requests INT,
    deleted_circuit_events INT,
    deleted_health_checks INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_requests INT;
    v_circuit INT;
    v_health INT;
BEGIN
    -- Delete old raw requests (keep 7 days by default)
    DELETE FROM metrics.api_requests
    WHERE created_at < now() - (p_raw_retention_days || ' days')::interval;
    GET DIAGNOSTICS v_requests = ROW_COUNT;

    -- Delete old circuit breaker events (keep 30 days)
    DELETE FROM metrics.circuit_breaker_events
    WHERE created_at < now() - interval '30 days';
    GET DIAGNOSTICS v_circuit = ROW_COUNT;

    -- Delete old health checks (keep 7 days)
    DELETE FROM metrics.health_checks
    WHERE checked_at < now() - (p_raw_retention_days || ' days')::interval;
    GET DIAGNOSTICS v_health = ROW_COUNT;

    -- Note: Hourly stats are kept longer (retention_days)

    RETURN QUERY SELECT v_requests, v_circuit, v_health;
END;
$$;

-- =============================================================================
-- Views for Dashboard
-- =============================================================================

-- Real-time request summary (last 5 minutes)
CREATE OR REPLACE VIEW metrics.realtime_summary AS
SELECT
    endpoint,
    app_platform,
    COUNT(*) as request_count,
    COUNT(*) FILTER (WHERE error_type IS NOT NULL) as errors,
    ROUND(AVG(response_time_ms)) as avg_latency_ms,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY response_time_ms)::INT as p95_latency_ms,
    COUNT(*) FILTER (WHERE cache_hit = true) as cache_hits
FROM metrics.api_requests
WHERE created_at > now() - interval '5 minutes'
GROUP BY endpoint, app_platform;

-- Circuit breaker status view
CREATE OR REPLACE VIEW metrics.circuit_status AS
SELECT DISTINCT ON (circuit_name)
    circuit_name,
    state,
    failure_count,
    consecutive_failures,
    trigger_reason,
    created_at as last_change
FROM metrics.circuit_breaker_events
ORDER BY circuit_name, created_at DESC;

-- Latest health status
CREATE OR REPLACE VIEW metrics.latest_health AS
SELECT DISTINCT ON (service)
    service,
    status,
    response_time_ms,
    details,
    error_message,
    checked_at
FROM metrics.health_checks
ORDER BY service, checked_at DESC;

-- =============================================================================
-- RLS Policies
-- =============================================================================

-- Enable RLS
ALTER TABLE metrics.api_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics.api_hourly_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics.circuit_breaker_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics.error_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics.health_checks ENABLE ROW LEVEL SECURITY;

-- Service role full access (Edge Functions)
CREATE POLICY "Service role full access to api_requests"
    ON metrics.api_requests FOR ALL TO service_role
    USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access to api_hourly_stats"
    ON metrics.api_hourly_stats FOR ALL TO service_role
    USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access to circuit_breaker_events"
    ON metrics.circuit_breaker_events FOR ALL TO service_role
    USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access to error_rates"
    ON metrics.error_rates FOR ALL TO service_role
    USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access to health_checks"
    ON metrics.health_checks FOR ALL TO service_role
    USING (true) WITH CHECK (true);

-- =============================================================================
-- Grants
-- =============================================================================

GRANT EXECUTE ON FUNCTION metrics.record_request TO service_role;
GRANT EXECUTE ON FUNCTION metrics.record_circuit_event TO service_role;
GRANT EXECUTE ON FUNCTION metrics.compute_hourly_stats TO service_role;
GRANT EXECUTE ON FUNCTION metrics.get_error_rate TO service_role;
GRANT EXECUTE ON FUNCTION metrics.get_p95_latency TO service_role;
GRANT EXECUTE ON FUNCTION metrics.cleanup_old_data TO service_role;

GRANT SELECT ON metrics.realtime_summary TO service_role;
GRANT SELECT ON metrics.circuit_status TO service_role;
GRANT SELECT ON metrics.latest_health TO service_role;

-- =============================================================================
-- Comments
-- =============================================================================

COMMENT ON TABLE metrics.api_requests IS 'Individual API request metrics for performance monitoring';
COMMENT ON TABLE metrics.api_hourly_stats IS 'Pre-computed hourly aggregations for dashboard queries';
COMMENT ON TABLE metrics.circuit_breaker_events IS 'Circuit breaker state changes for debugging and alerting';
COMMENT ON TABLE metrics.health_checks IS 'Health check results history for uptime tracking';
COMMENT ON VIEW metrics.realtime_summary IS 'Real-time request summary for the last 5 minutes';
COMMENT ON VIEW metrics.circuit_status IS 'Current state of all circuit breakers';
COMMENT ON VIEW metrics.latest_health IS 'Latest health check status for each service';
