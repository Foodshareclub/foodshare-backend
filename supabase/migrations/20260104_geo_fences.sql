-- =============================================================================
-- Phase 7: Geo-Spatial Utilities Infrastructure
-- =============================================================================
-- Geo-fencing, location clustering, and spatial search for all platforms
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "postgis";

-- =============================================================================
-- GEO FENCES TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.geo_fences (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    name TEXT NOT NULL,
    fence_type TEXT NOT NULL DEFAULT 'circle' CHECK (fence_type IN ('circle', 'polygon')),

    -- Circle parameters
    center_lat DOUBLE PRECISION,
    center_lng DOUBLE PRECISION,
    radius_meters DOUBLE PRECISION,

    -- Polygon parameters (GeoJSON)
    polygon GEOMETRY(Polygon, 4326),

    -- Triggers
    trigger_on_enter BOOLEAN NOT NULL DEFAULT true,
    trigger_on_exit BOOLEAN NOT NULL DEFAULT false,

    -- Notification settings
    notification_enabled BOOLEAN NOT NULL DEFAULT true,
    notification_message TEXT,

    -- Status
    active BOOLEAN NOT NULL DEFAULT true,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- SAVED LOCATIONS TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.saved_locations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    name TEXT NOT NULL,
    address TEXT,
    lat DOUBLE PRECISION NOT NULL,
    lng DOUBLE PRECISION NOT NULL,
    location GEOMETRY(Point, 4326) GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lng, lat), 4326)) STORED,

    location_type TEXT DEFAULT 'custom' CHECK (location_type IN ('home', 'work', 'custom')),
    is_default BOOLEAN NOT NULL DEFAULT false,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- INDEXES
-- =============================================================================

CREATE INDEX idx_geo_fences_user ON public.geo_fences(user_id, active) WHERE active = true;
CREATE INDEX idx_geo_fences_center ON public.geo_fences USING GIST (ST_SetSRID(ST_MakePoint(center_lng, center_lat), 4326));
CREATE INDEX idx_geo_fences_polygon ON public.geo_fences USING GIST (polygon);

CREATE INDEX idx_saved_locations_user ON public.saved_locations(user_id);
CREATE INDEX idx_saved_locations_geo ON public.saved_locations USING GIST (location);

-- =============================================================================
-- RLS POLICIES
-- =============================================================================

ALTER TABLE public.geo_fences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saved_locations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own geo fences" ON public.geo_fences FOR ALL TO authenticated
    USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users manage own saved locations" ON public.saved_locations FOR ALL TO authenticated
    USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- =============================================================================
-- FUNCTIONS
-- =============================================================================

-- Optimized geo search
CREATE OR REPLACE FUNCTION public.geo_search_listings(
    p_lat DOUBLE PRECISION,
    p_lng DOUBLE PRECISION,
    p_radius_km DOUBLE PRECISION DEFAULT 10,
    p_limit INTEGER DEFAULT 50
)
RETURNS TABLE (
    listing_id UUID,
    distance_km DOUBLE PRECISION,
    bearing DOUBLE PRECISION
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        p.id,
        ST_Distance(
            ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
            ST_SetSRID(ST_MakePoint(p.longitude, p.latitude), 4326)::geography
        ) / 1000.0 as distance_km,
        degrees(ST_Azimuth(
            ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326),
            ST_SetSRID(ST_MakePoint(p.longitude, p.latitude), 4326)
        )) as bearing
    FROM public.posts p
    WHERE p.latitude IS NOT NULL
      AND p.longitude IS NOT NULL
      AND p.status = 'available'
      AND ST_DWithin(
          ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
          ST_SetSRID(ST_MakePoint(p.longitude, p.latitude), 4326)::geography,
          p_radius_km * 1000
      )
    ORDER BY distance_km
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Check if point is in any user's geo fence
CREATE OR REPLACE FUNCTION public.check_geo_fence_triggers(
    p_user_id UUID,
    p_lat DOUBLE PRECISION,
    p_lng DOUBLE PRECISION
)
RETURNS TABLE (
    fence_id UUID,
    fence_name TEXT,
    trigger_type TEXT,
    notification_message TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        gf.id,
        gf.name,
        CASE
            WHEN gf.trigger_on_enter THEN 'enter'
            ELSE 'exit'
        END,
        gf.notification_message
    FROM public.geo_fences gf
    WHERE gf.user_id = p_user_id
      AND gf.active = true
      AND gf.notification_enabled = true
      AND (
          (gf.fence_type = 'circle' AND ST_DWithin(
              ST_SetSRID(ST_MakePoint(gf.center_lng, gf.center_lat), 4326)::geography,
              ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
              gf.radius_meters
          ))
          OR
          (gf.fence_type = 'polygon' AND ST_Contains(gf.polygon, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)))
      );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON TABLE public.geo_fences IS 'User-defined geographic areas for pickup notifications';
COMMENT ON TABLE public.saved_locations IS 'User saved locations for quick address selection';
