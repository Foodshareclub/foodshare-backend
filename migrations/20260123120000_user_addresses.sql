-- User addresses table (one-to-one with profiles)
-- Allows users to store their address for profile display

CREATE TABLE IF NOT EXISTS user_addresses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id UUID NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
    address_line1 TEXT,
    address_line2 TEXT,
    city TEXT,
    state_province TEXT,
    postal_code TEXT,
    country TEXT,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS policies
ALTER TABLE user_addresses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own address"
    ON user_addresses FOR SELECT
    USING (profile_id = auth.uid());

CREATE POLICY "Users can insert own address"
    ON user_addresses FOR INSERT
    WITH CHECK (profile_id = auth.uid());

CREATE POLICY "Users can update own address"
    ON user_addresses FOR UPDATE
    USING (profile_id = auth.uid());

CREATE POLICY "Users can delete own address"
    ON user_addresses FOR DELETE
    USING (profile_id = auth.uid());

-- Index for faster lookups
CREATE INDEX idx_user_addresses_profile ON user_addresses(profile_id);
CREATE INDEX idx_user_addresses_location ON user_addresses(latitude, longitude)
    WHERE latitude IS NOT NULL;

-- Updated_at trigger (reuse existing function if available)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at_column'
    ) THEN
        CREATE OR REPLACE FUNCTION update_updated_at_column()
        RETURNS TRIGGER AS $func$
        BEGIN
            NEW.updated_at = NOW();
            RETURN NEW;
        END;
        $func$ LANGUAGE plpgsql;
    END IF;
END
$$;

CREATE TRIGGER update_user_addresses_updated_at
    BEFORE UPDATE ON user_addresses
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Comment for documentation
COMMENT ON TABLE user_addresses IS 'User address information for profile display, one-to-one with profiles';
