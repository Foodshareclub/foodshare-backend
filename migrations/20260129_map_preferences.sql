-- Map Preferences Table
CREATE TABLE user_map_preferences (
    user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    platform text NOT NULL DEFAULT 'web',
    device_id text,
    
    -- Map state
    last_center_lat double precision,
    last_center_lng double precision,
    last_zoom_level double precision DEFAULT 12,
    
    -- Display preferences
    map_style text DEFAULT 'standard',
    search_radius_km double precision DEFAULT 10.0,
    
    -- Sync
    version bigint DEFAULT 1,
    updated_at timestamptz DEFAULT now(),
    
    PRIMARY KEY (user_id, platform, COALESCE(device_id, ''))
);

-- Indexes
CREATE INDEX idx_map_prefs_updated ON user_map_preferences(updated_at);
CREATE INDEX idx_map_prefs_user ON user_map_preferences(user_id);

-- RLS
ALTER TABLE user_map_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own map preferences" ON user_map_preferences
    FOR ALL USING (auth.uid() = user_id);

-- Update trigger
CREATE OR REPLACE FUNCTION update_map_preferences_version()
RETURNS TRIGGER AS $$
BEGIN
    NEW.version = extract(epoch from now()) * 1000;
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER map_preferences_version_trigger
    BEFORE UPDATE ON user_map_preferences
    FOR EACH ROW EXECUTE FUNCTION update_map_preferences_version();
