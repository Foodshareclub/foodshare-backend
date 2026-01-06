-- =============================================================================
-- Phase 2: Analytics Events Infrastructure
-- =============================================================================
-- Unified analytics event storage for Web, iOS, and Android
-- Supports batch ingestion, session tracking, and event aggregation
-- =============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================================
-- ANALYTICS EVENTS TABLE (Partitioned by Month)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.analytics_events (
    id UUID NOT NULL DEFAULT uuid_generate_v4(),

    -- Event identification
    event_name TEXT NOT NULL,
    category TEXT NOT NULL,

    -- Context
    session_id TEXT,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    device_id TEXT NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
    app_version TEXT NOT NULL,

    -- Event properties (flexible JSONB)
    properties JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Timestamps
    event_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Partitioning key
    created_month DATE NOT NULL DEFAULT date_trunc('month', NOW())::date,

    PRIMARY KEY (id, created_month)
) PARTITION BY RANGE (created_month);

-- Create partitions for current and future months
CREATE TABLE IF NOT EXISTS public.analytics_events_2026_01
    PARTITION OF public.analytics_events
    FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');

CREATE TABLE IF NOT EXISTS public.analytics_events_2026_02
    PARTITION OF public.analytics_events
    FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');

CREATE TABLE IF NOT EXISTS public.analytics_events_2026_03
    PARTITION OF public.analytics_events
    FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');

-- =============================================================================
-- INDEXES
-- =============================================================================

-- Query by user
CREATE INDEX idx_analytics_events_user_id
ON public.analytics_events(user_id, event_timestamp DESC);

-- Query by session
CREATE INDEX idx_analytics_events_session
ON public.analytics_events(session_id, event_timestamp);

-- Query by event name
CREATE INDEX idx_analytics_events_name
ON public.analytics_events(event_name, event_timestamp DESC);

-- Query by category
CREATE INDEX idx_analytics_events_category
ON public.analytics_events(category, event_timestamp DESC);

-- Query by platform
CREATE INDEX idx_analytics_events_platform
ON public.analytics_events(platform, event_timestamp DESC);

-- Query by device
CREATE INDEX idx_analytics_events_device
ON public.analytics_events(device_id, event_timestamp DESC);

-- GIN index for property queries
CREATE INDEX idx_analytics_events_properties
ON public.analytics_events USING GIN (properties);

-- =============================================================================
-- SESSIONS TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.analytics_sessions (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    platform TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
    app_version TEXT NOT NULL,

    -- Session timing
    started_at TIMESTAMPTZ NOT NULL,
    last_activity_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,

    -- Session metadata
    session_number INTEGER NOT NULL DEFAULT 1,
    entry_screen TEXT,
    exit_screen TEXT,

    -- Metrics
    event_count INTEGER NOT NULL DEFAULT 0,
    screen_view_count INTEGER NOT NULL DEFAULT 0,
    duration_seconds DOUBLE PRECISION GENERATED ALWAYS AS (
        EXTRACT(EPOCH FROM (COALESCE(ended_at, last_activity_at) - started_at))
    ) STORED,

    -- Properties
    properties JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Session indexes
CREATE INDEX idx_analytics_sessions_user
ON public.analytics_sessions(user_id, started_at DESC);

CREATE INDEX idx_analytics_sessions_device
ON public.analytics_sessions(device_id, started_at DESC);

CREATE INDEX idx_analytics_sessions_active
ON public.analytics_sessions(ended_at) WHERE ended_at IS NULL;

-- =============================================================================
-- EVENT BATCHES TABLE (for processing tracking)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.analytics_batches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Batch metadata
    event_count INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    platform TEXT NOT NULL,

    -- Processing status
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    error_message TEXT,

    -- Timing
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,

    -- Raw payload (for debugging/replay)
    payload JSONB NOT NULL
);

-- Batch indexes
CREATE INDEX idx_analytics_batches_status
ON public.analytics_batches(status, received_at);

-- =============================================================================
-- RLS POLICIES
-- =============================================================================

ALTER TABLE public.analytics_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analytics_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analytics_batches ENABLE ROW LEVEL SECURITY;

-- Events can be inserted by anyone (SDK), read by service role only
CREATE POLICY "Events can be inserted"
ON public.analytics_events FOR INSERT
WITH CHECK (true);

CREATE POLICY "Service role reads events"
ON public.analytics_events FOR SELECT
TO service_role
USING (true);

-- Sessions
CREATE POLICY "Sessions can be inserted"
ON public.analytics_sessions FOR INSERT
WITH CHECK (true);

CREATE POLICY "Sessions can be updated by owner"
ON public.analytics_sessions FOR UPDATE
USING (device_id = current_setting('request.headers', true)::json->>'x-device-id');

CREATE POLICY "Service role manages sessions"
ON public.analytics_sessions FOR ALL
TO service_role
USING (true);

-- Batches (service role only)
CREATE POLICY "Service role manages batches"
ON public.analytics_batches FOR ALL
TO service_role
USING (true);

-- =============================================================================
-- AGGREGATE TABLES
-- =============================================================================

-- Daily event aggregates
CREATE TABLE IF NOT EXISTS public.analytics_daily_aggregates (
    date DATE NOT NULL,
    platform TEXT NOT NULL,
    event_name TEXT NOT NULL,

    -- Counts
    event_count BIGINT NOT NULL DEFAULT 0,
    unique_users BIGINT NOT NULL DEFAULT 0,
    unique_devices BIGINT NOT NULL DEFAULT 0,
    unique_sessions BIGINT NOT NULL DEFAULT 0,

    -- Computed at
    computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (date, platform, event_name)
);

-- Session aggregates
CREATE TABLE IF NOT EXISTS public.analytics_session_aggregates (
    date DATE NOT NULL,
    platform TEXT NOT NULL,

    -- Session metrics
    total_sessions BIGINT NOT NULL DEFAULT 0,
    avg_duration_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
    avg_events_per_session DOUBLE PRECISION NOT NULL DEFAULT 0,
    avg_screens_per_session DOUBLE PRECISION NOT NULL DEFAULT 0,
    bounce_rate DOUBLE PRECISION NOT NULL DEFAULT 0,

    -- Computed at
    computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (date, platform)
);

-- =============================================================================
-- RPC FUNCTIONS
-- =============================================================================

-- Ingest a batch of events
CREATE OR REPLACE FUNCTION public.ingest_analytics_batch(
    p_events JSONB,
    p_device_id TEXT,
    p_platform TEXT
)
RETURNS TABLE (
    batch_id UUID,
    events_processed INTEGER,
    success BOOLEAN
) AS $$
DECLARE
    v_batch_id UUID;
    v_event JSONB;
    v_event_count INTEGER := 0;
BEGIN
    -- Create batch record
    INSERT INTO public.analytics_batches (
        event_count,
        device_id,
        platform,
        status,
        payload
    ) VALUES (
        jsonb_array_length(p_events),
        p_device_id,
        p_platform,
        'processing',
        p_events
    )
    RETURNING id INTO v_batch_id;

    -- Process each event
    FOR v_event IN SELECT * FROM jsonb_array_elements(p_events)
    LOOP
        INSERT INTO public.analytics_events (
            event_name,
            category,
            session_id,
            user_id,
            device_id,
            platform,
            app_version,
            properties,
            event_timestamp
        ) VALUES (
            v_event->>'name',
            v_event->>'category',
            v_event->>'sessionId',
            NULLIF(v_event->>'userId', '')::UUID,
            COALESCE(v_event->>'deviceId', p_device_id),
            COALESCE(v_event->>'platform', p_platform),
            v_event->>'appVersion',
            COALESCE(v_event->'properties', '{}'::jsonb),
            COALESCE((v_event->>'timestamp')::timestamptz, NOW())
        );

        v_event_count := v_event_count + 1;
    END LOOP;

    -- Update batch status
    UPDATE public.analytics_batches
    SET status = 'completed',
        processed_at = NOW()
    WHERE id = v_batch_id;

    RETURN QUERY SELECT v_batch_id, v_event_count, true;

EXCEPTION WHEN OTHERS THEN
    -- Update batch with error
    UPDATE public.analytics_batches
    SET status = 'failed',
        error_message = SQLERRM,
        processed_at = NOW()
    WHERE id = v_batch_id;

    RETURN QUERY SELECT v_batch_id, 0, false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Upsert session
CREATE OR REPLACE FUNCTION public.upsert_analytics_session(
    p_session_id TEXT,
    p_device_id TEXT,
    p_user_id UUID,
    p_platform TEXT,
    p_app_version TEXT,
    p_started_at TIMESTAMPTZ,
    p_last_activity_at TIMESTAMPTZ,
    p_ended_at TIMESTAMPTZ DEFAULT NULL,
    p_session_number INTEGER DEFAULT 1,
    p_entry_screen TEXT DEFAULT NULL,
    p_exit_screen TEXT DEFAULT NULL,
    p_event_count INTEGER DEFAULT 0,
    p_screen_view_count INTEGER DEFAULT 0,
    p_properties JSONB DEFAULT '{}'::jsonb
)
RETURNS public.analytics_sessions AS $$
DECLARE
    v_session public.analytics_sessions;
BEGIN
    INSERT INTO public.analytics_sessions (
        id,
        device_id,
        user_id,
        platform,
        app_version,
        started_at,
        last_activity_at,
        ended_at,
        session_number,
        entry_screen,
        exit_screen,
        event_count,
        screen_view_count,
        properties
    ) VALUES (
        p_session_id,
        p_device_id,
        p_user_id,
        p_platform,
        p_app_version,
        p_started_at,
        p_last_activity_at,
        p_ended_at,
        p_session_number,
        p_entry_screen,
        p_exit_screen,
        p_event_count,
        p_screen_view_count,
        p_properties
    )
    ON CONFLICT (id) DO UPDATE SET
        last_activity_at = EXCLUDED.last_activity_at,
        ended_at = EXCLUDED.ended_at,
        exit_screen = COALESCE(EXCLUDED.exit_screen, analytics_sessions.exit_screen),
        event_count = analytics_sessions.event_count + EXCLUDED.event_count,
        screen_view_count = analytics_sessions.screen_view_count + EXCLUDED.screen_view_count,
        properties = analytics_sessions.properties || EXCLUDED.properties
    RETURNING * INTO v_session;

    RETURN v_session;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get event counts by category
CREATE OR REPLACE FUNCTION public.get_analytics_summary(
    p_start_date DATE,
    p_end_date DATE,
    p_platform TEXT DEFAULT NULL
)
RETURNS TABLE (
    category TEXT,
    event_name TEXT,
    event_count BIGINT,
    unique_users BIGINT,
    unique_sessions BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        ae.category,
        ae.event_name,
        COUNT(*)::BIGINT as event_count,
        COUNT(DISTINCT ae.user_id)::BIGINT as unique_users,
        COUNT(DISTINCT ae.session_id)::BIGINT as unique_sessions
    FROM public.analytics_events ae
    WHERE ae.event_timestamp >= p_start_date
      AND ae.event_timestamp < p_end_date + INTERVAL '1 day'
      AND (p_platform IS NULL OR ae.platform = p_platform)
    GROUP BY ae.category, ae.event_name
    ORDER BY event_count DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Compute daily aggregates
CREATE OR REPLACE FUNCTION public.compute_analytics_aggregates(p_date DATE)
RETURNS VOID AS $$
BEGIN
    -- Daily event aggregates
    INSERT INTO public.analytics_daily_aggregates (
        date,
        platform,
        event_name,
        event_count,
        unique_users,
        unique_devices,
        unique_sessions
    )
    SELECT
        p_date,
        platform,
        event_name,
        COUNT(*),
        COUNT(DISTINCT user_id),
        COUNT(DISTINCT device_id),
        COUNT(DISTINCT session_id)
    FROM public.analytics_events
    WHERE event_timestamp >= p_date
      AND event_timestamp < p_date + INTERVAL '1 day'
    GROUP BY platform, event_name
    ON CONFLICT (date, platform, event_name) DO UPDATE SET
        event_count = EXCLUDED.event_count,
        unique_users = EXCLUDED.unique_users,
        unique_devices = EXCLUDED.unique_devices,
        unique_sessions = EXCLUDED.unique_sessions,
        computed_at = NOW();

    -- Session aggregates
    INSERT INTO public.analytics_session_aggregates (
        date,
        platform,
        total_sessions,
        avg_duration_seconds,
        avg_events_per_session,
        avg_screens_per_session,
        bounce_rate
    )
    SELECT
        p_date,
        platform,
        COUNT(*),
        COALESCE(AVG(duration_seconds), 0),
        COALESCE(AVG(event_count), 0),
        COALESCE(AVG(screen_view_count), 0),
        COALESCE(
            COUNT(*) FILTER (WHERE screen_view_count <= 1)::FLOAT / NULLIF(COUNT(*), 0),
            0
        )
    FROM public.analytics_sessions
    WHERE started_at >= p_date
      AND started_at < p_date + INTERVAL '1 day'
    GROUP BY platform
    ON CONFLICT (date, platform) DO UPDATE SET
        total_sessions = EXCLUDED.total_sessions,
        avg_duration_seconds = EXCLUDED.avg_duration_seconds,
        avg_events_per_session = EXCLUDED.avg_events_per_session,
        avg_screens_per_session = EXCLUDED.avg_screens_per_session,
        bounce_rate = EXCLUDED.bounce_rate,
        computed_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- PARTITION MANAGEMENT FUNCTION
-- =============================================================================

CREATE OR REPLACE FUNCTION public.create_analytics_partition(p_month DATE)
RETURNS VOID AS $$
DECLARE
    v_partition_name TEXT;
    v_start_date DATE;
    v_end_date DATE;
BEGIN
    v_start_date := date_trunc('month', p_month)::date;
    v_end_date := (v_start_date + INTERVAL '1 month')::date;
    v_partition_name := 'analytics_events_' || to_char(v_start_date, 'YYYY_MM');

    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.analytics_events FOR VALUES FROM (%L) TO (%L)',
        v_partition_name,
        v_start_date,
        v_end_date
    );
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- COMMENTS
-- =============================================================================

COMMENT ON TABLE public.analytics_events IS
'Partitioned table storing analytics events from all platforms (iOS, Android, Web)';

COMMENT ON TABLE public.analytics_sessions IS
'User sessions with aggregated metrics for engagement analysis';

COMMENT ON TABLE public.analytics_batches IS
'Tracking table for event batch ingestion processing';

COMMENT ON FUNCTION public.ingest_analytics_batch IS
'Atomically ingest a batch of analytics events from mobile or web clients';

COMMENT ON FUNCTION public.compute_analytics_aggregates IS
'Compute daily aggregates for analytics dashboards - run via cron job';
