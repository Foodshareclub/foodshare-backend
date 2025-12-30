-- Metrics RPC Functions
-- Support functions for Prometheus export and alerting
-- Part of Phase 5: Observability & Architecture Hardening

-- =============================================================================
-- Error Rate Calculation
-- =============================================================================

-- Get error rate as a decimal (0-1) for a given time window
CREATE OR REPLACE FUNCTION get_error_rate(p_minutes int DEFAULT 5)
RETURNS numeric AS $$
BEGIN
  RETURN COALESCE(
    (
      SELECT
        CASE
          WHEN COUNT(*) = 0 THEN 0
          ELSE COUNT(*) FILTER (WHERE level = 'error')::numeric / COUNT(*)
        END
      FROM app_logs
      WHERE created_at > now() - (p_minutes || ' minutes')::interval
    ),
    0
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Get error rate with details (for alerting)
CREATE OR REPLACE FUNCTION get_error_rate_details(p_minutes int DEFAULT 5)
RETURNS TABLE(
  error_rate numeric,
  total_requests bigint,
  error_count bigint
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    CASE
      WHEN COUNT(*) = 0 THEN 0::numeric
      ELSE (COUNT(*) FILTER (WHERE level = 'error')::numeric / COUNT(*))
    END as error_rate,
    COUNT(*)::bigint as total_requests,
    COUNT(*) FILTER (WHERE level = 'error')::bigint as error_count
  FROM app_logs
  WHERE created_at > now() - (p_minutes || ' minutes')::interval;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- =============================================================================
-- Latency Metrics
-- =============================================================================

-- Get P95 latency for a time window
CREATE OR REPLACE FUNCTION get_p95_latency(p_minutes int DEFAULT 5)
RETURNS numeric AS $$
BEGIN
  RETURN COALESCE(
    (
      SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)
      FROM api_logs
      WHERE created_at > now() - (p_minutes || ' minutes')::interval
    ),
    0
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- =============================================================================
-- Login Spike Detection
-- =============================================================================

-- Compare current failed login rate to baseline
CREATE OR REPLACE FUNCTION get_login_spike_stats(
  p_current_window_minutes int DEFAULT 30,
  p_baseline_window_hours int DEFAULT 24
)
RETURNS TABLE(
  current_failures bigint,
  baseline_failures numeric,
  spike_multiplier numeric
) AS $$
DECLARE
  v_current_failures bigint;
  v_baseline_failures numeric;
BEGIN
  -- Count failures in current window
  SELECT COUNT(*)::bigint INTO v_current_failures
  FROM auth_logs
  WHERE event_type = 'login_failed'
    AND created_at > now() - (p_current_window_minutes || ' minutes')::interval;

  -- Calculate baseline rate per window from historical data
  SELECT
    COALESCE(
      COUNT(*)::numeric / NULLIF(EXTRACT(EPOCH FROM (p_baseline_window_hours || ' hours')::interval) /
                                  EXTRACT(EPOCH FROM (p_current_window_minutes || ' minutes')::interval), 0),
      1
    ) INTO v_baseline_failures
  FROM auth_logs
  WHERE event_type = 'login_failed'
    AND created_at > now() - (p_baseline_window_hours || ' hours')::interval
    AND created_at <= now() - (p_current_window_minutes || ' minutes')::interval;

  RETURN QUERY
  SELECT
    v_current_failures,
    COALESCE(v_baseline_failures, 1),
    CASE
      WHEN v_baseline_failures > 0 THEN v_current_failures::numeric / v_baseline_failures
      ELSE v_current_failures::numeric
    END;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- =============================================================================
-- Connection Pool Stats
-- =============================================================================

-- Get database connection pool statistics
CREATE OR REPLACE FUNCTION get_connection_pool_stats()
RETURNS TABLE(
  total_connections int,
  active_connections int,
  utilization_percent numeric
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') as total_connections,
    (SELECT COUNT(*)::int FROM pg_stat_activity WHERE state = 'active') as active_connections,
    (
      (SELECT COUNT(*)::numeric FROM pg_stat_activity WHERE state = 'active') /
      NULLIF((SELECT setting::numeric FROM pg_settings WHERE name = 'max_connections'), 0)
    ) * 100 as utilization_percent;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- =============================================================================
-- Vault Failure Tracking
-- =============================================================================

-- Get count of vault access failures in time window
CREATE OR REPLACE FUNCTION get_vault_failure_count(p_hours int DEFAULT 1)
RETURNS int AS $$
BEGIN
  RETURN COALESCE(
    (
      SELECT COUNT(*)::int
      FROM audit_logs
      WHERE action = 'secret_access_failed'
        AND created_at > now() - (p_hours || ' hours')::interval
    ),
    0
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- =============================================================================
-- pg_stat_activity_count (for health checks)
-- =============================================================================

CREATE OR REPLACE FUNCTION pg_stat_activity_count()
RETURNS TABLE(count bigint) AS $$
BEGIN
  RETURN QUERY
  SELECT COUNT(*)::bigint FROM pg_stat_activity;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- =============================================================================
-- Grant Permissions
-- =============================================================================

GRANT EXECUTE ON FUNCTION get_error_rate TO authenticated;
GRANT EXECUTE ON FUNCTION get_error_rate_details TO authenticated;
GRANT EXECUTE ON FUNCTION get_p95_latency TO authenticated;
GRANT EXECUTE ON FUNCTION get_login_spike_stats TO authenticated;
GRANT EXECUTE ON FUNCTION get_connection_pool_stats TO authenticated;
GRANT EXECUTE ON FUNCTION get_vault_failure_count TO authenticated;
GRANT EXECUTE ON FUNCTION pg_stat_activity_count TO authenticated;
