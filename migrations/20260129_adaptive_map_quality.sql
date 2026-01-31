-- Adaptive map quality and network optimization
CREATE TABLE user_network_profiles (
    user_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
    
    -- Network characteristics
    avg_bandwidth_mbps double precision DEFAULT 10.0,
    connection_type text DEFAULT 'wifi', -- wifi, cellular, slow
    latency_ms integer DEFAULT 100,
    
    -- Device capabilities
    device_pixel_ratio double precision DEFAULT 2.0,
    screen_width integer DEFAULT 375,
    screen_height integer DEFAULT 667,
    gpu_tier text DEFAULT 'mid', -- low, mid, high
    
    -- Adaptive settings
    preferred_tile_quality text DEFAULT 'auto', -- low, medium, high, auto
    enable_retina boolean DEFAULT true,
    enable_vector_tiles boolean DEFAULT true,
    max_concurrent_tiles integer DEFAULT 6,
    
    -- Performance metrics
    avg_tile_load_time_ms integer DEFAULT 500,
    cache_hit_rate double precision DEFAULT 0.8,
    battery_level integer DEFAULT 100,
    
    updated_at timestamptz DEFAULT now()
);

-- Network quality detection function
CREATE OR REPLACE FUNCTION update_network_profile(
    p_user_id uuid,
    p_bandwidth_mbps double precision,
    p_latency_ms integer,
    p_connection_type text,
    p_device_info jsonb
)
RETURNS jsonb AS $$
DECLARE
    v_quality_tier text;
    v_tile_settings jsonb;
BEGIN
    -- Determine optimal quality tier
    v_quality_tier := CASE 
        WHEN p_bandwidth_mbps > 20 AND p_latency_ms < 50 THEN 'high'
        WHEN p_bandwidth_mbps > 5 AND p_latency_ms < 200 THEN 'medium'
        ELSE 'low'
    END;
    
    -- Generate adaptive tile settings
    v_tile_settings := jsonb_build_object(
        'quality', v_quality_tier,
        'retina', p_bandwidth_mbps > 10,
        'vector', p_bandwidth_mbps > 5 AND p_latency_ms < 300,
        'concurrent_tiles', CASE 
            WHEN p_bandwidth_mbps > 15 THEN 8
            WHEN p_bandwidth_mbps > 5 THEN 6
            ELSE 3
        END,
        'compression', CASE
            WHEN p_bandwidth_mbps < 2 THEN 'high'
            WHEN p_bandwidth_mbps < 10 THEN 'medium'
            ELSE 'low'
        END
    );
    
    -- Update user profile
    INSERT INTO user_network_profiles (
        user_id,
        avg_bandwidth_mbps,
        latency_ms,
        connection_type,
        device_pixel_ratio,
        screen_width,
        screen_height,
        gpu_tier,
        preferred_tile_quality,
        enable_retina,
        enable_vector_tiles,
        max_concurrent_tiles
    ) VALUES (
        p_user_id,
        p_bandwidth_mbps,
        p_latency_ms,
        p_connection_type,
        (p_device_info->>'pixelRatio')::double precision,
        (p_device_info->>'screenWidth')::integer,
        (p_device_info->>'screenHeight')::integer,
        p_device_info->>'gpuTier',
        v_quality_tier,
        (v_tile_settings->>'retina')::boolean,
        (v_tile_settings->>'vector')::boolean,
        (v_tile_settings->>'concurrent_tiles')::integer
    )
    ON CONFLICT (user_id) DO UPDATE SET
        avg_bandwidth_mbps = EXCLUDED.avg_bandwidth_mbps,
        latency_ms = EXCLUDED.latency_ms,
        connection_type = EXCLUDED.connection_type,
        preferred_tile_quality = EXCLUDED.preferred_tile_quality,
        enable_retina = EXCLUDED.enable_retina,
        enable_vector_tiles = EXCLUDED.enable_vector_tiles,
        max_concurrent_tiles = EXCLUDED.max_concurrent_tiles,
        updated_at = now();
    
    RETURN v_tile_settings;
END;
$$ LANGUAGE plpgsql;
