-- =============================================================================
-- Phase 6: A/B Testing and Experiments Infrastructure
-- =============================================================================
-- Unified experimentation platform for Web, iOS, and Android
-- Supports feature flags, A/B tests, and exposure tracking
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================================
-- EXPERIMENTS TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.experiments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Experiment identification
    key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,

    -- Type and configuration
    experiment_type TEXT NOT NULL DEFAULT 'ab_test' CHECK (experiment_type IN (
        'feature_flag', 'ab_test', 'multivariate', 'rollout'
    )),

    -- Variants (JSONB array)
    variants JSONB NOT NULL DEFAULT '[{"key": "control", "weight": 50}, {"key": "treatment", "weight": 50}]'::jsonb,

    -- Targeting
    targeting_rules JSONB DEFAULT '{}'::jsonb,
    platforms TEXT[] DEFAULT ARRAY['ios', 'android', 'web'],
    min_app_version TEXT,
    max_app_version TEXT,

    -- Status
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
        'draft', 'running', 'paused', 'completed', 'archived'
    )),

    -- Traffic allocation (0-100)
    traffic_percentage INTEGER NOT NULL DEFAULT 100 CHECK (traffic_percentage >= 0 AND traffic_percentage <= 100),

    -- Ownership
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ
);

-- =============================================================================
-- EXPERIMENT EXPOSURES TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.experiment_exposures (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    experiment_id UUID NOT NULL REFERENCES public.experiments(id) ON DELETE CASCADE,
    experiment_key TEXT NOT NULL,

    -- User/device
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    device_id TEXT NOT NULL,

    -- Assignment
    variant_key TEXT NOT NULL,

    -- Context
    platform TEXT NOT NULL,
    app_version TEXT,

    -- Timestamps
    first_exposed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_exposed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    exposure_count INTEGER NOT NULL DEFAULT 1,

    -- Unique per user/device/experiment
    UNIQUE(experiment_id, device_id)
);

-- =============================================================================
-- EXPERIMENT EVENTS TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.experiment_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    experiment_id UUID NOT NULL REFERENCES public.experiments(id) ON DELETE CASCADE,
    exposure_id UUID REFERENCES public.experiment_exposures(id) ON DELETE SET NULL,

    -- Event details
    event_name TEXT NOT NULL,
    event_value DOUBLE PRECISION,

    -- Context
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    device_id TEXT NOT NULL,
    variant_key TEXT NOT NULL,
    platform TEXT NOT NULL,

    -- Properties
    properties JSONB DEFAULT '{}'::jsonb,

    -- Timestamp
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- FEATURE FLAGS TABLE (simplified experiments)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.feature_flags (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,

    -- Value (can be boolean, string, number, or JSON)
    value_type TEXT NOT NULL DEFAULT 'boolean' CHECK (value_type IN (
        'boolean', 'string', 'number', 'json'
    )),
    default_value JSONB NOT NULL DEFAULT 'false'::jsonb,

    -- Overrides by platform
    platform_overrides JSONB DEFAULT '{}'::jsonb,

    -- User overrides
    user_overrides JSONB DEFAULT '[]'::jsonb,

    -- Status
    enabled BOOLEAN NOT NULL DEFAULT false,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- INDEXES
-- =============================================================================

CREATE INDEX idx_experiments_key ON public.experiments(key) WHERE status = 'running';
CREATE INDEX idx_experiments_status ON public.experiments(status, created_at DESC);

CREATE INDEX idx_exposures_experiment ON public.experiment_exposures(experiment_id, first_exposed_at DESC);
CREATE INDEX idx_exposures_user ON public.experiment_exposures(user_id, first_exposed_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX idx_exposures_device ON public.experiment_exposures(device_id, first_exposed_at DESC);

CREATE INDEX idx_exp_events_experiment ON public.experiment_events(experiment_id, created_at DESC);
CREATE INDEX idx_exp_events_name ON public.experiment_events(event_name, experiment_id, created_at DESC);

CREATE INDEX idx_feature_flags_key ON public.feature_flags(key) WHERE enabled = true;

-- =============================================================================
-- RLS POLICIES
-- =============================================================================

ALTER TABLE public.experiments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.experiment_exposures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.experiment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;

-- Experiments readable by all, writable by service role
CREATE POLICY "Anyone can read running experiments"
ON public.experiments FOR SELECT
USING (status = 'running');

CREATE POLICY "Service role manages experiments"
ON public.experiments FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- Exposures
CREATE POLICY "Anyone can create exposures"
ON public.experiment_exposures FOR INSERT
WITH CHECK (true);

CREATE POLICY "Users can read own exposures"
ON public.experiment_exposures FOR SELECT
TO authenticated
USING (user_id = auth.uid());

CREATE POLICY "Service role manages exposures"
ON public.experiment_exposures FOR ALL
TO service_role
USING (true);

-- Events
CREATE POLICY "Anyone can create events"
ON public.experiment_events FOR INSERT
WITH CHECK (true);

CREATE POLICY "Service role manages events"
ON public.experiment_events FOR ALL
TO service_role
USING (true);

-- Feature flags
CREATE POLICY "Anyone can read enabled flags"
ON public.feature_flags FOR SELECT
USING (enabled = true);

CREATE POLICY "Service role manages flags"
ON public.feature_flags FOR ALL
TO service_role
USING (true);

-- =============================================================================
-- FUNCTIONS
-- =============================================================================

-- Get experiment assignment for a user/device
CREATE OR REPLACE FUNCTION public.get_experiment_assignment(
    p_experiment_key TEXT,
    p_device_id TEXT,
    p_user_id UUID DEFAULT NULL,
    p_platform TEXT DEFAULT 'web',
    p_app_version TEXT DEFAULT NULL
)
RETURNS TABLE (
    experiment_id UUID,
    variant_key TEXT,
    is_new_exposure BOOLEAN,
    experiment_config JSONB
) AS $$
DECLARE
    v_experiment public.experiments;
    v_exposure public.experiment_exposures;
    v_variant_key TEXT;
    v_is_new BOOLEAN := false;
    v_hash_value INTEGER;
BEGIN
    -- Get experiment
    SELECT * INTO v_experiment
    FROM public.experiments
    WHERE key = p_experiment_key
      AND status = 'running'
      AND (platforms IS NULL OR p_platform = ANY(platforms))
      AND (min_app_version IS NULL OR p_app_version >= min_app_version)
      AND (max_app_version IS NULL OR p_app_version <= max_app_version);

    IF v_experiment.id IS NULL THEN
        RETURN;
    END IF;

    -- Check for existing exposure
    SELECT * INTO v_exposure
    FROM public.experiment_exposures
    WHERE experiment_id = v_experiment.id
      AND device_id = p_device_id;

    IF v_exposure.id IS NOT NULL THEN
        -- Update existing exposure
        UPDATE public.experiment_exposures
        SET last_exposed_at = NOW(),
            exposure_count = exposure_count + 1,
            user_id = COALESCE(p_user_id, user_id)
        WHERE id = v_exposure.id;

        v_variant_key := v_exposure.variant_key;
    ELSE
        -- Check traffic allocation
        v_hash_value := abs(hashtext(p_device_id || p_experiment_key)) % 100;

        IF v_hash_value >= v_experiment.traffic_percentage THEN
            RETURN; -- Not in experiment
        END IF;

        -- Assign variant based on weights
        v_variant_key := assign_variant(v_experiment.variants, p_device_id, p_experiment_key);
        v_is_new := true;

        -- Create exposure
        INSERT INTO public.experiment_exposures (
            experiment_id,
            experiment_key,
            user_id,
            device_id,
            variant_key,
            platform,
            app_version
        ) VALUES (
            v_experiment.id,
            p_experiment_key,
            p_user_id,
            p_device_id,
            v_variant_key,
            p_platform,
            p_app_version
        );
    END IF;

    RETURN QUERY SELECT
        v_experiment.id,
        v_variant_key,
        v_is_new,
        jsonb_build_object(
            'key', v_experiment.key,
            'name', v_experiment.name,
            'type', v_experiment.experiment_type,
            'variants', v_experiment.variants
        );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Helper: Assign variant based on weights
CREATE OR REPLACE FUNCTION assign_variant(
    p_variants JSONB,
    p_device_id TEXT,
    p_experiment_key TEXT
)
RETURNS TEXT AS $$
DECLARE
    v_hash INTEGER;
    v_cumulative INTEGER := 0;
    v_variant JSONB;
BEGIN
    v_hash := abs(hashtext(p_device_id || ':variant:' || p_experiment_key)) % 100;

    FOR v_variant IN SELECT * FROM jsonb_array_elements(p_variants)
    LOOP
        v_cumulative := v_cumulative + COALESCE((v_variant->>'weight')::INTEGER, 50);
        IF v_hash < v_cumulative THEN
            RETURN v_variant->>'key';
        END IF;
    END LOOP;

    -- Fallback to first variant
    RETURN p_variants->0->>'key';
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Track experiment event
CREATE OR REPLACE FUNCTION public.track_experiment_event(
    p_experiment_key TEXT,
    p_event_name TEXT,
    p_device_id TEXT,
    p_event_value DOUBLE PRECISION DEFAULT NULL,
    p_user_id UUID DEFAULT NULL,
    p_platform TEXT DEFAULT 'web',
    p_properties JSONB DEFAULT '{}'::jsonb
)
RETURNS BOOLEAN AS $$
DECLARE
    v_exposure public.experiment_exposures;
BEGIN
    -- Find exposure
    SELECT e.* INTO v_exposure
    FROM public.experiment_exposures e
    JOIN public.experiments exp ON exp.id = e.experiment_id
    WHERE exp.key = p_experiment_key
      AND e.device_id = p_device_id;

    IF v_exposure.id IS NULL THEN
        RETURN false;
    END IF;

    -- Record event
    INSERT INTO public.experiment_events (
        experiment_id,
        exposure_id,
        event_name,
        event_value,
        user_id,
        device_id,
        variant_key,
        platform,
        properties
    ) VALUES (
        v_exposure.experiment_id,
        v_exposure.id,
        p_event_name,
        p_event_value,
        COALESCE(p_user_id, v_exposure.user_id),
        p_device_id,
        v_exposure.variant_key,
        p_platform,
        p_properties
    );

    RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get all active experiments for a device
CREATE OR REPLACE FUNCTION public.get_active_experiments(
    p_device_id TEXT,
    p_user_id UUID DEFAULT NULL,
    p_platform TEXT DEFAULT 'web',
    p_app_version TEXT DEFAULT NULL
)
RETURNS TABLE (
    experiment_key TEXT,
    variant_key TEXT,
    config JSONB
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        e.key,
        COALESCE(
            ex.variant_key,
            assign_variant(e.variants, p_device_id, e.key)
        ),
        jsonb_build_object(
            'name', e.name,
            'type', e.experiment_type,
            'variants', e.variants
        )
    FROM public.experiments e
    LEFT JOIN public.experiment_exposures ex
        ON ex.experiment_id = e.id AND ex.device_id = p_device_id
    WHERE e.status = 'running'
      AND (e.platforms IS NULL OR p_platform = ANY(e.platforms))
      AND (e.min_app_version IS NULL OR p_app_version >= e.min_app_version)
      AND (e.max_app_version IS NULL OR p_app_version <= e.max_app_version)
      AND (abs(hashtext(p_device_id || e.key)) % 100) < e.traffic_percentage;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get feature flag value
CREATE OR REPLACE FUNCTION public.get_feature_flag(
    p_key TEXT,
    p_user_id UUID DEFAULT NULL,
    p_platform TEXT DEFAULT 'web'
)
RETURNS JSONB AS $$
DECLARE
    v_flag public.feature_flags;
    v_override JSONB;
BEGIN
    SELECT * INTO v_flag
    FROM public.feature_flags
    WHERE key = p_key AND enabled = true;

    IF v_flag.id IS NULL THEN
        RETURN NULL;
    END IF;

    -- Check user overrides
    IF p_user_id IS NOT NULL AND v_flag.user_overrides IS NOT NULL THEN
        SELECT value INTO v_override
        FROM jsonb_array_elements(v_flag.user_overrides) elem
        WHERE elem->>'userId' = p_user_id::TEXT;

        IF v_override IS NOT NULL THEN
            RETURN v_override;
        END IF;
    END IF;

    -- Check platform overrides
    IF v_flag.platform_overrides ? p_platform THEN
        RETURN v_flag.platform_overrides->p_platform;
    END IF;

    RETURN v_flag.default_value;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- COMMENTS
-- =============================================================================

COMMENT ON TABLE public.experiments IS 'A/B tests and multivariate experiments';
COMMENT ON TABLE public.experiment_exposures IS 'Tracks which users/devices are exposed to which experiments';
COMMENT ON TABLE public.experiment_events IS 'Conversion and metric events for experiment analysis';
COMMENT ON TABLE public.feature_flags IS 'Simple feature flags with platform/user overrides';
