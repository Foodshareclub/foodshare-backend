-- =============================================================================
-- Phase 4: Short Links Infrastructure
-- =============================================================================
-- URL shortening and deep link tracking for Web, iOS, and Android
-- Supports link creation, resolution, analytics, and expiration
-- =============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================================
-- SHORT LINKS TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.short_links (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Short code (the unique identifier in the URL)
    code TEXT NOT NULL UNIQUE,

    -- Target deep link
    target_url TEXT NOT NULL,
    route_type TEXT NOT NULL,
    entity_id TEXT,

    -- Metadata
    title TEXT,
    description TEXT,
    image_url TEXT,

    -- Creator
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    platform TEXT CHECK (platform IN ('ios', 'android', 'web', 'server')),

    -- Configuration
    is_active BOOLEAN NOT NULL DEFAULT true,
    expires_at TIMESTAMPTZ,
    max_clicks INTEGER,

    -- Statistics
    click_count INTEGER NOT NULL DEFAULT 0,
    unique_click_count INTEGER NOT NULL DEFAULT 0,
    last_clicked_at TIMESTAMPTZ,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- LINK CLICKS TABLE (for analytics)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.link_clicks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Link reference
    link_id UUID NOT NULL REFERENCES public.short_links(id) ON DELETE CASCADE,

    -- Click context
    clicked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    platform TEXT CHECK (platform IN ('ios', 'android', 'web', 'unknown')),
    device_id TEXT,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,

    -- Request info
    ip_hash TEXT,
    user_agent TEXT,
    referrer TEXT,
    country_code TEXT,

    -- UTM tracking
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    utm_content TEXT,
    utm_term TEXT
);

-- =============================================================================
-- INDEXES
-- =============================================================================

-- Fast code lookup
CREATE UNIQUE INDEX idx_short_links_code ON public.short_links(code);

-- Active links lookup
CREATE INDEX idx_short_links_active ON public.short_links(is_active, expires_at)
WHERE is_active = true;

-- Creator lookup
CREATE INDEX idx_short_links_creator ON public.short_links(created_by, created_at DESC)
WHERE created_by IS NOT NULL;

-- Route type lookup
CREATE INDEX idx_short_links_route ON public.short_links(route_type, entity_id);

-- Click analytics
CREATE INDEX idx_link_clicks_link ON public.link_clicks(link_id, clicked_at DESC);
CREATE INDEX idx_link_clicks_time ON public.link_clicks(clicked_at DESC);
CREATE INDEX idx_link_clicks_platform ON public.link_clicks(platform, clicked_at DESC);

-- =============================================================================
-- RLS POLICIES
-- =============================================================================

ALTER TABLE public.short_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.link_clicks ENABLE ROW LEVEL SECURITY;

-- Anyone can read active links (for resolution)
CREATE POLICY "Anyone can read active links"
ON public.short_links FOR SELECT
USING (is_active = true AND (expires_at IS NULL OR expires_at > NOW()));

-- Authenticated users can create links
CREATE POLICY "Authenticated users can create links"
ON public.short_links FOR INSERT
TO authenticated
WITH CHECK (true);

-- Users can manage their own links
CREATE POLICY "Users can manage own links"
ON public.short_links FOR UPDATE
TO authenticated
USING (created_by = auth.uid())
WITH CHECK (created_by = auth.uid());

CREATE POLICY "Users can delete own links"
ON public.short_links FOR DELETE
TO authenticated
USING (created_by = auth.uid());

-- Service role has full access
CREATE POLICY "Service role manages all links"
ON public.short_links FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- Click tracking
CREATE POLICY "Service role manages clicks"
ON public.link_clicks FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

CREATE POLICY "Anyone can create clicks"
ON public.link_clicks FOR INSERT
WITH CHECK (true);

-- =============================================================================
-- FUNCTIONS
-- =============================================================================

-- Generate a unique short code
CREATE OR REPLACE FUNCTION public.generate_short_code(length INTEGER DEFAULT 6)
RETURNS TEXT AS $$
DECLARE
    chars TEXT := 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
    result TEXT := '';
    i INTEGER;
    attempts INTEGER := 0;
    max_attempts INTEGER := 10;
BEGIN
    LOOP
        result := '';
        FOR i IN 1..length LOOP
            result := result || substr(chars, floor(random() * length(chars) + 1)::INTEGER, 1);
        END LOOP;

        -- Check uniqueness
        IF NOT EXISTS (SELECT 1 FROM public.short_links WHERE code = result) THEN
            RETURN result;
        END IF;

        attempts := attempts + 1;
        IF attempts >= max_attempts THEN
            -- Try longer code
            length := length + 1;
            attempts := 0;
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Create a short link
CREATE OR REPLACE FUNCTION public.create_short_link(
    p_target_url TEXT,
    p_route_type TEXT,
    p_entity_id TEXT DEFAULT NULL,
    p_title TEXT DEFAULT NULL,
    p_description TEXT DEFAULT NULL,
    p_image_url TEXT DEFAULT NULL,
    p_custom_code TEXT DEFAULT NULL,
    p_expires_at TIMESTAMPTZ DEFAULT NULL,
    p_max_clicks INTEGER DEFAULT NULL,
    p_platform TEXT DEFAULT 'web'
)
RETURNS TABLE (
    link_id UUID,
    code TEXT,
    short_url TEXT
) AS $$
DECLARE
    v_code TEXT;
    v_link_id UUID;
BEGIN
    -- Generate or use custom code
    IF p_custom_code IS NOT NULL THEN
        -- Check if custom code is available
        IF EXISTS (SELECT 1 FROM public.short_links WHERE code = p_custom_code) THEN
            RAISE EXCEPTION 'Custom code already in use';
        END IF;
        v_code := p_custom_code;
    ELSE
        v_code := public.generate_short_code();
    END IF;

    -- Insert the link
    INSERT INTO public.short_links (
        code,
        target_url,
        route_type,
        entity_id,
        title,
        description,
        image_url,
        created_by,
        platform,
        expires_at,
        max_clicks
    ) VALUES (
        v_code,
        p_target_url,
        p_route_type,
        p_entity_id,
        p_title,
        p_description,
        p_image_url,
        auth.uid(),
        p_platform,
        p_expires_at,
        p_max_clicks
    )
    RETURNING id INTO v_link_id;

    RETURN QUERY SELECT
        v_link_id,
        v_code,
        'https://foodshare.app/l/' || v_code;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Resolve a short link
CREATE OR REPLACE FUNCTION public.resolve_short_link(
    p_code TEXT,
    p_platform TEXT DEFAULT 'web',
    p_device_id TEXT DEFAULT NULL,
    p_user_agent TEXT DEFAULT NULL,
    p_referrer TEXT DEFAULT NULL,
    p_ip_hash TEXT DEFAULT NULL,
    p_utm_source TEXT DEFAULT NULL,
    p_utm_medium TEXT DEFAULT NULL,
    p_utm_campaign TEXT DEFAULT NULL
)
RETURNS TABLE (
    target_url TEXT,
    route_type TEXT,
    entity_id TEXT,
    title TEXT,
    description TEXT,
    image_url TEXT
) AS $$
DECLARE
    v_link public.short_links;
    v_is_new_visitor BOOLEAN;
BEGIN
    -- Get the link
    SELECT * INTO v_link
    FROM public.short_links
    WHERE code = p_code
      AND is_active = true
      AND (expires_at IS NULL OR expires_at > NOW())
      AND (max_clicks IS NULL OR click_count < max_clicks);

    IF v_link.id IS NULL THEN
        RETURN;
    END IF;

    -- Check if this is a unique visitor
    v_is_new_visitor := NOT EXISTS (
        SELECT 1 FROM public.link_clicks
        WHERE link_id = v_link.id
          AND (device_id = p_device_id OR (device_id IS NULL AND p_device_id IS NULL))
          AND clicked_at > NOW() - INTERVAL '24 hours'
    );

    -- Record click
    INSERT INTO public.link_clicks (
        link_id,
        platform,
        device_id,
        user_id,
        ip_hash,
        user_agent,
        referrer,
        utm_source,
        utm_medium,
        utm_campaign
    ) VALUES (
        v_link.id,
        COALESCE(p_platform, 'unknown'),
        p_device_id,
        auth.uid(),
        p_ip_hash,
        p_user_agent,
        p_referrer,
        p_utm_source,
        p_utm_medium,
        p_utm_campaign
    );

    -- Update click count
    UPDATE public.short_links
    SET click_count = click_count + 1,
        unique_click_count = CASE WHEN v_is_new_visitor THEN unique_click_count + 1 ELSE unique_click_count END,
        last_clicked_at = NOW()
    WHERE id = v_link.id;

    -- Return link data
    RETURN QUERY SELECT
        v_link.target_url,
        v_link.route_type,
        v_link.entity_id,
        v_link.title,
        v_link.description,
        v_link.image_url;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get link analytics
CREATE OR REPLACE FUNCTION public.get_link_analytics(
    p_link_id UUID,
    p_days INTEGER DEFAULT 30
)
RETURNS TABLE (
    total_clicks BIGINT,
    unique_clicks BIGINT,
    clicks_by_platform JSONB,
    clicks_by_day JSONB,
    top_referrers JSONB,
    top_utm_sources JSONB
) AS $$
BEGIN
    RETURN QUERY
    WITH click_data AS (
        SELECT *
        FROM public.link_clicks
        WHERE link_id = p_link_id
          AND clicked_at > NOW() - (p_days || ' days')::INTERVAL
    ),
    by_platform AS (
        SELECT
            jsonb_object_agg(
                COALESCE(platform, 'unknown'),
                count
            ) as data
        FROM (
            SELECT platform, COUNT(*) as count
            FROM click_data
            GROUP BY platform
        ) t
    ),
    by_day AS (
        SELECT
            jsonb_agg(
                jsonb_build_object(
                    'date', date,
                    'clicks', clicks
                )
                ORDER BY date
            ) as data
        FROM (
            SELECT
                DATE(clicked_at) as date,
                COUNT(*) as clicks
            FROM click_data
            GROUP BY DATE(clicked_at)
        ) t
    ),
    referrers AS (
        SELECT
            jsonb_agg(
                jsonb_build_object(
                    'referrer', referrer,
                    'clicks', clicks
                )
            ) as data
        FROM (
            SELECT
                COALESCE(referrer, 'direct') as referrer,
                COUNT(*) as clicks
            FROM click_data
            GROUP BY referrer
            ORDER BY clicks DESC
            LIMIT 10
        ) t
    ),
    utm AS (
        SELECT
            jsonb_agg(
                jsonb_build_object(
                    'source', source,
                    'clicks', clicks
                )
            ) as data
        FROM (
            SELECT
                COALESCE(utm_source, 'none') as source,
                COUNT(*) as clicks
            FROM click_data
            WHERE utm_source IS NOT NULL
            GROUP BY utm_source
            ORDER BY clicks DESC
            LIMIT 10
        ) t
    )
    SELECT
        (SELECT COUNT(*) FROM click_data)::BIGINT,
        (SELECT COUNT(DISTINCT device_id) FROM click_data WHERE device_id IS NOT NULL)::BIGINT,
        COALESCE((SELECT data FROM by_platform), '{}'::JSONB),
        COALESCE((SELECT data FROM by_day), '[]'::JSONB),
        COALESCE((SELECT data FROM referrers), '[]'::JSONB),
        COALESCE((SELECT data FROM utm), '[]'::JSONB);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get user's short links
CREATE OR REPLACE FUNCTION public.get_my_short_links(
    p_limit INTEGER DEFAULT 50,
    p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
    id UUID,
    code TEXT,
    short_url TEXT,
    target_url TEXT,
    route_type TEXT,
    title TEXT,
    click_count INTEGER,
    unique_click_count INTEGER,
    is_active BOOLEAN,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        sl.id,
        sl.code,
        'https://foodshare.app/l/' || sl.code,
        sl.target_url,
        sl.route_type,
        sl.title,
        sl.click_count,
        sl.unique_click_count,
        sl.is_active,
        sl.expires_at,
        sl.created_at
    FROM public.short_links sl
    WHERE sl.created_by = auth.uid()
    ORDER BY sl.created_at DESC
    LIMIT p_limit
    OFFSET p_offset;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- TRIGGER: Update timestamps
-- =============================================================================

CREATE OR REPLACE FUNCTION public.update_short_links_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_short_links_updated
BEFORE UPDATE ON public.short_links
FOR EACH ROW EXECUTE FUNCTION public.update_short_links_timestamp();

-- =============================================================================
-- COMMENTS
-- =============================================================================

COMMENT ON TABLE public.short_links IS
'URL shortening for deep links with analytics tracking';

COMMENT ON TABLE public.link_clicks IS
'Click tracking for short links analytics';

COMMENT ON FUNCTION public.create_short_link IS
'Create a short link with optional custom code and expiration';

COMMENT ON FUNCTION public.resolve_short_link IS
'Resolve a short code to target URL and track the click';

COMMENT ON FUNCTION public.get_link_analytics IS
'Get analytics data for a short link';
