-- Migration: Translation Tracking System
-- Description: Track missing translation keys and provide analytics
-- Created: 2026-01-14

-- Table: translation_missing_keys
CREATE TABLE IF NOT EXISTS translation_missing_keys (
    id BIGSERIAL PRIMARY KEY,
    key TEXT NOT NULL,
    locale TEXT NOT NULL DEFAULT 'en',
    platform TEXT NOT NULL,
    app_version TEXT,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    count INTEGER DEFAULT 1,
    CONSTRAINT unique_key_locale_platform UNIQUE (key, locale, platform)
);

CREATE INDEX IF NOT EXISTS idx_translation_missing_keys_key ON translation_missing_keys(key);
CREATE INDEX IF NOT EXISTS idx_translation_missing_keys_locale ON translation_missing_keys(locale);
CREATE INDEX IF NOT EXISTS idx_translation_missing_keys_platform ON translation_missing_keys(platform);

-- Table: translation_versions
CREATE TABLE IF NOT EXISTS translation_versions (
    id BIGSERIAL PRIMARY KEY,
    locale TEXT NOT NULL UNIQUE,
    version TEXT NOT NULL,
    total_keys INTEGER NOT NULL DEFAULT 0,
    last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    checksum TEXT
);

-- Insert default versions
INSERT INTO translation_versions (locale, version, total_keys) VALUES
    ('en', '1.0.0', 0) ON CONFLICT (locale) DO NOTHING;

-- Function: Get top missing keys
CREATE OR REPLACE FUNCTION get_top_missing_keys(
    p_locale TEXT DEFAULT 'en',
    p_limit INTEGER DEFAULT 50
) RETURNS TABLE (
    key TEXT,
    count BIGINT,
    platforms TEXT[],
    first_reported TIMESTAMPTZ,
    last_reported TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        tmk.key,
        SUM(tmk.count)::BIGINT AS total_count,
        ARRAY_AGG(DISTINCT tmk.platform) AS platforms,
        MIN(tmk.reported_at) AS first_reported,
        MAX(tmk.reported_at) AS last_reported
    FROM translation_missing_keys tmk
    WHERE tmk.locale = p_locale
      AND tmk.resolved_at IS NULL
    GROUP BY tmk.key
    ORDER BY total_count DESC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- RLS Policies
ALTER TABLE translation_missing_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE translation_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Translation versions are publicly readable"
    ON translation_versions FOR SELECT
    USING (true);

CREATE POLICY "Authenticated users can report missing keys"
    ON translation_missing_keys FOR INSERT
    TO authenticated
    WITH CHECK (true);

GRANT SELECT ON translation_versions TO authenticated, anon;
GRANT INSERT ON translation_missing_keys TO authenticated;
GRANT EXECUTE ON FUNCTION get_top_missing_keys TO authenticated;
