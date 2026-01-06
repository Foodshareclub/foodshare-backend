-- =============================================================================
-- Phase 8: Media Processing Infrastructure
-- =============================================================================
-- Image hashing, deduplication, and processing queue for all platforms
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================================
-- IMAGE HASHES TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.image_hashes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- File reference
    storage_path TEXT NOT NULL UNIQUE,
    bucket TEXT NOT NULL DEFAULT 'images',

    -- Hashes for dedup
    perceptual_hash TEXT NOT NULL,
    average_hash TEXT,
    difference_hash TEXT,
    content_hash TEXT NOT NULL,  -- SHA256 of file content

    -- Metadata
    width INTEGER,
    height INTEGER,
    file_size INTEGER,
    mime_type TEXT,

    -- Processing state
    processed BOOLEAN NOT NULL DEFAULT false,
    variants JSONB DEFAULT '[]'::jsonb,  -- Generated sizes/formats

    -- Ownership
    uploaded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- MEDIA PROCESSING QUEUE TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.media_processing_queue (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Source
    source_path TEXT NOT NULL,
    source_bucket TEXT NOT NULL DEFAULT 'images',

    -- Processing config
    operation TEXT NOT NULL CHECK (operation IN (
        'resize', 'compress', 'convert', 'thumbnail', 'blur_faces', 'remove_metadata'
    )),
    config JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Output
    output_path TEXT,
    output_bucket TEXT,

    -- Status
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending', 'processing', 'completed', 'failed'
    )),
    error_message TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,

    -- Priority
    priority INTEGER NOT NULL DEFAULT 0,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);

-- =============================================================================
-- INDEXES
-- =============================================================================

CREATE INDEX idx_image_hashes_perceptual ON public.image_hashes(perceptual_hash);
CREATE INDEX idx_image_hashes_content ON public.image_hashes(content_hash);
CREATE INDEX idx_image_hashes_user ON public.image_hashes(uploaded_by, created_at DESC);

CREATE INDEX idx_media_queue_status ON public.media_processing_queue(status, priority DESC, created_at)
    WHERE status = 'pending';

-- =============================================================================
-- RLS POLICIES
-- =============================================================================

ALTER TABLE public.image_hashes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_processing_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role manages image hashes" ON public.image_hashes FOR ALL TO service_role USING (true);
CREATE POLICY "Users view own images" ON public.image_hashes FOR SELECT TO authenticated
    USING (uploaded_by = auth.uid());

CREATE POLICY "Service role manages media queue" ON public.media_processing_queue FOR ALL TO service_role USING (true);

-- =============================================================================
-- FUNCTIONS
-- =============================================================================

-- Find duplicate images
CREATE OR REPLACE FUNCTION public.find_duplicate_images(
    p_perceptual_hash TEXT,
    p_threshold INTEGER DEFAULT 5
)
RETURNS TABLE (
    id UUID,
    storage_path TEXT,
    similarity INTEGER
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        ih.id,
        ih.storage_path,
        bit_count(p_perceptual_hash::bit(64) # ih.perceptual_hash::bit(64))::INTEGER as similarity
    FROM public.image_hashes ih
    WHERE bit_count(p_perceptual_hash::bit(64) # ih.perceptual_hash::bit(64)) <= p_threshold
    ORDER BY similarity
    LIMIT 10;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Queue image processing
CREATE OR REPLACE FUNCTION public.queue_image_processing(
    p_source_path TEXT,
    p_operation TEXT,
    p_config JSONB DEFAULT '{}'::jsonb,
    p_priority INTEGER DEFAULT 0
)
RETURNS UUID AS $$
DECLARE
    v_id UUID;
BEGIN
    INSERT INTO public.media_processing_queue (source_path, operation, config, priority)
    VALUES (p_source_path, p_operation, p_config, p_priority)
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON TABLE public.image_hashes IS 'Perceptual and content hashes for image deduplication';
COMMENT ON TABLE public.media_processing_queue IS 'Queue for async image processing operations';
