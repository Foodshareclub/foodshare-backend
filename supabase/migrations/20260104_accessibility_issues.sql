-- =============================================================================
-- Phase 1: Accessibility Issues Table
-- =============================================================================
-- Track accessibility audit results across all platforms (Web/iOS/Android)
-- Enables monitoring WCAG compliance and regression detection
-- =============================================================================

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================================
-- ACCESSIBILITY ISSUES TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.accessibility_issues (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Audit context
    screen_name TEXT NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
    app_version TEXT NOT NULL,
    wcag_level TEXT NOT NULL DEFAULT 'AA' CHECK (wcag_level IN ('A', 'AA', 'AAA')),

    -- Audit results
    passed BOOLEAN NOT NULL DEFAULT false,
    score DECIMAL(5,2) NOT NULL DEFAULT 0.00 CHECK (score >= 0 AND score <= 100),
    audited_element_count INTEGER NOT NULL DEFAULT 0,

    -- Issue counts by severity
    critical_count INTEGER NOT NULL DEFAULT 0,
    major_count INTEGER NOT NULL DEFAULT 0,
    minor_count INTEGER NOT NULL DEFAULT 0,

    -- Detailed issues (JSONB array)
    issues JSONB NOT NULL DEFAULT '[]'::jsonb,

    -- Metadata
    device_info JSONB DEFAULT '{}'::jsonb,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- For tracking regressions
    build_number TEXT,
    commit_hash TEXT
);

-- =============================================================================
-- INDEXES
-- =============================================================================

-- Query by screen and platform
CREATE INDEX idx_accessibility_issues_screen_platform
ON public.accessibility_issues(screen_name, platform);

-- Query recent issues
CREATE INDEX idx_accessibility_issues_created_at
ON public.accessibility_issues(created_at DESC);

-- Find failing audits
CREATE INDEX idx_accessibility_issues_passed
ON public.accessibility_issues(passed) WHERE NOT passed;

-- Find critical issues
CREATE INDEX idx_accessibility_issues_critical
ON public.accessibility_issues(critical_count) WHERE critical_count > 0;

-- Query by app version for regression tracking
CREATE INDEX idx_accessibility_issues_version
ON public.accessibility_issues(app_version, platform);

-- =============================================================================
-- RLS POLICIES
-- =============================================================================

ALTER TABLE public.accessibility_issues ENABLE ROW LEVEL SECURITY;

-- Anyone can insert accessibility issues (for anonymous crash reports)
CREATE POLICY "Anyone can report accessibility issues"
ON public.accessibility_issues FOR INSERT
WITH CHECK (true);

-- Authenticated users can read all issues
CREATE POLICY "Authenticated users can read accessibility issues"
ON public.accessibility_issues FOR SELECT
TO authenticated
USING (true);

-- Service role can do everything
CREATE POLICY "Service role has full access to accessibility issues"
ON public.accessibility_issues FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- =============================================================================
-- ACCESSIBILITY AUDIT SUMMARY VIEW
-- =============================================================================

CREATE OR REPLACE VIEW public.accessibility_audit_summary AS
SELECT
    screen_name,
    platform,
    wcag_level,
    COUNT(*) as total_audits,
    COUNT(*) FILTER (WHERE passed) as passed_audits,
    ROUND(AVG(score), 2) as avg_score,
    SUM(critical_count) as total_critical,
    SUM(major_count) as total_major,
    SUM(minor_count) as total_minor,
    MAX(created_at) as last_audit_at
FROM public.accessibility_issues
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY screen_name, platform, wcag_level
ORDER BY total_critical DESC, total_major DESC;

-- =============================================================================
-- ACCESSIBILITY REGRESSION ALERTS TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.accessibility_regression_alerts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Alert context
    screen_name TEXT NOT NULL,
    platform TEXT NOT NULL,

    -- Regression details
    previous_score DECIMAL(5,2) NOT NULL,
    current_score DECIMAL(5,2) NOT NULL,
    score_delta DECIMAL(5,2) GENERATED ALWAYS AS (current_score - previous_score) STORED,

    previous_critical_count INTEGER NOT NULL DEFAULT 0,
    current_critical_count INTEGER NOT NULL DEFAULT 0,

    -- Reference to issues
    previous_audit_id UUID REFERENCES public.accessibility_issues(id),
    current_audit_id UUID REFERENCES public.accessibility_issues(id),

    -- Alert status
    acknowledged BOOLEAN NOT NULL DEFAULT false,
    acknowledged_by UUID REFERENCES auth.users(id),
    acknowledged_at TIMESTAMPTZ,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for unacknowledged alerts
CREATE INDEX idx_accessibility_regression_alerts_unack
ON public.accessibility_regression_alerts(acknowledged, created_at DESC)
WHERE NOT acknowledged;

-- RLS for regression alerts
ALTER TABLE public.accessibility_regression_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read regression alerts"
ON public.accessibility_regression_alerts FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Service role manages regression alerts"
ON public.accessibility_regression_alerts FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- =============================================================================
-- FUNCTION: Check for Accessibility Regressions
-- =============================================================================

CREATE OR REPLACE FUNCTION public.check_accessibility_regression()
RETURNS TRIGGER AS $$
DECLARE
    prev_audit RECORD;
    score_threshold DECIMAL := 10.0; -- Alert if score drops by more than 10%
BEGIN
    -- Find the previous audit for the same screen/platform
    SELECT * INTO prev_audit
    FROM public.accessibility_issues
    WHERE screen_name = NEW.screen_name
      AND platform = NEW.platform
      AND wcag_level = NEW.wcag_level
      AND id != NEW.id
    ORDER BY created_at DESC
    LIMIT 1;

    -- If there's a previous audit and score dropped significantly
    IF prev_audit.id IS NOT NULL THEN
        IF (prev_audit.score - NEW.score) > score_threshold
           OR (NEW.critical_count > prev_audit.critical_count) THEN
            INSERT INTO public.accessibility_regression_alerts (
                screen_name,
                platform,
                previous_score,
                current_score,
                previous_critical_count,
                current_critical_count,
                previous_audit_id,
                current_audit_id
            ) VALUES (
                NEW.screen_name,
                NEW.platform,
                prev_audit.score,
                NEW.score,
                prev_audit.critical_count,
                NEW.critical_count,
                prev_audit.id,
                NEW.id
            );
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to check for regressions on new audits
CREATE TRIGGER trigger_check_accessibility_regression
AFTER INSERT ON public.accessibility_issues
FOR EACH ROW
EXECUTE FUNCTION public.check_accessibility_regression();

-- =============================================================================
-- RPC FUNCTIONS
-- =============================================================================

-- Get accessibility summary for a screen
CREATE OR REPLACE FUNCTION public.get_accessibility_summary(
    p_screen_name TEXT,
    p_platform TEXT DEFAULT NULL,
    p_days INTEGER DEFAULT 30
)
RETURNS TABLE (
    screen_name TEXT,
    platform TEXT,
    wcag_level TEXT,
    total_audits BIGINT,
    pass_rate DECIMAL,
    avg_score DECIMAL,
    last_score DECIMAL,
    trend TEXT,
    critical_issues BIGINT
) AS $$
BEGIN
    RETURN QUERY
    WITH recent_audits AS (
        SELECT
            ai.screen_name,
            ai.platform,
            ai.wcag_level,
            ai.score,
            ai.passed,
            ai.critical_count,
            ai.created_at,
            ROW_NUMBER() OVER (
                PARTITION BY ai.screen_name, ai.platform, ai.wcag_level
                ORDER BY ai.created_at DESC
            ) as rn
        FROM public.accessibility_issues ai
        WHERE ai.screen_name = p_screen_name
          AND (p_platform IS NULL OR ai.platform = p_platform)
          AND ai.created_at > NOW() - (p_days || ' days')::INTERVAL
    )
    SELECT
        ra.screen_name,
        ra.platform,
        ra.wcag_level,
        COUNT(*)::BIGINT as total_audits,
        ROUND((COUNT(*) FILTER (WHERE ra.passed)::DECIMAL / NULLIF(COUNT(*), 0) * 100), 2) as pass_rate,
        ROUND(AVG(ra.score), 2) as avg_score,
        (SELECT score FROM recent_audits WHERE rn = 1 AND recent_audits.screen_name = ra.screen_name AND recent_audits.platform = ra.platform LIMIT 1) as last_score,
        CASE
            WHEN (SELECT score FROM recent_audits WHERE rn = 1 LIMIT 1) >
                 (SELECT AVG(score) FROM recent_audits WHERE rn <= 5) THEN 'improving'
            WHEN (SELECT score FROM recent_audits WHERE rn = 1 LIMIT 1) <
                 (SELECT AVG(score) FROM recent_audits WHERE rn <= 5) THEN 'declining'
            ELSE 'stable'
        END as trend,
        SUM(ra.critical_count)::BIGINT as critical_issues
    FROM recent_audits ra
    GROUP BY ra.screen_name, ra.platform, ra.wcag_level;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Submit accessibility audit result
CREATE OR REPLACE FUNCTION public.submit_accessibility_audit(
    p_screen_name TEXT,
    p_platform TEXT,
    p_app_version TEXT,
    p_wcag_level TEXT DEFAULT 'AA',
    p_passed BOOLEAN DEFAULT false,
    p_score DECIMAL DEFAULT 0,
    p_audited_element_count INTEGER DEFAULT 0,
    p_critical_count INTEGER DEFAULT 0,
    p_major_count INTEGER DEFAULT 0,
    p_minor_count INTEGER DEFAULT 0,
    p_issues JSONB DEFAULT '[]'::jsonb,
    p_device_info JSONB DEFAULT '{}'::jsonb,
    p_build_number TEXT DEFAULT NULL,
    p_commit_hash TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
    v_audit_id UUID;
BEGIN
    INSERT INTO public.accessibility_issues (
        screen_name,
        platform,
        app_version,
        wcag_level,
        passed,
        score,
        audited_element_count,
        critical_count,
        major_count,
        minor_count,
        issues,
        device_info,
        user_id,
        build_number,
        commit_hash
    ) VALUES (
        p_screen_name,
        p_platform,
        p_app_version,
        p_wcag_level,
        p_passed,
        p_score,
        p_audited_element_count,
        p_critical_count,
        p_major_count,
        p_minor_count,
        p_issues,
        p_device_info,
        auth.uid(),
        p_build_number,
        p_commit_hash
    )
    RETURNING id INTO v_audit_id;

    RETURN v_audit_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- COMMENTS
-- =============================================================================

COMMENT ON TABLE public.accessibility_issues IS
'Stores accessibility audit results from iOS, Android, and Web platforms for WCAG compliance tracking';

COMMENT ON TABLE public.accessibility_regression_alerts IS
'Automatic alerts when accessibility scores regress or critical issues increase';

COMMENT ON FUNCTION public.check_accessibility_regression IS
'Trigger function that creates alerts when accessibility regresses';

COMMENT ON FUNCTION public.get_accessibility_summary IS
'Get accessibility audit summary for a screen with trends and pass rates';

COMMENT ON FUNCTION public.submit_accessibility_audit IS
'Submit an accessibility audit result from any platform';
