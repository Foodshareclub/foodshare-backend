-- Migration: Create app_config table for remote configuration
-- This allows the iOS/Android/Web apps to fetch configuration from the database
-- instead of using hardcoded values

-- Create app_config table
CREATE TABLE IF NOT EXISTS public.app_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  platform TEXT DEFAULT 'all' CHECK (platform IN ('ios', 'android', 'web', 'all')),
  category TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(key, platform)
);

-- Add comment
COMMENT ON TABLE public.app_config IS 'Remote configuration for mobile and web apps. Allows changing app behavior without app updates.';
COMMENT ON COLUMN public.app_config.key IS 'Configuration key name';
COMMENT ON COLUMN public.app_config.value IS 'Configuration value as JSONB (can be number, string, object, array)';
COMMENT ON COLUMN public.app_config.platform IS 'Target platform: ios, android, web, or all';
COMMENT ON COLUMN public.app_config.category IS 'Category for grouping: pagination, cache, uploads, impact, gamification, network, location, rate_limits';

-- Enable RLS with public read
ALTER TABLE public.app_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read config"
  ON public.app_config FOR SELECT
  USING (true);

CREATE POLICY "Service role can manage config"
  ON public.app_config FOR ALL
  TO service_role
  USING (true);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_app_config_platform ON public.app_config(platform);
CREATE INDEX IF NOT EXISTS idx_app_config_category ON public.app_config(category);
CREATE INDEX IF NOT EXISTS idx_app_config_key ON public.app_config(key);

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_app_config_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS app_config_updated_at ON public.app_config;
CREATE TRIGGER app_config_updated_at
  BEFORE UPDATE ON public.app_config
  FOR EACH ROW EXECUTE FUNCTION update_app_config_updated_at();

-- Insert all configuration values
INSERT INTO public.app_config (key, value, platform, category, description) VALUES
-- Pagination
('page_size', '20', 'all', 'pagination', 'Default items per page'),
('max_page_size', '100', 'all', 'pagination', 'Maximum items per page'),
('map_max_items', '100', 'all', 'pagination', 'Max items shown on map'),

-- Cache TTLs (in seconds)
('cache_listings_ttl', '300', 'all', 'cache', 'Listings cache TTL (5 min)'),
('cache_categories_ttl', '3600', 'all', 'cache', 'Categories cache TTL (1 hour)'),
('cache_profile_ttl', '600', 'all', 'cache', 'Profile cache TTL (10 min)'),
('cache_feed_ttl', '180', 'all', 'cache', 'Feed cache TTL (3 min)'),

-- Image uploads
('max_images', '5', 'all', 'uploads', 'Max images per listing'),
('max_image_size_mb', '5', 'all', 'uploads', 'Max image file size in MB'),
('max_image_dimension', '1200', 'all', 'uploads', 'Max image dimension in pixels'),
('jpeg_quality', '0.8', 'all', 'uploads', 'JPEG compression quality'),

-- Impact multipliers (for environmental impact calculations)
('food_kg_per_item', '0.5', 'all', 'impact', 'Average food kg saved per item'),
('co2_kg_per_item', '2.5', 'all', 'impact', 'Average CO2 kg saved per item'),
('water_liters_per_item', '100', 'all', 'impact', 'Average water liters saved per item'),
('money_usd_per_item', '5.0', 'all', 'impact', 'Average money saved per item'),

-- Gamification XP values
('xp_per_share', '15', 'all', 'gamification', 'XP earned for sharing food'),
('xp_per_receive', '8', 'all', 'gamification', 'XP earned for receiving food'),
('xp_per_review', '5', 'all', 'gamification', 'XP earned for writing review'),
('xp_rating_bonus', '10', 'all', 'gamification', 'XP bonus multiplier from rating'),

-- Network configuration
('request_timeout_seconds', '30', 'all', 'network', 'API request timeout'),
('resource_timeout_seconds', '60', 'all', 'network', 'Resource download timeout'),
('max_retries', '3', 'all', 'network', 'Max retry attempts'),

-- Location settings
('default_search_radius_km', '5', 'all', 'location', 'Default search radius'),
('extended_search_radius_km', '10', 'all', 'location', 'Extended search radius'),
('max_search_radius_km', '100', 'all', 'location', 'Maximum search radius'),
('location_update_distance_m', '100', 'all', 'location', 'GPS update distance filter'),

-- Rate limits
('max_invitations_per_request', '10', 'all', 'rate_limits', 'Max invitations per request'),
('search_debounce_ms', '300', 'all', 'rate_limits', 'Search input debounce delay')

ON CONFLICT (key, platform) DO UPDATE SET
  value = EXCLUDED.value,
  description = EXCLUDED.description,
  updated_at = now();

-- RPC function to get config (for iOS/Android/Web)
CREATE OR REPLACE FUNCTION get_app_config(p_platform TEXT DEFAULT 'ios')
RETURNS jsonb AS $$
DECLARE
  config jsonb := '{}'::jsonb;
  row_data RECORD;
BEGIN
  -- Get platform-specific and 'all' configs, prefer platform-specific
  FOR row_data IN
    SELECT DISTINCT ON (key) key, value, category
    FROM public.app_config
    WHERE platform = p_platform OR platform = 'all'
    ORDER BY key, (platform = p_platform) DESC
  LOOP
    -- Build nested structure by category
    IF NOT config ? row_data.category THEN
      config := config || jsonb_build_object(row_data.category, '{}'::jsonb);
    END IF;
    config := jsonb_set(
      config,
      ARRAY[row_data.category, row_data.key],
      row_data.value
    );
  END LOOP;

  RETURN config;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute to authenticated and anonymous users
GRANT EXECUTE ON FUNCTION get_app_config(TEXT) TO authenticated, anon;

-- Add comment
COMMENT ON FUNCTION get_app_config(TEXT) IS 'Returns app configuration as nested JSONB grouped by category. Pass platform (ios, android, web) to get platform-specific overrides.';
