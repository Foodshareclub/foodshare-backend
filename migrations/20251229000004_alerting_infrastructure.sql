-- ============================================================================
-- Alerting Infrastructure Migration
-- ============================================================================
-- Adds alerts table and supporting functions for the check-alerts Edge Function.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Alerts Table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS metrics.alerts (
    id BIGSERIAL PRIMARY KEY,
    alert_type TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
    message TEXT NOT NULL,
    value NUMERIC,
    threshold NUMERIC,
    details JSONB DEFAULT '{}'::jsonb,
    acknowledged BOOLEAN DEFAULT false,
    acknowledged_by UUID REFERENCES auth.users(id),
    acknowledged_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes for alert queries
CREATE INDEX IF NOT EXISTS idx_alerts_type_time ON metrics.alerts(alert_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_severity_time ON metrics.alerts(severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_unacknowledged ON metrics.alerts(created_at DESC) WHERE acknowledged = false;

COMMENT ON TABLE metrics.alerts IS 'System alerts triggered by automated health checks';

-- ----------------------------------------------------------------------------
-- Circuit Status View for Open Circuits
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW metrics.circuit_status AS
SELECT
    circuit_name,
    state,
    failure_count,
    success_count,
    consecutive_failures,
    trigger_reason,
    created_at as last_change
FROM metrics.circuit_breaker_events cbe1
WHERE created_at = (
    SELECT MAX(created_at)
    FROM metrics.circuit_breaker_events cbe2
    WHERE cbe2.circuit_name = cbe1.circuit_name
);

COMMENT ON VIEW metrics.circuit_status IS 'Current state of all circuit breakers';

-- ----------------------------------------------------------------------------
-- Error Rate Function
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_error_rate(p_minutes INT DEFAULT 5)
RETURNS TABLE (
    total_requests BIGINT,
    error_count BIGINT,
    error_rate NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT
        COUNT(*)::BIGINT as total_requests,
        COUNT(*) FILTER (WHERE status_code >= 400 OR status_code IS NULL)::BIGINT as error_count,
        CASE
            WHEN COUNT(*) = 0 THEN 0
            ELSE ROUND(
                (COUNT(*) FILTER (WHERE status_code >= 400 OR status_code IS NULL)::NUMERIC / COUNT(*)::NUMERIC) * 100,
                2
            )
        END as error_rate
    FROM metrics.api_requests
    WHERE created_at > now() - (p_minutes || ' minutes')::INTERVAL;
END;
$$;

COMMENT ON FUNCTION get_error_rate IS 'Returns error rate percentage for the last N minutes';

-- ----------------------------------------------------------------------------
-- P95 Latency Function
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_p95_latency(p_minutes INT DEFAULT 5)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_p95 INT;
BEGIN
    SELECT PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY response_time_ms)::INT
    INTO v_p95
    FROM metrics.api_requests
    WHERE created_at > now() - (p_minutes || ' minutes')::INTERVAL;

    RETURN COALESCE(v_p95, 0);
END;
$$;

COMMENT ON FUNCTION get_p95_latency IS 'Returns P95 latency in milliseconds for the last N minutes';

-- ----------------------------------------------------------------------------
-- Login Spike Stats Function
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_login_spike_stats(
    p_current_window_minutes INT DEFAULT 30,
    p_baseline_window_hours INT DEFAULT 24
)
RETURNS TABLE (
    current_failures BIGINT,
    baseline_failures BIGINT,
    spike_multiplier NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_current BIGINT;
    v_baseline BIGINT;
    v_baseline_per_window NUMERIC;
BEGIN
    -- Count current window failures
    SELECT COUNT(*)
    INTO v_current
    FROM security.login_attempts
    WHERE success = false
      AND created_at > now() - (p_current_window_minutes || ' minutes')::INTERVAL;

    -- Count baseline failures (excluding current window)
    SELECT COUNT(*)
    INTO v_baseline
    FROM security.login_attempts
    WHERE success = false
      AND created_at > now() - (p_baseline_window_hours || ' hours')::INTERVAL
      AND created_at <= now() - (p_current_window_minutes || ' minutes')::INTERVAL;

    -- Calculate baseline per window (normalize to same time period)
    v_baseline_per_window := (v_baseline::NUMERIC / (p_baseline_window_hours * 60.0)) * p_current_window_minutes;

    RETURN QUERY SELECT
        v_current,
        v_baseline,
        CASE
            WHEN v_baseline_per_window = 0 THEN 0
            ELSE ROUND(v_current::NUMERIC / GREATEST(v_baseline_per_window, 1), 2)
        END;
END;
$$;

COMMENT ON FUNCTION get_login_spike_stats IS 'Compares current failed logins to baseline for spike detection';

-- ----------------------------------------------------------------------------
-- Vault Failure Count Function
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_vault_failure_count(p_hours INT DEFAULT 1)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_count INT;
BEGIN
    SELECT COUNT(*)::INT
    INTO v_count
    FROM audit.vault_access_log
    WHERE access_result = 'denied'
      AND created_at > now() - (p_hours || ' hours')::INTERVAL;

    RETURN COALESCE(v_count, 0);
END;
$$;

COMMENT ON FUNCTION get_vault_failure_count IS 'Returns count of vault access failures in last N hours';

-- ----------------------------------------------------------------------------
-- Connection Pool Stats Function
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_connection_pool_stats()
RETURNS TABLE (
    total_connections INT,
    active_connections INT,
    utilization_percent NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_max_connections INT;
    v_current_connections INT;
BEGIN
    -- Get max connections setting
    SELECT setting::INT INTO v_max_connections
    FROM pg_settings
    WHERE name = 'max_connections';

    -- Get current connection count
    SELECT COUNT(*)::INT INTO v_current_connections
    FROM pg_stat_activity
    WHERE state IS NOT NULL;

    RETURN QUERY SELECT
        v_max_connections,
        v_current_connections,
        ROUND((v_current_connections::NUMERIC / v_max_connections::NUMERIC) * 100, 2);
END;
$$;

COMMENT ON FUNCTION get_connection_pool_stats IS 'Returns database connection pool utilization';

-- ----------------------------------------------------------------------------
-- Record Request Metric Function (for MetricsReporter)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_request(
    p_endpoint TEXT,
    p_method TEXT,
    p_response_time_ms INT,
    p_app_platform TEXT,
    p_app_version TEXT,
    p_cache_hit BOOLEAN DEFAULT false,
    p_status_code INT DEFAULT NULL,
    p_error_type TEXT DEFAULT NULL,
    p_request_size INT DEFAULT NULL,
    p_response_size INT DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    INSERT INTO metrics.api_requests (
        endpoint,
        method,
        response_time_ms,
        app_platform,
        app_version,
        cache_hit,
        status_code,
        error_type,
        request_size_bytes,
        response_size_bytes
    ) VALUES (
        p_endpoint,
        p_method,
        p_response_time_ms,
        p_app_platform,
        p_app_version,
        p_cache_hit,
        p_status_code,
        p_error_type,
        p_request_size,
        p_response_size
    );
END;
$$;

COMMENT ON FUNCTION record_request IS 'Records an API request metric from client apps';

-- ----------------------------------------------------------------------------
-- Record Circuit Event Function (for MetricsReporter)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_circuit_event(
    p_circuit_name TEXT,
    p_state TEXT,
    p_previous_state TEXT DEFAULT NULL,
    p_failure_count INT DEFAULT 0,
    p_success_count INT DEFAULT 0,
    p_consecutive_failures INT DEFAULT 0,
    p_trigger_reason TEXT DEFAULT NULL,
    p_app_platform TEXT DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    INSERT INTO metrics.circuit_breaker_events (
        circuit_name,
        state,
        previous_state,
        failure_count,
        success_count,
        consecutive_failures,
        trigger_reason,
        app_platform
    ) VALUES (
        p_circuit_name,
        p_state,
        p_previous_state,
        p_failure_count,
        p_success_count,
        p_consecutive_failures,
        p_trigger_reason,
        p_app_platform
    );
END;
$$;

COMMENT ON FUNCTION record_circuit_event IS 'Records a circuit breaker state change event';

-- ----------------------------------------------------------------------------
-- Hourly Stats Rollup Function
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rollup_hourly_stats()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_hour TIMESTAMPTZ;
BEGIN
    -- Roll up stats for the previous hour
    v_hour := date_trunc('hour', now() - interval '1 hour');

    INSERT INTO metrics.api_hourly_stats (
        hour,
        endpoint,
        platform,
        request_count,
        error_count,
        p50_ms,
        p95_ms,
        p99_ms
    )
    SELECT
        v_hour,
        endpoint,
        COALESCE(app_platform, 'unknown') as platform,
        COUNT(*) as request_count,
        COUNT(*) FILTER (WHERE status_code >= 400 OR status_code IS NULL) as error_count,
        PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY response_time_ms)::INT as p50_ms,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY response_time_ms)::INT as p95_ms,
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY response_time_ms)::INT as p99_ms
    FROM metrics.api_requests
    WHERE created_at >= v_hour
      AND created_at < v_hour + interval '1 hour'
    GROUP BY endpoint, COALESCE(app_platform, 'unknown')
    ON CONFLICT (hour, endpoint, platform)
    DO UPDATE SET
        request_count = EXCLUDED.request_count,
        error_count = EXCLUDED.error_count,
        p50_ms = EXCLUDED.p50_ms,
        p95_ms = EXCLUDED.p95_ms,
        p99_ms = EXCLUDED.p99_ms;
END;
$$;

COMMENT ON FUNCTION rollup_hourly_stats IS 'Aggregates raw API metrics into hourly stats';

-- ----------------------------------------------------------------------------
-- Alert Acknowledgement Function
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION acknowledge_alert(
    p_alert_id BIGINT,
    p_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE metrics.alerts
    SET
        acknowledged = true,
        acknowledged_by = p_user_id,
        acknowledged_at = now()
    WHERE id = p_alert_id AND acknowledged = false;

    RETURN FOUND;
END;
$$;

COMMENT ON FUNCTION acknowledge_alert IS 'Marks an alert as acknowledged by a user';

-- ----------------------------------------------------------------------------
-- Cleanup Function for Old Metrics
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cleanup_old_metrics()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_deleted INT := 0;
    v_count INT;
BEGIN
    -- Delete raw metrics older than 7 days
    DELETE FROM metrics.api_requests
    WHERE created_at < now() - interval '7 days';
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_deleted := v_deleted + v_count;

    -- Delete circuit events older than 30 days
    DELETE FROM metrics.circuit_breaker_events
    WHERE created_at < now() - interval '30 days';
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_deleted := v_deleted + v_count;

    -- Delete health checks older than 7 days
    DELETE FROM metrics.health_checks
    WHERE created_at < now() - interval '7 days';
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_deleted := v_deleted + v_count;

    -- Delete hourly stats older than 90 days
    DELETE FROM metrics.api_hourly_stats
    WHERE hour < now() - interval '90 days';
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_deleted := v_deleted + v_count;

    -- Delete acknowledged alerts older than 30 days
    DELETE FROM metrics.alerts
    WHERE acknowledged = true
      AND created_at < now() - interval '30 days';
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_deleted := v_deleted + v_count;

    RETURN v_deleted;
END;
$$;

COMMENT ON FUNCTION cleanup_old_metrics IS 'Removes old metrics data to prevent unbounded growth';

-- ----------------------------------------------------------------------------
-- Add missing columns to existing tables if needed
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    -- Add columns to api_requests if they don't exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'metrics'
          AND table_name = 'api_requests'
          AND column_name = 'cache_hit'
    ) THEN
        ALTER TABLE metrics.api_requests
        ADD COLUMN cache_hit BOOLEAN DEFAULT false,
        ADD COLUMN error_type TEXT,
        ADD COLUMN request_size_bytes INT,
        ADD COLUMN response_size_bytes INT;
    END IF;

    -- Add columns to circuit_breaker_events if they don't exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'metrics'
          AND table_name = 'circuit_breaker_events'
          AND column_name = 'previous_state'
    ) THEN
        ALTER TABLE metrics.circuit_breaker_events
        ADD COLUMN previous_state TEXT,
        ADD COLUMN success_count INT DEFAULT 0,
        ADD COLUMN consecutive_failures INT DEFAULT 0,
        ADD COLUMN trigger_reason TEXT,
        ADD COLUMN app_platform TEXT;
    END IF;
END $$;

-- ----------------------------------------------------------------------------
-- Grants for Edge Functions
-- ----------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION get_error_rate TO service_role;
GRANT EXECUTE ON FUNCTION get_p95_latency TO service_role;
GRANT EXECUTE ON FUNCTION get_login_spike_stats TO service_role;
GRANT EXECUTE ON FUNCTION get_vault_failure_count TO service_role;
GRANT EXECUTE ON FUNCTION get_connection_pool_stats TO service_role;
GRANT EXECUTE ON FUNCTION record_request TO service_role;
GRANT EXECUTE ON FUNCTION record_circuit_event TO service_role;
GRANT EXECUTE ON FUNCTION rollup_hourly_stats TO service_role;
GRANT EXECUTE ON FUNCTION acknowledge_alert TO service_role;
GRANT EXECUTE ON FUNCTION cleanup_old_metrics TO service_role;

GRANT SELECT, INSERT ON metrics.alerts TO service_role;
GRANT SELECT ON metrics.circuit_status TO service_role;
