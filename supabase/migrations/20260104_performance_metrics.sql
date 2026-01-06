-- =============================================================================
-- Phases 13-15: Pagination, Prefetch, and Performance Infrastructure
-- =============================================================================
-- Combined infrastructure for pagination, prefetch hints, and performance monitoring
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================================
-- PAGINATION CURSORS TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.pagination_cursors (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,

    -- Cursor context
    resource_type TEXT NOT NULL,
    cursor_value TEXT NOT NULL,
    filter_hash TEXT,

    -- Window state
    window_start INTEGER NOT NULL DEFAULT 0,
    window_size INTEGER NOT NULL DEFAULT 20,
    total_count INTEGER,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '1 hour'
);

-- =============================================================================
-- NAVIGATION PATTERNS TABLE (for prefetch prediction)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.navigation_patterns (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Pattern identification
    from_screen TEXT NOT NULL,
    to_screen TEXT NOT NULL,

    -- Statistics
    transition_count INTEGER NOT NULL DEFAULT 1,
    avg_time_ms DOUBLE PRECISION,

    -- User segment (optional)
    user_segment TEXT,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(from_screen, to_screen, COALESCE(user_segment, ''))
);

-- =============================================================================
-- PREFETCH HINTS TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.prefetch_hints (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Screen context
    screen_name TEXT NOT NULL,
    platform TEXT NOT NULL,

    -- Prefetch config
    resources JSONB NOT NULL DEFAULT '[]'::jsonb,
    priority INTEGER NOT NULL DEFAULT 0,
    probability DOUBLE PRECISION NOT NULL DEFAULT 0.5,

    -- Validity
    valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    valid_until TIMESTAMPTZ,

    UNIQUE(screen_name, platform)
);

-- =============================================================================
-- PERFORMANCE METRICS TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.performance_metrics (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Context
    metric_name TEXT NOT NULL,
    metric_type TEXT NOT NULL CHECK (metric_type IN (
        'timing', 'count', 'gauge', 'histogram'
    )),

    -- Value
    value DOUBLE PRECISION NOT NULL,
    unit TEXT,

    -- Dimensions
    platform TEXT NOT NULL,
    app_version TEXT,
    screen_name TEXT,
    device_type TEXT,

    -- Tags
    tags JSONB DEFAULT '{}'::jsonb,

    -- Timestamp
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
) PARTITION BY RANGE (recorded_at);

-- Create partitions
CREATE TABLE public.performance_metrics_2026_01 PARTITION OF public.performance_metrics
    FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE public.performance_metrics_2026_02 PARTITION OF public.performance_metrics
    FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');

-- =============================================================================
-- PERFORMANCE BUDGETS TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.performance_budgets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    metric_name TEXT NOT NULL,
    screen_name TEXT,
    platform TEXT,

    -- Thresholds
    warning_threshold DOUBLE PRECISION NOT NULL,
    error_threshold DOUBLE PRECISION NOT NULL,
    unit TEXT,

    -- Status
    enabled BOOLEAN NOT NULL DEFAULT true,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(metric_name, COALESCE(screen_name, ''), COALESCE(platform, ''))
);

-- =============================================================================
-- PERFORMANCE ALERTS TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.performance_alerts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    budget_id UUID REFERENCES public.performance_budgets(id) ON DELETE CASCADE,

    -- Alert details
    alert_type TEXT NOT NULL CHECK (alert_type IN ('warning', 'error')),
    metric_name TEXT NOT NULL,
    metric_value DOUBLE PRECISION NOT NULL,
    threshold_value DOUBLE PRECISION NOT NULL,

    -- Context
    platform TEXT,
    app_version TEXT,
    screen_name TEXT,

    -- Status
    acknowledged BOOLEAN NOT NULL DEFAULT false,
    acknowledged_by UUID REFERENCES auth.users(id),
    acknowledged_at TIMESTAMPTZ,

    -- Timestamp
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- INDEXES
-- =============================================================================

CREATE INDEX idx_pagination_cursors_user ON public.pagination_cursors(user_id, resource_type, expires_at);
CREATE INDEX idx_navigation_patterns_from ON public.navigation_patterns(from_screen, transition_count DESC);
CREATE INDEX idx_prefetch_hints_screen ON public.prefetch_hints(screen_name, platform);
CREATE INDEX idx_performance_metrics_name ON public.performance_metrics(metric_name, recorded_at DESC);
CREATE INDEX idx_performance_metrics_screen ON public.performance_metrics(screen_name, recorded_at DESC) WHERE screen_name IS NOT NULL;
CREATE INDEX idx_performance_alerts_unack ON public.performance_alerts(acknowledged, created_at DESC) WHERE NOT acknowledged;

-- =============================================================================
-- RLS POLICIES
-- =============================================================================

ALTER TABLE public.pagination_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.navigation_patterns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prefetch_hints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.performance_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.performance_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.performance_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own cursors" ON public.pagination_cursors FOR ALL TO authenticated
    USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY "Anyone reads navigation patterns" ON public.navigation_patterns FOR SELECT USING (true);
CREATE POLICY "Service role manages patterns" ON public.navigation_patterns FOR ALL TO service_role USING (true);

CREATE POLICY "Anyone reads prefetch hints" ON public.prefetch_hints FOR SELECT USING (true);
CREATE POLICY "Service role manages hints" ON public.prefetch_hints FOR ALL TO service_role USING (true);

CREATE POLICY "Anyone inserts metrics" ON public.performance_metrics FOR INSERT WITH CHECK (true);
CREATE POLICY "Service role manages metrics" ON public.performance_metrics FOR ALL TO service_role USING (true);

CREATE POLICY "Service role manages budgets" ON public.performance_budgets FOR ALL TO service_role USING (true);
CREATE POLICY "Service role manages alerts" ON public.performance_alerts FOR ALL TO service_role USING (true);

-- =============================================================================
-- FUNCTIONS
-- =============================================================================

-- Get prefetch hints for a screen
CREATE OR REPLACE FUNCTION public.get_prefetch_hints(
    p_screen_name TEXT,
    p_platform TEXT DEFAULT 'web'
)
RETURNS JSONB AS $$
DECLARE
    v_hints JSONB;
BEGIN
    SELECT jsonb_agg(jsonb_build_object(
        'resource', r.value->>'resource',
        'type', r.value->>'type',
        'priority', COALESCE((r.value->>'priority')::INTEGER, ph.priority),
        'probability', ph.probability
    ))
    INTO v_hints
    FROM public.prefetch_hints ph
    CROSS JOIN LATERAL jsonb_array_elements(ph.resources) r
    WHERE ph.screen_name = p_screen_name
      AND ph.platform = p_platform
      AND (ph.valid_until IS NULL OR ph.valid_until > NOW());

    -- Also add predicted navigations
    SELECT v_hints || COALESCE(jsonb_agg(jsonb_build_object(
        'resource', 'screen:' || np.to_screen,
        'type', 'navigation',
        'probability', np.transition_count::FLOAT / (SELECT SUM(transition_count) FROM public.navigation_patterns WHERE from_screen = p_screen_name)
    )), '[]'::jsonb)
    INTO v_hints
    FROM public.navigation_patterns np
    WHERE np.from_screen = p_screen_name
    ORDER BY np.transition_count DESC
    LIMIT 3;

    RETURN COALESCE(v_hints, '[]'::jsonb);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Record navigation and update patterns
CREATE OR REPLACE FUNCTION public.record_navigation(
    p_from_screen TEXT,
    p_to_screen TEXT,
    p_time_ms DOUBLE PRECISION DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
    INSERT INTO public.navigation_patterns (from_screen, to_screen, avg_time_ms)
    VALUES (p_from_screen, p_to_screen, p_time_ms)
    ON CONFLICT (from_screen, to_screen, COALESCE(user_segment, '')) DO UPDATE SET
        transition_count = navigation_patterns.transition_count + 1,
        avg_time_ms = (COALESCE(navigation_patterns.avg_time_ms, 0) * navigation_patterns.transition_count + COALESCE(p_time_ms, 0))
                      / (navigation_patterns.transition_count + 1),
        updated_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Ingest performance metric with budget check
CREATE OR REPLACE FUNCTION public.ingest_performance_metric(
    p_metric_name TEXT,
    p_metric_type TEXT,
    p_value DOUBLE PRECISION,
    p_platform TEXT,
    p_app_version TEXT DEFAULT NULL,
    p_screen_name TEXT DEFAULT NULL,
    p_device_type TEXT DEFAULT NULL,
    p_tags JSONB DEFAULT '{}'::jsonb
)
RETURNS BOOLEAN AS $$
DECLARE
    v_budget public.performance_budgets;
BEGIN
    -- Insert metric
    INSERT INTO public.performance_metrics (
        metric_name, metric_type, value, platform, app_version, screen_name, device_type, tags
    ) VALUES (
        p_metric_name, p_metric_type, p_value, p_platform, p_app_version, p_screen_name, p_device_type, p_tags
    );

    -- Check budgets
    SELECT * INTO v_budget
    FROM public.performance_budgets
    WHERE metric_name = p_metric_name
      AND (screen_name IS NULL OR screen_name = p_screen_name)
      AND (platform IS NULL OR platform = p_platform)
      AND enabled = true
    ORDER BY screen_name NULLS LAST, platform NULLS LAST
    LIMIT 1;

    IF v_budget.id IS NOT NULL THEN
        IF p_value > v_budget.error_threshold THEN
            INSERT INTO public.performance_alerts (
                budget_id, alert_type, metric_name, metric_value, threshold_value, platform, app_version, screen_name
            ) VALUES (
                v_budget.id, 'error', p_metric_name, p_value, v_budget.error_threshold, p_platform, p_app_version, p_screen_name
            );
        ELSIF p_value > v_budget.warning_threshold THEN
            INSERT INTO public.performance_alerts (
                budget_id, alert_type, metric_name, metric_value, threshold_value, platform, app_version, screen_name
            ) VALUES (
                v_budget.id, 'warning', p_metric_name, p_value, v_budget.warning_threshold, p_platform, p_app_version, p_screen_name
            );
        END IF;
    END IF;

    RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON TABLE public.pagination_cursors IS 'Cursor-based pagination state for windowed lists';
COMMENT ON TABLE public.navigation_patterns IS 'User navigation patterns for prefetch prediction';
COMMENT ON TABLE public.prefetch_hints IS 'Screen-specific prefetch recommendations';
COMMENT ON TABLE public.performance_metrics IS 'Partitioned performance metrics storage';
COMMENT ON TABLE public.performance_budgets IS 'Performance budget thresholds per metric/screen';
COMMENT ON TABLE public.performance_alerts IS 'Performance budget violation alerts';
