-- =============================================================================
-- Phase 11: Realtime Subscription Management Infrastructure
-- =============================================================================
-- Track subscriptions, handle message deduplication, and manage reconnection
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================================
-- REALTIME SUBSCRIPTIONS TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.realtime_subscriptions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'web')),

    -- Channel info
    channel_name TEXT NOT NULL,
    channel_type TEXT NOT NULL CHECK (channel_type IN (
        'chat', 'notifications', 'listings', 'presence', 'broadcast'
    )),
    filter_params JSONB DEFAULT '{}'::jsonb,

    -- Connection state
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
        'active', 'inactive', 'reconnecting', 'error'
    )),
    last_message_id TEXT,
    last_message_at TIMESTAMPTZ,

    -- Deduplication window
    processed_message_ids TEXT[] DEFAULT '{}',

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_ping_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(user_id, device_id, channel_name)
);

-- =============================================================================
-- MESSAGE DEDUPLICATION LOG
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.realtime_message_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    message_id TEXT NOT NULL,
    channel_name TEXT NOT NULL,
    message_type TEXT NOT NULL,

    payload_hash TEXT NOT NULL,
    payload_preview TEXT,

    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '1 hour'
);

-- =============================================================================
-- INDEXES
-- =============================================================================

CREATE INDEX idx_rt_subs_user ON public.realtime_subscriptions(user_id, status);
CREATE INDEX idx_rt_subs_channel ON public.realtime_subscriptions(channel_name, status) WHERE status = 'active';
CREATE INDEX idx_rt_subs_ping ON public.realtime_subscriptions(last_ping_at) WHERE status = 'active';

CREATE UNIQUE INDEX idx_rt_msg_dedup ON public.realtime_message_log(message_id, channel_name);
CREATE INDEX idx_rt_msg_expires ON public.realtime_message_log(expires_at);

-- =============================================================================
-- RLS POLICIES
-- =============================================================================

ALTER TABLE public.realtime_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.realtime_message_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own subscriptions" ON public.realtime_subscriptions FOR ALL TO authenticated
    USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY "Service role manages messages" ON public.realtime_message_log FOR ALL TO service_role USING (true);

-- =============================================================================
-- FUNCTIONS
-- =============================================================================

-- Subscribe to channel
CREATE OR REPLACE FUNCTION public.subscribe_realtime_channel(
    p_channel_name TEXT,
    p_channel_type TEXT,
    p_device_id TEXT,
    p_platform TEXT,
    p_filter_params JSONB DEFAULT '{}'::jsonb
)
RETURNS public.realtime_subscriptions AS $$
DECLARE
    v_sub public.realtime_subscriptions;
BEGIN
    INSERT INTO public.realtime_subscriptions (
        user_id, device_id, platform, channel_name, channel_type, filter_params
    ) VALUES (
        auth.uid(), p_device_id, p_platform, p_channel_name, p_channel_type, p_filter_params
    )
    ON CONFLICT (user_id, device_id, channel_name) DO UPDATE SET
        status = 'active',
        filter_params = p_filter_params,
        updated_at = NOW(),
        last_ping_at = NOW()
    RETURNING * INTO v_sub;
    RETURN v_sub;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Check for duplicate message
CREATE OR REPLACE FUNCTION public.check_message_duplicate(
    p_message_id TEXT,
    p_channel_name TEXT,
    p_message_type TEXT,
    p_payload_hash TEXT
)
RETURNS BOOLEAN AS $$
DECLARE
    v_exists BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM public.realtime_message_log
        WHERE message_id = p_message_id AND channel_name = p_channel_name
    ) INTO v_exists;

    IF NOT v_exists THEN
        INSERT INTO public.realtime_message_log (message_id, channel_name, message_type, payload_hash)
        VALUES (p_message_id, p_channel_name, p_message_type, p_payload_hash)
        ON CONFLICT DO NOTHING;
    END IF;

    RETURN v_exists;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get missed messages since last sync
CREATE OR REPLACE FUNCTION public.get_missed_messages(
    p_channel_name TEXT,
    p_last_message_id TEXT,
    p_device_id TEXT
)
RETURNS TABLE (message_id TEXT, received_at TIMESTAMPTZ) AS $$
DECLARE
    v_last_at TIMESTAMPTZ;
BEGIN
    SELECT received_at INTO v_last_at
    FROM public.realtime_message_log
    WHERE message_id = p_last_message_id AND channel_name = p_channel_name;

    RETURN QUERY
    SELECT ml.message_id, ml.received_at
    FROM public.realtime_message_log ml
    WHERE ml.channel_name = p_channel_name
      AND ml.received_at > COALESCE(v_last_at, NOW() - INTERVAL '5 minutes')
    ORDER BY ml.received_at;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Cleanup old messages
CREATE OR REPLACE FUNCTION public.cleanup_realtime_messages()
RETURNS INTEGER AS $$
DECLARE
    v_count INTEGER;
BEGIN
    DELETE FROM public.realtime_message_log WHERE expires_at < NOW();
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON TABLE public.realtime_subscriptions IS 'Active realtime channel subscriptions per device';
COMMENT ON TABLE public.realtime_message_log IS 'Message deduplication log for realtime channels';
