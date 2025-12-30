-- =============================================================================
-- Metrics Dashboard RPC Functions
-- =============================================================================
-- Provides aggregated metrics for admin dashboards and observability.
-- Used by health endpoints and internal monitoring tools.
-- =============================================================================

-- =============================================================================
-- System Health Summary
-- =============================================================================
-- Returns overall system health metrics for dashboard display.
-- Aggregates function performance, circuit breaker states, and cache stats.
-- =============================================================================

CREATE OR REPLACE FUNCTION get_system_health_summary()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
BEGIN
  -- Set timeout for dashboard queries
  SET LOCAL statement_timeout = '10s';

  SELECT jsonb_build_object(
    'timestamp', NOW(),
    'functions', (
      SELECT COALESCE(jsonb_agg(f), '[]'::JSONB)
      FROM (
        SELECT
          function_name,
          COUNT(*) AS calls_24h,
          AVG(duration_ms)::INT AS avg_latency_ms,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)::INT AS p95_latency_ms,
          MAX(duration_ms) AS max_latency_ms,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)::FLOAT / NULLIF(COUNT(*), 0) AS error_rate,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count
        FROM metrics.function_calls
        WHERE created_at > NOW() - INTERVAL '24 hours'
        GROUP BY function_name
        ORDER BY calls_24h DESC
        LIMIT 20
      ) f
    ),
    'circuit_breakers', (
      SELECT COALESCE(jsonb_agg(c), '[]'::JSONB)
      FROM (
        SELECT
          service_name,
          state,
          failure_count,
          last_failure_at,
          last_success_at,
          updated_at
        FROM metrics.circuit_status
        WHERE updated_at > NOW() - INTERVAL '1 hour'
        ORDER BY
          CASE state
            WHEN 'OPEN' THEN 1
            WHEN 'HALF_OPEN' THEN 2
            ELSE 3
          END,
          failure_count DESC
      ) c
    ),
    'cache_stats', (
      SELECT COALESCE(jsonb_agg(cs), '[]'::JSONB)
      FROM (
        SELECT
          cache_name,
          hits,
          misses,
          CASE WHEN (hits + misses) > 0
            THEN (hits::FLOAT / (hits + misses) * 100)::DECIMAL(5,2)
            ELSE 0
          END AS hit_rate_percent,
          size_bytes,
          updated_at
        FROM metrics.cache_stats
        WHERE updated_at > NOW() - INTERVAL '1 hour'
        ORDER BY hit_rate_percent DESC
      ) cs
    ),
    'database', (
      SELECT jsonb_build_object(
        'active_connections', (SELECT count(*) FROM pg_stat_activity WHERE state = 'active'),
        'idle_connections', (SELECT count(*) FROM pg_stat_activity WHERE state = 'idle'),
        'waiting_queries', (SELECT count(*) FROM pg_stat_activity WHERE wait_event IS NOT NULL),
        'oldest_transaction_age_seconds', (
          SELECT EXTRACT(EPOCH FROM (NOW() - xact_start))::INT
          FROM pg_stat_activity
          WHERE xact_start IS NOT NULL
          ORDER BY xact_start
          LIMIT 1
        )
      )
    ),
    'summary', (
      SELECT jsonb_build_object(
        'total_requests_24h', COUNT(*),
        'avg_latency_ms', AVG(duration_ms)::INT,
        'overall_error_rate', SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)::FLOAT / NULLIF(COUNT(*), 0),
        'health_score', CASE
          WHEN SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)::FLOAT / NULLIF(COUNT(*), 0) < 0.01 THEN 'healthy'
          WHEN SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)::FLOAT / NULLIF(COUNT(*), 0) < 0.05 THEN 'degraded'
          ELSE 'unhealthy'
        END
      )
      FROM metrics.function_calls
      WHERE created_at > NOW() - INTERVAL '24 hours'
    )
  ) INTO v_result;

  RETURN v_result;
EXCEPTION WHEN OTHERS THEN
  -- Return minimal info on error
  RETURN jsonb_build_object(
    'timestamp', NOW(),
    'error', SQLERRM,
    'functions', '[]'::JSONB,
    'circuit_breakers', '[]'::JSONB,
    'cache_stats', '[]'::JSONB
  );
END;
$$;

-- =============================================================================
-- Function Performance Metrics
-- =============================================================================
-- Returns detailed performance metrics for a specific function.
-- =============================================================================

CREATE OR REPLACE FUNCTION get_function_metrics(
  p_function_name TEXT,
  p_hours INT DEFAULT 24
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
BEGIN
  SET LOCAL statement_timeout = '10s';

  SELECT jsonb_build_object(
    'function_name', p_function_name,
    'period_hours', p_hours,
    'summary', (
      SELECT jsonb_build_object(
        'total_calls', COUNT(*),
        'success_count', SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END),
        'error_count', SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END),
        'error_rate', SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)::FLOAT / NULLIF(COUNT(*), 0),
        'avg_latency_ms', AVG(duration_ms)::INT,
        'p50_latency_ms', PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY duration_ms)::INT,
        'p95_latency_ms', PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)::INT,
        'p99_latency_ms', PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY duration_ms)::INT,
        'max_latency_ms', MAX(duration_ms)
      )
      FROM metrics.function_calls
      WHERE function_name = p_function_name
        AND created_at > NOW() - (p_hours || ' hours')::INTERVAL
    ),
    'hourly_breakdown', (
      SELECT COALESCE(jsonb_agg(h ORDER BY hour), '[]'::JSONB)
      FROM (
        SELECT
          date_trunc('hour', created_at) AS hour,
          COUNT(*) AS calls,
          AVG(duration_ms)::INT AS avg_latency,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors
        FROM metrics.function_calls
        WHERE function_name = p_function_name
          AND created_at > NOW() - (p_hours || ' hours')::INTERVAL
        GROUP BY date_trunc('hour', created_at)
      ) h
    ),
    'recent_errors', (
      SELECT COALESCE(jsonb_agg(e), '[]'::JSONB)
      FROM (
        SELECT
          created_at,
          error_message,
          duration_ms,
          user_id,
          metadata
        FROM metrics.function_calls
        WHERE function_name = p_function_name
          AND status = 'error'
          AND created_at > NOW() - (p_hours || ' hours')::INTERVAL
        ORDER BY created_at DESC
        LIMIT 10
      ) e
    ),
    'by_platform', (
      SELECT COALESCE(jsonb_agg(p), '[]'::JSONB)
      FROM (
        SELECT
          COALESCE(platform, 'unknown') AS platform,
          COUNT(*) AS calls,
          AVG(duration_ms)::INT AS avg_latency,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors
        FROM metrics.function_calls
        WHERE function_name = p_function_name
          AND created_at > NOW() - (p_hours || ' hours')::INTERVAL
        GROUP BY platform
      ) p
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- =============================================================================
-- User Activity Metrics
-- =============================================================================
-- Returns activity metrics for a specific user (for debugging/support).
-- =============================================================================

CREATE OR REPLACE FUNCTION get_user_activity_metrics(
  p_user_id UUID,
  p_days INT DEFAULT 7
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
BEGIN
  SET LOCAL statement_timeout = '10s';

  SELECT jsonb_build_object(
    'user_id', p_user_id,
    'period_days', p_days,
    'api_usage', (
      SELECT jsonb_build_object(
        'total_requests', COUNT(*),
        'unique_endpoints', COUNT(DISTINCT function_name),
        'avg_latency_ms', AVG(duration_ms)::INT,
        'error_count', SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)
      )
      FROM metrics.function_calls
      WHERE user_id = p_user_id
        AND created_at > NOW() - (p_days || ' days')::INTERVAL
    ),
    'by_function', (
      SELECT COALESCE(jsonb_agg(f), '[]'::JSONB)
      FROM (
        SELECT
          function_name,
          COUNT(*) AS calls,
          AVG(duration_ms)::INT AS avg_latency,
          MAX(created_at) AS last_call
        FROM metrics.function_calls
        WHERE user_id = p_user_id
          AND created_at > NOW() - (p_days || ' days')::INTERVAL
        GROUP BY function_name
        ORDER BY calls DESC
        LIMIT 10
      ) f
    ),
    'daily_activity', (
      SELECT COALESCE(jsonb_agg(d ORDER BY day), '[]'::JSONB)
      FROM (
        SELECT
          date_trunc('day', created_at)::DATE AS day,
          COUNT(*) AS requests
        FROM metrics.function_calls
        WHERE user_id = p_user_id
          AND created_at > NOW() - (p_days || ' days')::INTERVAL
        GROUP BY date_trunc('day', created_at)
      ) d
    ),
    'recent_errors', (
      SELECT COALESCE(jsonb_agg(e), '[]'::JSONB)
      FROM (
        SELECT
          function_name,
          error_message,
          created_at
        FROM metrics.function_calls
        WHERE user_id = p_user_id
          AND status = 'error'
          AND created_at > NOW() - (p_days || ' days')::INTERVAL
        ORDER BY created_at DESC
        LIMIT 5
      ) e
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- =============================================================================
-- Request Trace Lookup
-- =============================================================================
-- Retrieves full trace for a correlation ID (distributed tracing).
-- =============================================================================

CREATE OR REPLACE FUNCTION get_request_trace(
  p_correlation_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
BEGIN
  SET LOCAL statement_timeout = '5s';

  SELECT jsonb_build_object(
    'correlation_id', p_correlation_id,
    'traces', (
      SELECT COALESCE(jsonb_agg(t ORDER BY started_at), '[]'::JSONB)
      FROM (
        SELECT
          function_name,
          user_id,
          platform,
          client_ip,
          started_at,
          completed_at,
          duration_ms,
          status,
          error_message,
          metadata
        FROM metrics.request_traces
        WHERE correlation_id = p_correlation_id
        ORDER BY started_at
      ) t
    ),
    'function_calls', (
      SELECT COALESCE(jsonb_agg(fc ORDER BY created_at), '[]'::JSONB)
      FROM (
        SELECT
          function_name,
          created_at,
          duration_ms,
          status,
          error_message
        FROM metrics.function_calls
        WHERE correlation_id = p_correlation_id
        ORDER BY created_at
      ) fc
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- =============================================================================
-- Metrics Cleanup
-- =============================================================================
-- Cleans up old metrics data to prevent unbounded growth.
-- Should be run daily via pg_cron or similar.
-- =============================================================================

CREATE OR REPLACE FUNCTION cleanup_old_metrics(
  p_retention_days INT DEFAULT 30
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_function_calls_deleted INT;
  v_request_traces_deleted INT;
  v_rate_limit_deleted INT;
BEGIN
  -- Delete old function calls
  DELETE FROM metrics.function_calls
  WHERE created_at < NOW() - (p_retention_days || ' days')::INTERVAL;
  GET DIAGNOSTICS v_function_calls_deleted = ROW_COUNT;

  -- Delete old request traces
  DELETE FROM metrics.request_traces
  WHERE started_at < NOW() - (p_retention_days || ' days')::INTERVAL;
  GET DIAGNOSTICS v_request_traces_deleted = ROW_COUNT;

  -- Delete old rate limit entries
  DELETE FROM rate_limit_entries
  WHERE created_at < NOW() - INTERVAL '1 hour';
  GET DIAGNOSTICS v_rate_limit_deleted = ROW_COUNT;

  RETURN jsonb_build_object(
    'success', true,
    'retention_days', p_retention_days,
    'deleted', jsonb_build_object(
      'function_calls', v_function_calls_deleted,
      'request_traces', v_request_traces_deleted,
      'rate_limit_entries', v_rate_limit_deleted
    ),
    'cleaned_at', NOW()
  );
END;
$$;

-- =============================================================================
-- Platform Usage Summary
-- =============================================================================
-- Returns usage breakdown by platform for cross-platform analytics.
-- =============================================================================

CREATE OR REPLACE FUNCTION get_platform_usage_summary(
  p_days INT DEFAULT 7
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  SET LOCAL statement_timeout = '10s';

  RETURN (
    SELECT jsonb_build_object(
      'period_days', p_days,
      'by_platform', (
        SELECT COALESCE(jsonb_agg(p), '[]'::JSONB)
        FROM (
          SELECT
            COALESCE(platform, 'unknown') AS platform,
            COUNT(*) AS total_requests,
            COUNT(DISTINCT user_id) AS unique_users,
            AVG(duration_ms)::INT AS avg_latency_ms,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)::FLOAT / NULLIF(COUNT(*), 0) AS error_rate
          FROM metrics.function_calls
          WHERE created_at > NOW() - (p_days || ' days')::INTERVAL
          GROUP BY platform
          ORDER BY total_requests DESC
        ) p
      ),
      'daily_by_platform', (
        SELECT COALESCE(jsonb_agg(d ORDER BY day, platform), '[]'::JSONB)
        FROM (
          SELECT
            date_trunc('day', created_at)::DATE AS day,
            COALESCE(platform, 'unknown') AS platform,
            COUNT(*) AS requests,
            COUNT(DISTINCT user_id) AS users
          FROM metrics.function_calls
          WHERE created_at > NOW() - (p_days || ' days')::INTERVAL
          GROUP BY date_trunc('day', created_at), platform
        ) d
      ),
      'top_endpoints_by_platform', (
        SELECT COALESCE(jsonb_agg(e), '[]'::JSONB)
        FROM (
          SELECT
            COALESCE(platform, 'unknown') AS platform,
            function_name,
            COUNT(*) AS calls
          FROM metrics.function_calls
          WHERE created_at > NOW() - (p_days || ' days')::INTERVAL
          GROUP BY platform, function_name
          ORDER BY platform, calls DESC
        ) e
      )
    )
  );
END;
$$;

-- =============================================================================
-- Grant Permissions
-- =============================================================================

-- Dashboard functions for service role only (admin access)
GRANT EXECUTE ON FUNCTION get_system_health_summary TO service_role;
GRANT EXECUTE ON FUNCTION get_function_metrics TO service_role;
GRANT EXECUTE ON FUNCTION get_user_activity_metrics TO service_role;
GRANT EXECUTE ON FUNCTION get_request_trace TO service_role;
GRANT EXECUTE ON FUNCTION cleanup_old_metrics TO service_role;
GRANT EXECUTE ON FUNCTION get_platform_usage_summary TO service_role;

-- =============================================================================
-- Comments
-- =============================================================================

COMMENT ON FUNCTION get_system_health_summary IS 'Returns system health dashboard data - functions, circuit breakers, cache stats';
COMMENT ON FUNCTION get_function_metrics IS 'Returns detailed metrics for a specific Edge Function';
COMMENT ON FUNCTION get_user_activity_metrics IS 'Returns API usage metrics for a specific user (support/debugging)';
COMMENT ON FUNCTION get_request_trace IS 'Retrieves distributed trace by correlation ID';
COMMENT ON FUNCTION cleanup_old_metrics IS 'Cleans up old metrics data - run daily via pg_cron';
COMMENT ON FUNCTION get_platform_usage_summary IS 'Returns cross-platform usage analytics';
