-- =============================================================================
-- Phase 3: Cache Invalidation Infrastructure
-- =============================================================================
-- Unified cache invalidation events for Web, iOS, and Android
-- Supports cascade invalidation, broadcast notifications, and audit logging
-- =============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================================
-- CACHE INVALIDATION EVENTS TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.cache_invalidation_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Event identification
    event_type TEXT NOT NULL CHECK (event_type IN (
        'create', 'update', 'delete', 'expire', 'refresh',
        'bulk_update', 'relation_change', 'user_action'
    )),
    entity_type TEXT NOT NULL CHECK (entity_type IN (
        'listing', 'user', 'profile', 'chat_room', 'message',
        'notification', 'review', 'favorite', 'challenge',
        'forum_post', 'forum_comment', 'category', 'search',
        'feed', 'dashboard'
    )),
    entity_id TEXT,

    -- Cascade configuration
    cascade_invalidation BOOLEAN NOT NULL DEFAULT true,
    max_depth INTEGER NOT NULL DEFAULT 3,

    -- Affected keys
    affected_keys TEXT[] NOT NULL DEFAULT '{}',
    invalidated_patterns TEXT[] NOT NULL DEFAULT '{}',

    -- Source information
    source_platform TEXT CHECK (source_platform IN ('ios', 'android', 'web', 'server')),
    source_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    source_request_id TEXT,

    -- Processing status
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending', 'broadcasting', 'completed', 'failed'
    )),
    broadcast_count INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,

    -- Metadata
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '1 hour'
);

-- =============================================================================
-- INDEXES
-- =============================================================================

-- Query recent events
CREATE INDEX idx_cache_events_created_at
ON public.cache_invalidation_events(created_at DESC);

-- Query by entity
CREATE INDEX idx_cache_events_entity
ON public.cache_invalidation_events(entity_type, entity_id);

-- Query pending events
CREATE INDEX idx_cache_events_pending
ON public.cache_invalidation_events(status, created_at)
WHERE status = 'pending';

-- Query by user
CREATE INDEX idx_cache_events_user
ON public.cache_invalidation_events(source_user_id, created_at DESC)
WHERE source_user_id IS NOT NULL;

-- Cleanup expired events
CREATE INDEX idx_cache_events_expires
ON public.cache_invalidation_events(expires_at)
WHERE expires_at IS NOT NULL;

-- =============================================================================
-- CACHE SUBSCRIPTIONS TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.cache_subscriptions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Subscriber information
    device_id TEXT NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,

    -- Subscription patterns
    patterns TEXT[] NOT NULL,
    entity_types TEXT[] NOT NULL DEFAULT '{}',

    -- Connection details
    push_token TEXT,
    websocket_channel TEXT,

    -- Status
    active BOOLEAN NOT NULL DEFAULT true,
    last_ping_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Unique subscription per device
    UNIQUE(device_id, platform)
);

-- Indexes
CREATE INDEX idx_cache_subs_active
ON public.cache_subscriptions(active, last_ping_at DESC)
WHERE active = true;

CREATE INDEX idx_cache_subs_patterns
ON public.cache_subscriptions USING GIN (patterns);

CREATE INDEX idx_cache_subs_user
ON public.cache_subscriptions(user_id)
WHERE user_id IS NOT NULL;

-- =============================================================================
-- RLS POLICIES
-- =============================================================================

ALTER TABLE public.cache_invalidation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cache_subscriptions ENABLE ROW LEVEL SECURITY;

-- Events can be created by anyone, read by service role
CREATE POLICY "Service role manages cache events"
ON public.cache_invalidation_events FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

CREATE POLICY "Authenticated can create cache events"
ON public.cache_invalidation_events FOR INSERT
TO authenticated
WITH CHECK (true);

-- Subscriptions
CREATE POLICY "Users manage own subscriptions"
ON public.cache_subscriptions FOR ALL
TO authenticated
USING (user_id = auth.uid() OR user_id IS NULL)
WITH CHECK (user_id = auth.uid() OR user_id IS NULL);

CREATE POLICY "Service role manages all subscriptions"
ON public.cache_subscriptions FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- =============================================================================
-- RPC FUNCTIONS
-- =============================================================================

-- Create invalidation event and get patterns to broadcast
CREATE OR REPLACE FUNCTION public.create_cache_invalidation_event(
    p_event_type TEXT,
    p_entity_type TEXT,
    p_entity_id TEXT DEFAULT NULL,
    p_cascade_invalidation BOOLEAN DEFAULT true,
    p_affected_keys TEXT[] DEFAULT '{}',
    p_source_platform TEXT DEFAULT NULL,
    p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
    event_id UUID,
    patterns TEXT[],
    subscriber_count INTEGER
) AS $$
DECLARE
    v_event_id UUID;
    v_patterns TEXT[];
    v_sub_count INTEGER;
BEGIN
    -- Generate invalidation patterns
    v_patterns := ARRAY[
        'fs:v1:' || p_entity_type || ':*'
    ];

    IF p_entity_id IS NOT NULL THEN
        v_patterns := v_patterns || ARRAY[
            'fs:v1:' || p_entity_type || ':' || p_entity_id,
            'fs:v1:' || p_entity_type || ':' || p_entity_id || ':*'
        ];
    END IF;

    -- Add cascade patterns based on entity type
    IF p_cascade_invalidation THEN
        v_patterns := v_patterns || get_cascade_patterns(p_entity_type);
    END IF;

    -- Add explicitly affected keys
    v_patterns := v_patterns || p_affected_keys;

    -- Deduplicate
    v_patterns := ARRAY(SELECT DISTINCT unnest(v_patterns));

    -- Create event
    INSERT INTO public.cache_invalidation_events (
        event_type,
        entity_type,
        entity_id,
        cascade_invalidation,
        affected_keys,
        invalidated_patterns,
        source_platform,
        source_user_id,
        metadata
    ) VALUES (
        p_event_type,
        p_entity_type,
        p_entity_id,
        p_cascade_invalidation,
        p_affected_keys,
        v_patterns,
        p_source_platform,
        auth.uid(),
        p_metadata
    )
    RETURNING id INTO v_event_id;

    -- Count matching subscribers
    SELECT COUNT(DISTINCT device_id) INTO v_sub_count
    FROM public.cache_subscriptions
    WHERE active = true
      AND (patterns && v_patterns OR entity_types @> ARRAY[p_entity_type]);

    RETURN QUERY SELECT v_event_id, v_patterns, v_sub_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Helper function to get cascade patterns based on entity relationships
CREATE OR REPLACE FUNCTION get_cascade_patterns(p_entity_type TEXT)
RETURNS TEXT[] AS $$
DECLARE
    v_patterns TEXT[] := '{}';
BEGIN
    CASE p_entity_type
        WHEN 'listing' THEN
            v_patterns := ARRAY[
                'fs:v1:feed:*',
                'fs:v1:search:*',
                'fs:v1:profile:*'
            ];
        WHEN 'user', 'profile' THEN
            v_patterns := ARRAY[
                'fs:v1:listing:*',
                'fs:v1:review:*',
                'fs:v1:dashboard:*'
            ];
        WHEN 'review' THEN
            v_patterns := ARRAY[
                'fs:v1:profile:*',
                'fs:v1:listing:*'
            ];
        WHEN 'message' THEN
            v_patterns := ARRAY[
                'fs:v1:chat_room:*',
                'fs:v1:dashboard:*'
            ];
        WHEN 'favorite' THEN
            v_patterns := ARRAY[
                'fs:v1:listing:*',
                'fs:v1:profile:*'
            ];
        WHEN 'forum_comment' THEN
            v_patterns := ARRAY[
                'fs:v1:forum_post:*'
            ];
        WHEN 'notification' THEN
            v_patterns := ARRAY[
                'fs:v1:dashboard:*'
            ];
        ELSE
            v_patterns := '{}';
    END CASE;

    RETURN v_patterns;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Subscribe to cache invalidation events
CREATE OR REPLACE FUNCTION public.subscribe_cache_invalidation(
    p_device_id TEXT,
    p_platform TEXT,
    p_patterns TEXT[],
    p_entity_types TEXT[] DEFAULT '{}',
    p_push_token TEXT DEFAULT NULL,
    p_websocket_channel TEXT DEFAULT NULL
)
RETURNS public.cache_subscriptions AS $$
DECLARE
    v_subscription public.cache_subscriptions;
BEGIN
    INSERT INTO public.cache_subscriptions (
        device_id,
        platform,
        user_id,
        patterns,
        entity_types,
        push_token,
        websocket_channel,
        last_ping_at
    ) VALUES (
        p_device_id,
        p_platform,
        auth.uid(),
        p_patterns,
        p_entity_types,
        p_push_token,
        p_websocket_channel,
        NOW()
    )
    ON CONFLICT (device_id, platform) DO UPDATE SET
        user_id = COALESCE(auth.uid(), cache_subscriptions.user_id),
        patterns = p_patterns,
        entity_types = p_entity_types,
        push_token = COALESCE(p_push_token, cache_subscriptions.push_token),
        websocket_channel = COALESCE(p_websocket_channel, cache_subscriptions.websocket_channel),
        active = true,
        last_ping_at = NOW(),
        updated_at = NOW()
    RETURNING * INTO v_subscription;

    RETURN v_subscription;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Unsubscribe from cache invalidation
CREATE OR REPLACE FUNCTION public.unsubscribe_cache_invalidation(
    p_device_id TEXT,
    p_platform TEXT
)
RETURNS VOID AS $$
BEGIN
    UPDATE public.cache_subscriptions
    SET active = false, updated_at = NOW()
    WHERE device_id = p_device_id AND platform = p_platform;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get recent invalidation events for a subscriber
CREATE OR REPLACE FUNCTION public.get_cache_invalidation_events(
    p_device_id TEXT,
    p_platform TEXT,
    p_since TIMESTAMPTZ DEFAULT NOW() - INTERVAL '5 minutes',
    p_limit INTEGER DEFAULT 100
)
RETURNS TABLE (
    event_id UUID,
    event_type TEXT,
    entity_type TEXT,
    entity_id TEXT,
    patterns TEXT[],
    created_at TIMESTAMPTZ
) AS $$
DECLARE
    v_subscription public.cache_subscriptions;
BEGIN
    -- Get subscription
    SELECT * INTO v_subscription
    FROM public.cache_subscriptions
    WHERE device_id = p_device_id AND platform = p_platform AND active = true;

    IF v_subscription.id IS NULL THEN
        RETURN;
    END IF;

    -- Update last ping
    UPDATE public.cache_subscriptions
    SET last_ping_at = NOW()
    WHERE id = v_subscription.id;

    -- Return matching events
    RETURN QUERY
    SELECT
        e.id as event_id,
        e.event_type,
        e.entity_type,
        e.entity_id,
        e.invalidated_patterns as patterns,
        e.created_at
    FROM public.cache_invalidation_events e
    WHERE e.created_at > p_since
      AND e.status = 'completed'
      AND (
          e.invalidated_patterns && v_subscription.patterns
          OR e.entity_type = ANY(v_subscription.entity_types)
      )
    ORDER BY e.created_at DESC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- TRIGGERS FOR AUTO-INVALIDATION
-- =============================================================================

-- Generic trigger function for entity changes
CREATE OR REPLACE FUNCTION public.trigger_cache_invalidation()
RETURNS TRIGGER AS $$
DECLARE
    v_entity_type TEXT;
    v_entity_id TEXT;
    v_event_type TEXT;
BEGIN
    -- Determine entity type from table name
    v_entity_type := CASE TG_TABLE_NAME
        WHEN 'posts' THEN 'listing'
        WHEN 'profiles' THEN 'profile'
        WHEN 'reviews' THEN 'review'
        WHEN 'chat_messages' THEN 'message'
        WHEN 'chat_rooms' THEN 'chat_room'
        WHEN 'notifications' THEN 'notification'
        WHEN 'favorites' THEN 'favorite'
        WHEN 'challenges' THEN 'challenge'
        WHEN 'forum_posts' THEN 'forum_post'
        WHEN 'forum_comments' THEN 'forum_comment'
        ELSE TG_TABLE_NAME
    END;

    -- Determine event type
    v_event_type := CASE TG_OP
        WHEN 'INSERT' THEN 'create'
        WHEN 'UPDATE' THEN 'update'
        WHEN 'DELETE' THEN 'delete'
        ELSE 'update'
    END;

    -- Get entity ID
    IF TG_OP = 'DELETE' THEN
        v_entity_id := OLD.id::TEXT;
    ELSE
        v_entity_id := NEW.id::TEXT;
    END IF;

    -- Create invalidation event
    PERFORM public.create_cache_invalidation_event(
        v_event_type,
        v_entity_type,
        v_entity_id,
        true,
        '{}',
        'server',
        jsonb_build_object('trigger', TG_NAME, 'table', TG_TABLE_NAME)
    );

    -- Mark event as completed (auto-processed)
    UPDATE public.cache_invalidation_events
    SET status = 'completed', processed_at = NOW()
    WHERE id = (
        SELECT id FROM public.cache_invalidation_events
        WHERE entity_type = v_entity_type AND entity_id = v_entity_id
        ORDER BY created_at DESC LIMIT 1
    );

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Apply triggers to main tables
CREATE TRIGGER trigger_posts_cache_invalidation
AFTER INSERT OR UPDATE OR DELETE ON public.posts
FOR EACH ROW EXECUTE FUNCTION public.trigger_cache_invalidation();

CREATE TRIGGER trigger_profiles_cache_invalidation
AFTER INSERT OR UPDATE OR DELETE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.trigger_cache_invalidation();

CREATE TRIGGER trigger_reviews_cache_invalidation
AFTER INSERT OR UPDATE OR DELETE ON public.reviews
FOR EACH ROW EXECUTE FUNCTION public.trigger_cache_invalidation();

CREATE TRIGGER trigger_chat_messages_cache_invalidation
AFTER INSERT OR UPDATE OR DELETE ON public.chat_messages
FOR EACH ROW EXECUTE FUNCTION public.trigger_cache_invalidation();

CREATE TRIGGER trigger_favorites_cache_invalidation
AFTER INSERT OR UPDATE OR DELETE ON public.favorites
FOR EACH ROW EXECUTE FUNCTION public.trigger_cache_invalidation();

-- =============================================================================
-- CLEANUP FUNCTION
-- =============================================================================

-- Clean up old events and inactive subscriptions
CREATE OR REPLACE FUNCTION public.cleanup_cache_invalidation()
RETURNS TABLE (
    events_deleted INTEGER,
    subscriptions_deactivated INTEGER
) AS $$
DECLARE
    v_events_deleted INTEGER;
    v_subs_deactivated INTEGER;
BEGIN
    -- Delete expired events
    DELETE FROM public.cache_invalidation_events
    WHERE expires_at < NOW()
    RETURNING COUNT(*) INTO v_events_deleted;

    -- Deactivate stale subscriptions (no ping in 30 minutes)
    UPDATE public.cache_subscriptions
    SET active = false, updated_at = NOW()
    WHERE active = true AND last_ping_at < NOW() - INTERVAL '30 minutes';

    GET DIAGNOSTICS v_subs_deactivated = ROW_COUNT;

    RETURN QUERY SELECT COALESCE(v_events_deleted, 0), v_subs_deactivated;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- COMMENTS
-- =============================================================================

COMMENT ON TABLE public.cache_invalidation_events IS
'Tracks cache invalidation events for cross-platform cache synchronization';

COMMENT ON TABLE public.cache_subscriptions IS
'Tracks devices subscribed to cache invalidation notifications';

COMMENT ON FUNCTION public.create_cache_invalidation_event IS
'Creates a cache invalidation event and returns patterns to broadcast';

COMMENT ON FUNCTION public.trigger_cache_invalidation IS
'Trigger function that automatically creates cache invalidation events on entity changes';

COMMENT ON FUNCTION public.cleanup_cache_invalidation IS
'Cleans up expired events and stale subscriptions - run via cron job';
