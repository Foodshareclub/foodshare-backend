-- ============================================================================
-- METRICS INFRASTRUCTURE
-- Provides observability for Edge Functions with:
-- - Function call tracking
-- - Circuit breaker status
-- - Health check history
-- - Error rate and latency metrics
-- ============================================================================

-- Create metrics schema
CREATE SCHEMA IF NOT EXISTS metrics;

-- Grant usage to authenticated and service role
GRANT USAGE ON SCHEMA metrics TO authenticated, service_role;

-- ============================================================================
-- FUNCTION CALLS TABLE
-- Records every edge function invocation for observability
-- ============================================================================

CREATE TABLE IF NOT EXISTS metrics.function_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  function_name text NOT NULL,
  request_id text NOT NULL,
  correlation_id text,
  user_id uuid,
  platform text CHECK (platform IN ('ios', 'android', 'web', 'unknown', NULL)),
  started_at timestamptz NOT NULL DEFAULT now(),
  duration_ms integer,
  status_code integer,
  error_code text,
  error_message text,
  metadata jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_function_calls_function_name
  ON metrics.function_calls (function_name, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_function_calls_created_at
  ON metrics.function_calls (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_function_calls_status_code
  ON metrics.function_calls (status_code)
  WHERE status_code >= 400;

CREATE INDEX IF NOT EXISTS idx_function_calls_user_id
  ON metrics.function_calls (user_id)
  WHERE user_id IS NOT NULL;

-- ============================================================================
-- CIRCUIT BREAKER STATUS TABLE
-- Tracks circuit breaker state for each service
-- ============================================================================

CREATE TABLE IF NOT EXISTS metrics.circuit_status (
  circuit_name text PRIMARY KEY,
  state text NOT NULL DEFAULT 'closed' CHECK (state IN ('closed', 'open', 'half-open')),
  failure_count integer NOT NULL DEFAULT 0,
  success_count integer NOT NULL DEFAULT 0,
  last_failure_time timestamptz,
  last_success_time timestamptz,
  last_state_change timestamptz NOT NULL DEFAULT now(),
  total_requests bigint NOT NULL DEFAULT 0,
  total_failures bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- HEALTH CHECKS TABLE
-- Stores health check results with response times
-- ============================================================================

CREATE TABLE IF NOT EXISTS metrics.health_checks (
  id uuid DEFAULT gen_random_uuid(),
  service text NOT NULL,
  status text NOT NULL CHECK (status IN ('healthy', 'degraded', 'unhealthy')),
  response_time_ms integer,
  details jsonb DEFAULT '{}',
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Create partitions for health checks (monthly)
CREATE TABLE IF NOT EXISTS metrics.health_checks_2024_12
  PARTITION OF metrics.health_checks
  FOR VALUES FROM ('2024-12-01') TO ('2025-01-01');

CREATE TABLE IF NOT EXISTS metrics.health_checks_2025_01
  PARTITION OF metrics.health_checks
  FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');

CREATE TABLE IF NOT EXISTS metrics.health_checks_2025_02
  PARTITION OF metrics.health_checks
  FOR VALUES FROM ('2025-02-01') TO ('2025-03-01');

CREATE TABLE IF NOT EXISTS metrics.health_checks_2025_03
  PARTITION OF metrics.health_checks
  FOR VALUES FROM ('2025-03-01') TO ('2025-04-01');

-- Index for health check queries
CREATE INDEX IF NOT EXISTS idx_health_checks_service_created
  ON metrics.health_checks (service, created_at DESC);

-- ============================================================================
-- RPC FUNCTIONS FOR METRICS
-- ============================================================================

-- Get error rate for the last N minutes
CREATE OR REPLACE FUNCTION metrics.get_error_rate(p_minutes integer DEFAULT 5)
RETURNS TABLE(
  total_requests bigint,
  error_count bigint,
  error_rate numeric
)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = metrics
AS $$
  SELECT
    COUNT(*)::bigint AS total_requests,
    COUNT(*) FILTER (WHERE status_code >= 500)::bigint AS error_count,
    ROUND(
      COALESCE(
        COUNT(*) FILTER (WHERE status_code >= 500)::numeric / NULLIF(COUNT(*), 0) * 100,
        0
      ),
      2
    ) AS error_rate
  FROM metrics.function_calls
  WHERE created_at > now() - (p_minutes || ' minutes')::interval;
$$;

-- Get P95 latency for the last N minutes
CREATE OR REPLACE FUNCTION metrics.get_p95_latency(p_minutes integer DEFAULT 5)
RETURNS integer
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = metrics
AS $$
  SELECT COALESCE(
    percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::integer,
    0
  )
  FROM metrics.function_calls
  WHERE created_at > now() - (p_minutes || ' minutes')::interval
    AND duration_ms IS NOT NULL;
$$;

-- Get function metrics summary
CREATE OR REPLACE FUNCTION metrics.get_function_metrics(
  p_function_name text DEFAULT NULL,
  p_minutes integer DEFAULT 60
)
RETURNS TABLE(
  function_name text,
  total_calls bigint,
  success_count bigint,
  error_count bigint,
  error_rate numeric,
  avg_duration_ms numeric,
  p50_duration_ms integer,
  p95_duration_ms integer,
  p99_duration_ms integer
)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = metrics
AS $$
  SELECT
    fc.function_name,
    COUNT(*)::bigint AS total_calls,
    COUNT(*) FILTER (WHERE fc.status_code < 400)::bigint AS success_count,
    COUNT(*) FILTER (WHERE fc.status_code >= 400)::bigint AS error_count,
    ROUND(
      COALESCE(
        COUNT(*) FILTER (WHERE fc.status_code >= 400)::numeric / NULLIF(COUNT(*), 0) * 100,
        0
      ),
      2
    ) AS error_rate,
    ROUND(AVG(fc.duration_ms)::numeric, 2) AS avg_duration_ms,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY fc.duration_ms)::integer AS p50_duration_ms,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY fc.duration_ms)::integer AS p95_duration_ms,
    percentile_cont(0.99) WITHIN GROUP (ORDER BY fc.duration_ms)::integer AS p99_duration_ms
  FROM metrics.function_calls fc
  WHERE fc.created_at > now() - (p_minutes || ' minutes')::interval
    AND (p_function_name IS NULL OR fc.function_name = p_function_name)
  GROUP BY fc.function_name
  ORDER BY total_calls DESC;
$$;

-- Record a function call (for use from Edge Functions)
CREATE OR REPLACE FUNCTION metrics.record_function_call(
  p_function_name text,
  p_request_id text,
  p_duration_ms integer,
  p_status_code integer,
  p_correlation_id text DEFAULT NULL,
  p_user_id uuid DEFAULT NULL,
  p_platform text DEFAULT NULL,
  p_error_code text DEFAULT NULL,
  p_error_message text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'
)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = metrics
AS $$
  INSERT INTO metrics.function_calls (
    function_name,
    request_id,
    correlation_id,
    user_id,
    platform,
    duration_ms,
    status_code,
    error_code,
    error_message,
    metadata
  ) VALUES (
    p_function_name,
    p_request_id,
    p_correlation_id,
    p_user_id,
    p_platform,
    p_duration_ms,
    p_status_code,
    p_error_code,
    p_error_message,
    p_metadata
  )
  RETURNING id;
$$;

-- Update circuit breaker status
CREATE OR REPLACE FUNCTION metrics.update_circuit_status(
  p_circuit_name text,
  p_state text,
  p_failure_count integer,
  p_success_count integer DEFAULT 0
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metrics
AS $$
BEGIN
  INSERT INTO metrics.circuit_status (
    circuit_name,
    state,
    failure_count,
    success_count,
    last_state_change,
    updated_at
  ) VALUES (
    p_circuit_name,
    p_state,
    p_failure_count,
    p_success_count,
    now(),
    now()
  )
  ON CONFLICT (circuit_name) DO UPDATE SET
    state = EXCLUDED.state,
    failure_count = EXCLUDED.failure_count,
    success_count = EXCLUDED.success_count,
    last_state_change = CASE
      WHEN metrics.circuit_status.state != EXCLUDED.state THEN now()
      ELSE metrics.circuit_status.last_state_change
    END,
    total_requests = metrics.circuit_status.total_requests + 1,
    total_failures = metrics.circuit_status.total_failures +
      CASE WHEN p_state = 'open' THEN 1 ELSE 0 END,
    updated_at = now();
END;
$$;

-- Get all circuit statuses
CREATE OR REPLACE FUNCTION metrics.get_all_circuit_statuses()
RETURNS TABLE(
  circuit_name text,
  state text,
  failure_count integer,
  success_count integer,
  last_failure_time timestamptz,
  last_success_time timestamptz,
  last_state_change timestamptz,
  total_requests bigint,
  total_failures bigint,
  failure_rate numeric
)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = metrics
AS $$
  SELECT
    cs.circuit_name,
    cs.state,
    cs.failure_count,
    cs.success_count,
    cs.last_failure_time,
    cs.last_success_time,
    cs.last_state_change,
    cs.total_requests,
    cs.total_failures,
    ROUND(
      COALESCE(
        cs.total_failures::numeric / NULLIF(cs.total_requests, 0) * 100,
        0
      ),
      2
    ) AS failure_rate
  FROM metrics.circuit_status cs
  ORDER BY cs.last_state_change DESC;
$$;

-- ============================================================================
-- CLEANUP POLICY
-- Automatically delete old metrics data
-- ============================================================================

-- Function to cleanup old function calls (default: keep 30 days)
CREATE OR REPLACE FUNCTION metrics.cleanup_old_metrics(p_days integer DEFAULT 30)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metrics
AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM metrics.function_calls
  WHERE created_at < now() - (p_days || ' days')::interval;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

-- ============================================================================
-- GRANTS
-- ============================================================================

-- Allow service role to use all metrics functions
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA metrics TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA metrics TO service_role;

-- Allow authenticated users to read their own metrics (if needed)
GRANT SELECT ON metrics.function_calls TO authenticated;
GRANT SELECT ON metrics.circuit_status TO authenticated;
GRANT SELECT ON metrics.health_checks TO authenticated;

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON SCHEMA metrics IS 'Observability infrastructure for Edge Functions';
COMMENT ON TABLE metrics.function_calls IS 'Records all edge function invocations';
COMMENT ON TABLE metrics.circuit_status IS 'Tracks circuit breaker state per service';
COMMENT ON TABLE metrics.health_checks IS 'Stores health check results (partitioned by month)';
COMMENT ON FUNCTION metrics.get_error_rate IS 'Returns error rate for last N minutes';
COMMENT ON FUNCTION metrics.get_p95_latency IS 'Returns P95 latency for last N minutes';
COMMENT ON FUNCTION metrics.get_function_metrics IS 'Returns detailed metrics per function';
COMMENT ON FUNCTION metrics.record_function_call IS 'Records a function call from Edge Function';
