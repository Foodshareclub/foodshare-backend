-- =============================================================================
-- Phases 16-20: Rating, Search, Localization, Repository, and BFF Infrastructure
-- =============================================================================
-- Unified infrastructure for remaining features
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================================
-- PHASE 16: RATING AGGREGATES
-- =============================================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS public.rating_aggregates AS
SELECT
    target_user_id,
    COUNT(*) as review_count,
    ROUND(AVG(rating)::NUMERIC, 2) as avg_rating,
    ROUND(STDDEV(rating)::NUMERIC, 2) as rating_stddev,
    COUNT(*) FILTER (WHERE rating >= 4) as positive_count,
    COUNT(*) FILTER (WHERE rating <= 2) as negative_count,
    MAX(created_at) as last_review_at,
    jsonb_build_object(
        '5', COUNT(*) FILTER (WHERE rating = 5),
        '4', COUNT(*) FILTER (WHERE rating = 4),
        '3', COUNT(*) FILTER (WHERE rating = 3),
        '2', COUNT(*) FILTER (WHERE rating = 2),
        '1', COUNT(*) FILTER (WHERE rating = 1)
    ) as rating_distribution
FROM public.reviews
WHERE status = 'approved'
GROUP BY target_user_id;

CREATE UNIQUE INDEX idx_rating_aggregates_user ON public.rating_aggregates(target_user_id);

-- Function to refresh rating aggregates
CREATE OR REPLACE FUNCTION public.refresh_rating_aggregates()
RETURNS VOID AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.rating_aggregates;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to refresh on review changes
CREATE OR REPLACE FUNCTION public.trigger_refresh_ratings()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_notify('rating_changed', json_build_object('user_id', COALESCE(NEW.target_user_id, OLD.target_user_id))::text);
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_reviews_rating_refresh
AFTER INSERT OR UPDATE OR DELETE ON public.reviews
FOR EACH ROW EXECUTE FUNCTION public.trigger_refresh_ratings();

-- =============================================================================
-- PHASE 17: SEARCH HISTORY & SUGGESTIONS
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.search_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    device_id TEXT,

    -- Search details
    query TEXT NOT NULL,
    query_normalized TEXT NOT NULL,
    filters JSONB DEFAULT '{}'::jsonb,

    -- Results
    result_count INTEGER,
    clicked_result_id TEXT,

    -- Context
    platform TEXT NOT NULL,

    -- Timestamp
    searched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.search_suggestions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    term TEXT NOT NULL UNIQUE,
    term_normalized TEXT NOT NULL,

    -- Statistics
    search_count INTEGER NOT NULL DEFAULT 1,
    click_through_rate DOUBLE PRECISION DEFAULT 0,

    -- Status
    enabled BOOLEAN NOT NULL DEFAULT true,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_search_history_user ON public.search_history(user_id, searched_at DESC);
CREATE INDEX idx_search_history_query ON public.search_history(query_normalized, searched_at DESC);
CREATE INDEX idx_search_suggestions_term ON public.search_suggestions(term_normalized) WHERE enabled = true;
CREATE INDEX idx_search_suggestions_count ON public.search_suggestions(search_count DESC) WHERE enabled = true;

ALTER TABLE public.search_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.search_suggestions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own search history" ON public.search_history FOR SELECT TO authenticated
    USING (user_id = auth.uid());
CREATE POLICY "Anyone can insert search history" ON public.search_history FOR INSERT WITH CHECK (true);

CREATE POLICY "Anyone reads suggestions" ON public.search_suggestions FOR SELECT USING (enabled = true);
CREATE POLICY "Service role manages suggestions" ON public.search_suggestions FOR ALL TO service_role USING (true);

-- Get search suggestions
CREATE OR REPLACE FUNCTION public.get_search_suggestions(
    p_query TEXT,
    p_limit INTEGER DEFAULT 10
)
RETURNS TABLE (term TEXT, score DOUBLE PRECISION) AS $$
DECLARE
    v_normalized TEXT;
BEGIN
    v_normalized := lower(trim(p_query));

    RETURN QUERY
    SELECT
        ss.term,
        (similarity(ss.term_normalized, v_normalized) * 0.5 + (ss.search_count::FLOAT / 1000) * 0.3 + ss.click_through_rate * 0.2) as score
    FROM public.search_suggestions ss
    WHERE ss.enabled = true
      AND ss.term_normalized % v_normalized
    ORDER BY score DESC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- PHASE 18: TRANSLATIONS TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.translations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Key identification
    key TEXT NOT NULL,
    namespace TEXT NOT NULL DEFAULT 'common',
    locale TEXT NOT NULL,

    -- Value
    value TEXT NOT NULL,
    plurals JSONB,  -- {"one": "item", "other": "items"}

    -- Metadata
    context TEXT,
    max_length INTEGER,

    -- Status
    verified BOOLEAN NOT NULL DEFAULT false,
    auto_translated BOOLEAN NOT NULL DEFAULT false,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(key, namespace, locale)
);

CREATE INDEX idx_translations_lookup ON public.translations(namespace, locale, key);
CREATE INDEX idx_translations_locale ON public.translations(locale);

ALTER TABLE public.translations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone reads translations" ON public.translations FOR SELECT USING (true);
CREATE POLICY "Service role manages translations" ON public.translations FOR ALL TO service_role USING (true);

-- Get translations for locale
CREATE OR REPLACE FUNCTION public.get_translations(
    p_locale TEXT,
    p_namespace TEXT DEFAULT 'common',
    p_keys TEXT[] DEFAULT NULL
)
RETURNS JSONB AS $$
BEGIN
    RETURN (
        SELECT jsonb_object_agg(key, value)
        FROM public.translations
        WHERE locale = p_locale
          AND namespace = p_namespace
          AND (p_keys IS NULL OR key = ANY(p_keys))
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- PHASE 19: ENTITY VERSIONS (for repository conflict resolution)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.entity_versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,

    version INTEGER NOT NULL DEFAULT 1,
    checksum TEXT NOT NULL,

    -- Conflict resolution
    last_modified_by UUID REFERENCES auth.users(id),
    last_modified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_sync_at TIMESTAMPTZ,

    UNIQUE(entity_type, entity_id)
);

CREATE INDEX idx_entity_versions_lookup ON public.entity_versions(entity_type, entity_id);

ALTER TABLE public.entity_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role manages versions" ON public.entity_versions FOR ALL TO service_role USING (true);
CREATE POLICY "Anyone reads versions" ON public.entity_versions FOR SELECT USING (true);

-- Get or create entity version
CREATE OR REPLACE FUNCTION public.get_entity_version(
    p_entity_type TEXT,
    p_entity_id TEXT
)
RETURNS public.entity_versions AS $$
DECLARE
    v_version public.entity_versions;
BEGIN
    SELECT * INTO v_version
    FROM public.entity_versions
    WHERE entity_type = p_entity_type AND entity_id = p_entity_id;

    IF v_version.id IS NULL THEN
        INSERT INTO public.entity_versions (entity_type, entity_id, checksum)
        VALUES (p_entity_type, p_entity_id, md5(p_entity_id))
        RETURNING * INTO v_version;
    END IF;

    RETURN v_version;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Increment version (for optimistic locking)
CREATE OR REPLACE FUNCTION public.increment_entity_version(
    p_entity_type TEXT,
    p_entity_id TEXT,
    p_expected_version INTEGER,
    p_new_checksum TEXT
)
RETURNS TABLE (success BOOLEAN, new_version INTEGER) AS $$
DECLARE
    v_updated BOOLEAN;
    v_new_version INTEGER;
BEGIN
    UPDATE public.entity_versions
    SET version = version + 1,
        checksum = p_new_checksum,
        last_modified_by = auth.uid(),
        last_modified_at = NOW()
    WHERE entity_type = p_entity_type
      AND entity_id = p_entity_id
      AND version = p_expected_version
    RETURNING version INTO v_new_version;

    v_updated := FOUND;

    IF NOT v_updated THEN
        SELECT version INTO v_new_version
        FROM public.entity_versions
        WHERE entity_type = p_entity_type AND entity_id = p_entity_id;
    END IF;

    RETURN QUERY SELECT v_updated, COALESCE(v_new_version, 0);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- PHASE 20: BFF API VERSIONING
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.api_versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    version TEXT NOT NULL UNIQUE,
    min_app_version_ios TEXT,
    min_app_version_android TEXT,

    -- Status
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated', 'sunset')),
    sunset_date DATE,

    -- Feature flags for this version
    features JSONB DEFAULT '{}'::jsonb,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insert default versions
INSERT INTO public.api_versions (version, status, features) VALUES
    ('v1', 'active', '{"bff": true, "realtime": true}'::jsonb),
    ('v2', 'active', '{"bff": true, "realtime": true, "graphql": false}'::jsonb)
ON CONFLICT (version) DO NOTHING;

ALTER TABLE public.api_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone reads api versions" ON public.api_versions FOR SELECT USING (true);

-- Get appropriate API version for client
CREATE OR REPLACE FUNCTION public.get_api_version(
    p_platform TEXT,
    p_app_version TEXT
)
RETURNS public.api_versions AS $$
BEGIN
    RETURN QUERY
    SELECT *
    FROM public.api_versions
    WHERE status = 'active'
      AND (
          (p_platform = 'ios' AND (min_app_version_ios IS NULL OR p_app_version >= min_app_version_ios))
          OR
          (p_platform = 'android' AND (min_app_version_android IS NULL OR p_app_version >= min_app_version_android))
          OR
          p_platform NOT IN ('ios', 'android')
      )
    ORDER BY version DESC
    LIMIT 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- COMMENTS
-- =============================================================================

COMMENT ON MATERIALIZED VIEW public.rating_aggregates IS 'Pre-computed rating statistics per user';
COMMENT ON TABLE public.search_history IS 'User search history for personalization';
COMMENT ON TABLE public.search_suggestions IS 'Popular search terms for autocomplete';
COMMENT ON TABLE public.translations IS 'Localized strings for all platforms';
COMMENT ON TABLE public.entity_versions IS 'Optimistic locking versions for repository sync';
COMMENT ON TABLE public.api_versions IS 'BFF API version configuration';
