-- Search Analytics Tables
-- Tracks search queries, interactions, and provides data for improving search quality

-- ============================================================================
-- SEARCH ANALYTICS
-- Main table for tracking search queries
-- ============================================================================

CREATE TABLE IF NOT EXISTS search_analytics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    query TEXT NOT NULL,
    search_type TEXT NOT NULL DEFAULT 'all' CHECK (search_type IN ('listings', 'users', 'all')),
    filters JSONB DEFAULT '{}',
    has_location BOOLEAN DEFAULT false,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    radius_km DOUBLE PRECISION,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    result_count INTEGER DEFAULT 0,
    processing_time_ms INTEGER,
    session_id TEXT,
    device_type TEXT,
    app_version TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX idx_search_analytics_query ON search_analytics(query);
CREATE INDEX idx_search_analytics_user ON search_analytics(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_search_analytics_created ON search_analytics(created_at DESC);
CREATE INDEX idx_search_analytics_type ON search_analytics(search_type);
CREATE INDEX idx_search_analytics_query_prefix ON search_analytics(query text_pattern_ops);

-- ============================================================================
-- SEARCH INTERACTIONS
-- Tracks user interactions with search results
-- ============================================================================

CREATE TABLE IF NOT EXISTS search_interactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    search_id UUID NOT NULL REFERENCES search_analytics(id) ON DELETE CASCADE,
    action TEXT NOT NULL CHECK (action IN ('click', 'favorite', 'message', 'share', 'view', 'ignore')),
    item_id UUID,
    item_type TEXT,
    position INTEGER,
    dwell_time_ms INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_search_interactions_search ON search_interactions(search_id);
CREATE INDEX idx_search_interactions_item ON search_interactions(item_id);
CREATE INDEX idx_search_interactions_action ON search_interactions(action);

-- ============================================================================
-- SEARCH SUGGESTIONS CACHE
-- Caches popular and computed suggestions
-- ============================================================================

CREATE TABLE IF NOT EXISTS search_suggestions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prefix TEXT NOT NULL,
    suggestion TEXT NOT NULL,
    suggestion_type TEXT NOT NULL DEFAULT 'query' CHECK (suggestion_type IN ('query', 'category', 'user', 'popular')),
    score DOUBLE PRECISION DEFAULT 1.0,
    hit_count INTEGER DEFAULT 0,
    last_hit_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(prefix, suggestion)
);

-- Indexes
CREATE INDEX idx_search_suggestions_prefix ON search_suggestions(prefix text_pattern_ops);
CREATE INDEX idx_search_suggestions_type ON search_suggestions(suggestion_type);
CREATE INDEX idx_search_suggestions_score ON search_suggestions(score DESC);

-- ============================================================================
-- SEARCH QUALITY METRICS
-- Aggregated metrics for search quality monitoring
-- ============================================================================

CREATE TABLE IF NOT EXISTS search_quality_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    hour INTEGER NOT NULL DEFAULT EXTRACT(HOUR FROM NOW()),
    total_searches INTEGER DEFAULT 0,
    searches_with_results INTEGER DEFAULT 0,
    searches_with_clicks INTEGER DEFAULT 0,
    avg_result_count DOUBLE PRECISION,
    avg_processing_time_ms DOUBLE PRECISION,
    avg_click_position DOUBLE PRECISION,
    click_through_rate DOUBLE PRECISION,
    zero_result_rate DOUBLE PRECISION,
    top_queries JSONB DEFAULT '[]',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(date, hour)
);

-- Index
CREATE INDEX idx_search_quality_date ON search_quality_metrics(date DESC);

-- ============================================================================
-- LISTING VIEWS
-- Tracks listing view events for personalization
-- ============================================================================

CREATE TABLE IF NOT EXISTS listing_views (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    session_id TEXT,
    source TEXT DEFAULT 'feed',
    search_id UUID REFERENCES search_analytics(id) ON DELETE SET NULL,
    view_duration_ms INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_listing_views_listing ON listing_views(listing_id);
CREATE INDEX idx_listing_views_user ON listing_views(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_listing_views_created ON listing_views(created_at DESC);

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

ALTER TABLE search_analytics ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_quality_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_views ENABLE ROW LEVEL SECURITY;

-- Users can view their own search history
CREATE POLICY "Users can view own searches"
    ON search_analytics FOR SELECT
    USING (auth.uid() = user_id);

-- Service role full access for Edge Functions
CREATE POLICY "Service role full access to search_analytics"
    ON search_analytics FOR ALL
    USING (auth.jwt()->>'role' = 'service_role');

CREATE POLICY "Service role full access to search_interactions"
    ON search_interactions FOR ALL
    USING (auth.jwt()->>'role' = 'service_role');

CREATE POLICY "Service role full access to search_suggestions"
    ON search_suggestions FOR ALL
    USING (auth.jwt()->>'role' = 'service_role');

CREATE POLICY "Service role full access to search_quality_metrics"
    ON search_quality_metrics FOR ALL
    USING (auth.jwt()->>'role' = 'service_role');

CREATE POLICY "Service role full access to listing_views"
    ON listing_views FOR ALL
    USING (auth.jwt()->>'role' = 'service_role');

-- Public read access to suggestions
CREATE POLICY "Public read access to suggestions"
    ON search_suggestions FOR SELECT
    USING (true);

-- ============================================================================
-- FUNCTIONS
-- ============================================================================

-- Function to update suggestion scores based on usage
CREATE OR REPLACE FUNCTION update_suggestion_score(p_prefix TEXT, p_suggestion TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    INSERT INTO search_suggestions (prefix, suggestion, hit_count, last_hit_at)
    VALUES (p_prefix, p_suggestion, 1, NOW())
    ON CONFLICT (prefix, suggestion)
    DO UPDATE SET
        hit_count = search_suggestions.hit_count + 1,
        score = search_suggestions.score + 0.1,
        last_hit_at = NOW(),
        updated_at = NOW();
END;
$$;

-- Function to aggregate hourly search metrics
CREATE OR REPLACE FUNCTION aggregate_search_metrics()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_date DATE := CURRENT_DATE;
    v_hour INTEGER := EXTRACT(HOUR FROM NOW() - INTERVAL '1 hour');
    v_start TIMESTAMPTZ;
    v_end TIMESTAMPTZ;
BEGIN
    v_start := v_date + (v_hour || ' hours')::INTERVAL;
    v_end := v_start + INTERVAL '1 hour';

    INSERT INTO search_quality_metrics (
        date,
        hour,
        total_searches,
        searches_with_results,
        searches_with_clicks,
        avg_result_count,
        avg_processing_time_ms,
        avg_click_position,
        click_through_rate,
        zero_result_rate,
        top_queries
    )
    SELECT
        v_date,
        v_hour,
        COUNT(*) as total_searches,
        COUNT(*) FILTER (WHERE result_count > 0) as searches_with_results,
        COUNT(DISTINCT si.search_id) as searches_with_clicks,
        AVG(result_count) as avg_result_count,
        AVG(processing_time_ms) as avg_processing_time_ms,
        AVG(si.position) FILTER (WHERE si.action = 'click') as avg_click_position,
        CASE
            WHEN COUNT(*) > 0 THEN
                COUNT(DISTINCT si.search_id)::DOUBLE PRECISION / COUNT(*)
            ELSE 0
        END as click_through_rate,
        CASE
            WHEN COUNT(*) > 0 THEN
                COUNT(*) FILTER (WHERE result_count = 0)::DOUBLE PRECISION / COUNT(*)
            ELSE 0
        END as zero_result_rate,
        (
            SELECT jsonb_agg(jsonb_build_object('query', query, 'count', cnt))
            FROM (
                SELECT query, COUNT(*) as cnt
                FROM search_analytics
                WHERE created_at >= v_start AND created_at < v_end
                GROUP BY query
                ORDER BY cnt DESC
                LIMIT 10
            ) top
        ) as top_queries
    FROM search_analytics sa
    LEFT JOIN search_interactions si ON si.search_id = sa.id
    WHERE sa.created_at >= v_start AND sa.created_at < v_end
    ON CONFLICT (date, hour) DO UPDATE SET
        total_searches = EXCLUDED.total_searches,
        searches_with_results = EXCLUDED.searches_with_results,
        searches_with_clicks = EXCLUDED.searches_with_clicks,
        avg_result_count = EXCLUDED.avg_result_count,
        avg_processing_time_ms = EXCLUDED.avg_processing_time_ms,
        avg_click_position = EXCLUDED.avg_click_position,
        click_through_rate = EXCLUDED.click_through_rate,
        zero_result_rate = EXCLUDED.zero_result_rate,
        top_queries = EXCLUDED.top_queries;
END;
$$;

-- Function to get trending searches
CREATE OR REPLACE FUNCTION get_trending_searches(p_limit INTEGER DEFAULT 10)
RETURNS TABLE (
    query TEXT,
    search_count BIGINT,
    click_count BIGINT,
    avg_position DOUBLE PRECISION
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT
        sa.query,
        COUNT(sa.id) as search_count,
        COUNT(si.id) FILTER (WHERE si.action = 'click') as click_count,
        AVG(si.position) FILTER (WHERE si.action = 'click') as avg_position
    FROM search_analytics sa
    LEFT JOIN search_interactions si ON si.search_id = sa.id
    WHERE sa.created_at > NOW() - INTERVAL '24 hours'
      AND sa.result_count > 0
    GROUP BY sa.query
    ORDER BY search_count DESC, click_count DESC
    LIMIT p_limit;
END;
$$;

-- Function to get zero-result searches for improvement
CREATE OR REPLACE FUNCTION get_zero_result_searches(p_limit INTEGER DEFAULT 50)
RETURNS TABLE (
    query TEXT,
    search_count BIGINT,
    last_searched TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT
        sa.query,
        COUNT(*) as search_count,
        MAX(sa.created_at) as last_searched
    FROM search_analytics sa
    WHERE sa.created_at > NOW() - INTERVAL '7 days'
      AND sa.result_count = 0
    GROUP BY sa.query
    ORDER BY search_count DESC
    LIMIT p_limit;
END;
$$;

-- Function to clean up old analytics data (retention: 90 days)
CREATE OR REPLACE FUNCTION cleanup_old_search_analytics()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    -- Delete old search analytics (cascades to interactions)
    DELETE FROM search_analytics
    WHERE created_at < NOW() - INTERVAL '90 days';

    GET DIAGNOSTICS deleted_count = ROW_COUNT;

    -- Clean up old listing views
    DELETE FROM listing_views
    WHERE created_at < NOW() - INTERVAL '90 days';

    -- Decay suggestion scores
    UPDATE search_suggestions
    SET score = score * 0.95,
        updated_at = NOW()
    WHERE last_hit_at < NOW() - INTERVAL '7 days';

    -- Remove low-score suggestions
    DELETE FROM search_suggestions
    WHERE score < 0.1
      AND last_hit_at < NOW() - INTERVAL '30 days';

    RETURN deleted_count;
END;
$$;

-- Function to get user search history
CREATE OR REPLACE FUNCTION get_user_search_history(p_user_id UUID, p_limit INTEGER DEFAULT 20)
RETURNS TABLE (
    query TEXT,
    search_type TEXT,
    result_count INTEGER,
    created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT DISTINCT ON (sa.query)
        sa.query,
        sa.search_type,
        sa.result_count,
        sa.created_at
    FROM search_analytics sa
    WHERE sa.user_id = p_user_id
    ORDER BY sa.query, sa.created_at DESC
    LIMIT p_limit;
END;
$$;

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Auto-update updated_at for suggestions
CREATE OR REPLACE FUNCTION update_suggestions_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

CREATE TRIGGER search_suggestions_updated_at
    BEFORE UPDATE ON search_suggestions
    FOR EACH ROW
    EXECUTE FUNCTION update_suggestions_updated_at();

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE search_analytics IS 'Tracks all search queries for analytics and improvement';
COMMENT ON TABLE search_interactions IS 'Tracks user interactions with search results';
COMMENT ON TABLE search_suggestions IS 'Caches computed search suggestions';
COMMENT ON TABLE search_quality_metrics IS 'Hourly aggregated search quality metrics';
COMMENT ON TABLE listing_views IS 'Tracks listing view events for personalization';
