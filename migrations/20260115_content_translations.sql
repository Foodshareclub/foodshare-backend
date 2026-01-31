-- Migration: Content Translations for Self-Hosted LLM
-- Created: 2026-01-15
-- Purpose: Enable on-the-fly translation of user-generated content

-- =====================================================
-- Table: content_translations
-- =====================================================
CREATE TABLE IF NOT EXISTS content_translations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type TEXT NOT NULL CHECK (content_type IN ('post', 'challenge', 'forum_post')),
  content_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  source_locale TEXT NOT NULL,
  target_locale TEXT NOT NULL,
  source_text TEXT NOT NULL,
  translated_text TEXT NOT NULL,
  translation_service TEXT DEFAULT 'self-hosted-llm',
  quality_score FLOAT DEFAULT 0.95,
  character_count INT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '90 days',
  hit_count INT DEFAULT 0,
  last_hit_at TIMESTAMPTZ,
  UNIQUE(content_type, content_id, field_name, source_locale, target_locale, source_text)
);

-- Indexes for performance
CREATE INDEX idx_translations_lookup 
  ON content_translations(content_type, content_id, field_name, target_locale)
  WHERE expires_at > NOW();

CREATE INDEX idx_translations_expiry 
  ON content_translations(expires_at) 
  WHERE expires_at < NOW();

CREATE INDEX idx_translations_popular
  ON content_translations(hit_count DESC) 
  WHERE hit_count > 10;

CREATE INDEX idx_translations_locale
  ON content_translations(target_locale, created_at DESC);

-- =====================================================
-- Function: get_or_translate
-- =====================================================
CREATE OR REPLACE FUNCTION get_or_translate(
  p_content_type TEXT,
  p_content_id TEXT,
  p_field_name TEXT,
  p_source_locale TEXT,
  p_target_locale TEXT,
  p_source_text TEXT
) RETURNS TABLE (
  translated_text TEXT,
  cached BOOLEAN,
  quality_score FLOAT
) AS $$
DECLARE
  v_translation RECORD;
BEGIN
  -- Try to find existing translation
  SELECT * INTO v_translation
  FROM content_translations
  WHERE content_type = p_content_type
    AND content_id = p_content_id
    AND field_name = p_field_name
    AND source_locale = p_source_locale
    AND target_locale = p_target_locale
    AND source_text = p_source_text
    AND expires_at > NOW();
  
  IF FOUND THEN
    -- Update hit count and last hit time
    UPDATE content_translations
    SET hit_count = hit_count + 1,
        last_hit_at = NOW()
    WHERE id = v_translation.id;
    
    RETURN QUERY SELECT 
      v_translation.translated_text,
      TRUE as cached,
      v_translation.quality_score;
  ELSE
    -- Return null to indicate cache miss
    RETURN QUERY SELECT 
      NULL::TEXT as translated_text,
      FALSE as cached,
      NULL::FLOAT as quality_score;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- Function: store_translation
-- =====================================================
CREATE OR REPLACE FUNCTION store_translation(
  p_content_type TEXT,
  p_content_id TEXT,
  p_field_name TEXT,
  p_source_locale TEXT,
  p_target_locale TEXT,
  p_source_text TEXT,
  p_translated_text TEXT,
  p_quality_score FLOAT DEFAULT 0.95
) RETURNS UUID AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO content_translations (
    content_type,
    content_id,
    field_name,
    source_locale,
    target_locale,
    source_text,
    translated_text,
    translation_service,
    quality_score,
    character_count
  ) VALUES (
    p_content_type,
    p_content_id,
    p_field_name,
    p_source_locale,
    p_target_locale,
    p_source_text,
    p_translated_text,
    'self-hosted-llm',
    p_quality_score,
    LENGTH(p_source_text)
  )
  ON CONFLICT (content_type, content_id, field_name, source_locale, target_locale, source_text)
  DO UPDATE SET
    translated_text = EXCLUDED.translated_text,
    quality_score = EXCLUDED.quality_score,
    hit_count = content_translations.hit_count + 1,
    last_hit_at = NOW()
  RETURNING id INTO v_id;
  
  RETURN v_id;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- Function: cleanup_expired_translations
-- =====================================================
CREATE OR REPLACE FUNCTION cleanup_expired_translations()
RETURNS INTEGER AS $$
DECLARE
  v_deleted_count INTEGER;
BEGIN
  DELETE FROM content_translations
  WHERE expires_at < NOW()
    AND hit_count < 5; -- Keep popular translations even if expired
  
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RETURN v_deleted_count;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- Function: get_translation_stats
-- =====================================================
CREATE OR REPLACE FUNCTION get_translation_stats(
  p_locale TEXT DEFAULT NULL
) RETURNS TABLE (
  locale TEXT,
  total_translations BIGINT,
  cached_hits BIGINT,
  avg_quality FLOAT,
  total_characters BIGINT,
  popular_content_types JSONB
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    ct.target_locale as locale,
    COUNT(*)::BIGINT as total_translations,
    SUM(ct.hit_count)::BIGINT as cached_hits,
    AVG(ct.quality_score)::FLOAT as avg_quality,
    SUM(ct.character_count)::BIGINT as total_characters,
    jsonb_object_agg(
      ct.content_type,
      COUNT(*)
    ) as popular_content_types
  FROM content_translations ct
  WHERE (p_locale IS NULL OR ct.target_locale = p_locale)
    AND ct.expires_at > NOW()
  GROUP BY ct.target_locale;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- Scheduled cleanup job (run daily)
-- =====================================================
COMMENT ON FUNCTION cleanup_expired_translations() IS 
  'Run daily via pg_cron: SELECT cron.schedule(''cleanup-translations'', ''0 2 * * *'', ''SELECT cleanup_expired_translations()'')';

-- =====================================================
-- Row Level Security
-- =====================================================
ALTER TABLE content_translations ENABLE ROW LEVEL SECURITY;

-- Anyone can read translations
CREATE POLICY "Public read translations"
  ON content_translations FOR SELECT
  TO authenticated, anon
  USING (true);

-- Only service role can insert/update translations
CREATE POLICY "Service role can manage translations"
  ON content_translations FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- =====================================================
-- Grant permissions
-- =====================================================
GRANT SELECT ON content_translations TO authenticated, anon;
GRANT ALL ON content_translations TO service_role;

-- =====================================================
-- Comments
-- =====================================================
COMMENT ON TABLE content_translations IS 
  'Stores translations of user-generated content using self-hosted LLM';

COMMENT ON COLUMN content_translations.content_type IS 
  'Type of content: post, challenge, forum_post';

COMMENT ON COLUMN content_translations.hit_count IS 
  'Number of times this translation was served from cache';

COMMENT ON COLUMN content_translations.expires_at IS 
  'Translations expire after 90 days but popular ones (hit_count > 5) are kept';

COMMENT ON FUNCTION get_or_translate IS 
  'Get cached translation or return null to trigger LLM translation';

COMMENT ON FUNCTION store_translation IS 
  'Store a new translation or update existing one';
