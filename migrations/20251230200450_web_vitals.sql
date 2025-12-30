-- Web Vitals Performance Monitoring
-- Stores Core Web Vitals metrics for production monitoring
-- Part of Phase 5: Observability & Architecture Hardening

-- =============================================================================
-- Web Vitals Table
-- =============================================================================

CREATE TABLE IF NOT EXISTS web_vitals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (name IN ('CLS', 'FID', 'FCP', 'LCP', 'TTFB', 'INP')),
  value numeric NOT NULL,
  rating text CHECK (rating IN ('good', 'needs-improvement', 'poor')),
  delta numeric,
  metric_id text,
  page_url text,
  user_agent text,
  navigation_type text,
  created_at timestamptz DEFAULT now() NOT NULL
);

COMMENT ON TABLE web_vitals IS 'Core Web Vitals metrics for performance monitoring';
COMMENT ON COLUMN web_vitals.name IS 'Metric name: CLS, FID, FCP, LCP, TTFB, INP';
COMMENT ON COLUMN web_vitals.value IS 'Raw metric value';
COMMENT ON COLUMN web_vitals.rating IS 'Performance rating: good, needs-improvement, poor';
COMMENT ON COLUMN web_vitals.page_url IS 'Page path where metric was recorded';

-- =============================================================================
-- Indexes
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_web_vitals_name ON web_vitals(name);
CREATE INDEX IF NOT EXISTS idx_web_vitals_created_at ON web_vitals(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_web_vitals_rating ON web_vitals(rating);
CREATE INDEX IF NOT EXISTS idx_web_vitals_name_created ON web_vitals(name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_web_vitals_page_url ON web_vitals(page_url) WHERE page_url IS NOT NULL;

-- =============================================================================
-- Row Level Security
-- =============================================================================

ALTER TABLE web_vitals ENABLE ROW LEVEL SECURITY;

-- Anyone can insert web vitals (including anonymous users for RUM)
CREATE POLICY "Anyone can insert web vitals" ON web_vitals
  FOR INSERT TO anon, authenticated
  WITH CHECK (true);

-- Only admins can read web vitals
CREATE POLICY "Admins can read web vitals" ON web_vitals
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

-- =============================================================================
-- RPC Functions for Dashboard
-- =============================================================================

-- Summary stats for all metrics
CREATE OR REPLACE FUNCTION get_web_vitals_summary(p_hours int DEFAULT 24)
RETURNS TABLE(
  metric_name text,
  sample_count bigint,
  p50 numeric,
  p75 numeric,
  p95 numeric,
  good_pct numeric,
  needs_improvement_pct numeric,
  poor_pct numeric
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    wv.name as metric_name,
    COUNT(*)::bigint as sample_count,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY wv.value) as p50,
    percentile_cont(0.75) WITHIN GROUP (ORDER BY wv.value) as p75,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY wv.value) as p95,
    ROUND((COUNT(*) FILTER (WHERE wv.rating = 'good')::numeric / NULLIF(COUNT(*), 0)) * 100, 2) as good_pct,
    ROUND((COUNT(*) FILTER (WHERE wv.rating = 'needs-improvement')::numeric / NULLIF(COUNT(*), 0)) * 100, 2) as needs_improvement_pct,
    ROUND((COUNT(*) FILTER (WHERE wv.rating = 'poor')::numeric / NULLIF(COUNT(*), 0)) * 100, 2) as poor_pct
  FROM web_vitals wv
  WHERE wv.created_at > now() - (p_hours || ' hours')::interval
  GROUP BY wv.name
  ORDER BY wv.name;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Page-level metrics
CREATE OR REPLACE FUNCTION get_web_vitals_by_page(p_hours int DEFAULT 24, p_limit int DEFAULT 20)
RETURNS TABLE(
  page_url text,
  lcp_p75 numeric,
  fid_p75 numeric,
  cls_p75 numeric,
  inp_p75 numeric,
  sample_count bigint
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    wv.page_url,
    percentile_cont(0.75) WITHIN GROUP (ORDER BY wv.value) FILTER (WHERE wv.name = 'LCP') as lcp_p75,
    percentile_cont(0.75) WITHIN GROUP (ORDER BY wv.value) FILTER (WHERE wv.name = 'FID') as fid_p75,
    percentile_cont(0.75) WITHIN GROUP (ORDER BY wv.value) FILTER (WHERE wv.name = 'CLS') as cls_p75,
    percentile_cont(0.75) WITHIN GROUP (ORDER BY wv.value) FILTER (WHERE wv.name = 'INP') as inp_p75,
    COUNT(*)::bigint as sample_count
  FROM web_vitals wv
  WHERE wv.created_at > now() - (p_hours || ' hours')::interval
    AND wv.page_url IS NOT NULL
  GROUP BY wv.page_url
  ORDER BY sample_count DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Trend data (hourly aggregates)
CREATE OR REPLACE FUNCTION get_web_vitals_trend(p_metric text, p_hours int DEFAULT 24)
RETURNS TABLE(
  hour timestamptz,
  p50 numeric,
  p75 numeric,
  p95 numeric,
  sample_count bigint
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    date_trunc('hour', wv.created_at) as hour,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY wv.value) as p50,
    percentile_cont(0.75) WITHIN GROUP (ORDER BY wv.value) as p75,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY wv.value) as p95,
    COUNT(*)::bigint as sample_count
  FROM web_vitals wv
  WHERE wv.name = p_metric
    AND wv.created_at > now() - (p_hours || ' hours')::interval
  GROUP BY date_trunc('hour', wv.created_at)
  ORDER BY hour;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- =============================================================================
-- Grant Permissions
-- =============================================================================

GRANT EXECUTE ON FUNCTION get_web_vitals_summary TO authenticated;
GRANT EXECUTE ON FUNCTION get_web_vitals_by_page TO authenticated;
GRANT EXECUTE ON FUNCTION get_web_vitals_trend TO authenticated;

-- =============================================================================
-- Cleanup job (optional - remove old data after 30 days)
-- =============================================================================

-- This can be run via a scheduled edge function or pg_cron
CREATE OR REPLACE FUNCTION cleanup_old_web_vitals()
RETURNS void AS $$
BEGIN
  DELETE FROM web_vitals
  WHERE created_at < now() - interval '30 days';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
