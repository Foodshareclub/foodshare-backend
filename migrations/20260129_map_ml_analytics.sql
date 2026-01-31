-- ML-powered map analytics and clustering
CREATE TABLE map_interaction_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    
    -- Interaction data
    center_lat double precision NOT NULL,
    center_lng double precision NOT NULL,
    zoom_level double precision NOT NULL,
    
    -- Context
    platform text NOT NULL,
    device_id text,
    session_id text,
    
    -- ML features
    time_of_day integer NOT NULL, -- 0-23
    day_of_week integer NOT NULL, -- 0-6
    duration_seconds integer DEFAULT 0,
    interaction_type text DEFAULT 'pan', -- pan, zoom, search
    
    -- Geospatial
    geom geometry(POINT, 4326) GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(center_lng, center_lat), 4326)) STORED,
    
    created_at timestamptz DEFAULT now()
);

-- Spatial index for clustering
CREATE INDEX idx_map_events_geom ON map_interaction_events USING GIST (geom);
CREATE INDEX idx_map_events_user_time ON map_interaction_events(user_id, created_at);
CREATE INDEX idx_map_events_context ON map_interaction_events(platform, time_of_day, day_of_week);

-- Hotspot detection function
CREATE OR REPLACE FUNCTION detect_map_hotspots(
    p_user_id uuid,
    p_radius_meters integer DEFAULT 1000,
    p_min_interactions integer DEFAULT 5
)
RETURNS TABLE(
    hotspot_center geometry,
    interaction_count bigint,
    avg_zoom double precision,
    primary_time_of_day integer,
    confidence_score double precision
) AS $$
BEGIN
    RETURN QUERY
    WITH clustered_interactions AS (
        SELECT 
            ST_ClusterKMeans(geom, 10) OVER() as cluster_id,
            geom,
            zoom_level,
            time_of_day,
            created_at
        FROM map_interaction_events 
        WHERE user_id = p_user_id 
        AND created_at > now() - interval '30 days'
    ),
    hotspots AS (
        SELECT 
            cluster_id,
            ST_Centroid(ST_Collect(geom)) as center,
            COUNT(*) as interactions,
            AVG(zoom_level) as avg_zoom,
            MODE() WITHIN GROUP (ORDER BY time_of_day) as primary_hour,
            -- Confidence based on recency and frequency
            (COUNT(*) * 0.7 + 
             AVG(EXTRACT(epoch FROM (now() - created_at)) / 86400) * -0.3 + 30) / 30.0 as confidence
        FROM clustered_interactions
        GROUP BY cluster_id
        HAVING COUNT(*) >= p_min_interactions
    )
    SELECT 
        h.center,
        h.interactions,
        h.avg_zoom,
        h.primary_hour,
        LEAST(1.0, GREATEST(0.0, h.confidence)) as confidence_score
    FROM hotspots h
    ORDER BY h.confidence DESC, h.interactions DESC
    LIMIT 5;
END;
$$ LANGUAGE plpgsql STABLE;
