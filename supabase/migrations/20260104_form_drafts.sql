-- =============================================================================
-- Phase 5: Form Drafts Infrastructure
-- =============================================================================
-- Cross-device form draft synchronization for Web, iOS, and Android
-- Supports auto-save, conflict resolution, and expiration
-- =============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================================
-- FORM DRAFTS TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.form_drafts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Owner
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    -- Form identification
    form_type TEXT NOT NULL CHECK (form_type IN (
        'create_listing', 'edit_listing',
        'create_profile', 'edit_profile',
        'create_review',
        'create_forum_post', 'create_forum_comment',
        'report_content'
    )),
    entity_id TEXT,  -- ID of entity being edited (for edit forms)

    -- Draft content
    fields JSONB NOT NULL DEFAULT '{}'::jsonb,
    validation_state JSONB DEFAULT '{}'::jsonb,

    -- Version control
    version INTEGER NOT NULL DEFAULT 1,
    client_version INTEGER NOT NULL DEFAULT 1,
    conflict_resolved BOOLEAN NOT NULL DEFAULT false,

    -- Source device
    device_id TEXT NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'web')),

    -- Metadata
    metadata JSONB DEFAULT '{}'::jsonb,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',

    -- Unique constraint per user/form/entity
    UNIQUE(user_id, form_type, COALESCE(entity_id, ''))
);

-- =============================================================================
-- DRAFT HISTORY TABLE (for conflict resolution)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.form_draft_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    draft_id UUID NOT NULL REFERENCES public.form_drafts(id) ON DELETE CASCADE,

    -- Snapshot
    fields JSONB NOT NULL,
    version INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    platform TEXT NOT NULL,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Action
    action TEXT NOT NULL CHECK (action IN ('create', 'update', 'conflict', 'resolve'))
);

-- =============================================================================
-- INDEXES
-- =============================================================================

-- User's drafts
CREATE INDEX idx_form_drafts_user ON public.form_drafts(user_id, updated_at DESC);

-- Active drafts by form type
CREATE INDEX idx_form_drafts_type ON public.form_drafts(user_id, form_type, entity_id)
WHERE expires_at > NOW();

-- Cleanup expired drafts
CREATE INDEX idx_form_drafts_expires ON public.form_drafts(expires_at)
WHERE expires_at IS NOT NULL;

-- History lookup
CREATE INDEX idx_draft_history_draft ON public.form_draft_history(draft_id, created_at DESC);

-- =============================================================================
-- RLS POLICIES
-- =============================================================================

ALTER TABLE public.form_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.form_draft_history ENABLE ROW LEVEL SECURITY;

-- Users can manage their own drafts
CREATE POLICY "Users manage own drafts"
ON public.form_drafts FOR ALL
TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

-- Users can view their draft history
CREATE POLICY "Users view own draft history"
ON public.form_draft_history FOR SELECT
TO authenticated
USING (EXISTS (
    SELECT 1 FROM public.form_drafts d
    WHERE d.id = draft_id AND d.user_id = auth.uid()
));

-- Service role has full access
CREATE POLICY "Service role manages all drafts"
ON public.form_drafts FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

CREATE POLICY "Service role manages all history"
ON public.form_draft_history FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- =============================================================================
-- FUNCTIONS
-- =============================================================================

-- Save or update a draft with conflict detection
CREATE OR REPLACE FUNCTION public.save_form_draft(
    p_form_type TEXT,
    p_entity_id TEXT DEFAULT NULL,
    p_fields JSONB DEFAULT '{}'::jsonb,
    p_validation_state JSONB DEFAULT '{}'::jsonb,
    p_device_id TEXT DEFAULT 'unknown',
    p_platform TEXT DEFAULT 'web',
    p_client_version INTEGER DEFAULT 1,
    p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
    draft_id UUID,
    version INTEGER,
    has_conflict BOOLEAN,
    server_fields JSONB,
    server_version INTEGER
) AS $$
DECLARE
    v_existing public.form_drafts;
    v_draft_id UUID;
    v_new_version INTEGER;
    v_has_conflict BOOLEAN := false;
BEGIN
    -- Check for existing draft
    SELECT * INTO v_existing
    FROM public.form_drafts
    WHERE user_id = auth.uid()
      AND form_type = p_form_type
      AND COALESCE(entity_id, '') = COALESCE(p_entity_id, '');

    IF v_existing.id IS NOT NULL THEN
        -- Check for conflict (client version behind server)
        IF p_client_version < v_existing.version THEN
            v_has_conflict := true;

            -- Record conflict
            INSERT INTO public.form_draft_history (
                draft_id, fields, version, device_id, platform, action
            ) VALUES (
                v_existing.id, p_fields, p_client_version, p_device_id, p_platform, 'conflict'
            );

            RETURN QUERY SELECT
                v_existing.id,
                v_existing.version,
                true,
                v_existing.fields,
                v_existing.version;
            RETURN;
        END IF;

        -- Update existing draft
        v_new_version := v_existing.version + 1;

        -- Save history
        INSERT INTO public.form_draft_history (
            draft_id, fields, version, device_id, platform, action
        ) VALUES (
            v_existing.id, v_existing.fields, v_existing.version, v_existing.device_id, v_existing.platform, 'update'
        );

        -- Update draft
        UPDATE public.form_drafts
        SET fields = p_fields,
            validation_state = p_validation_state,
            version = v_new_version,
            client_version = p_client_version,
            device_id = p_device_id,
            platform = p_platform,
            metadata = COALESCE(metadata, '{}'::jsonb) || p_metadata,
            updated_at = NOW(),
            last_synced_at = NOW(),
            expires_at = NOW() + INTERVAL '7 days',
            conflict_resolved = false
        WHERE id = v_existing.id
        RETURNING id INTO v_draft_id;

    ELSE
        -- Create new draft
        v_new_version := 1;

        INSERT INTO public.form_drafts (
            user_id,
            form_type,
            entity_id,
            fields,
            validation_state,
            version,
            client_version,
            device_id,
            platform,
            metadata
        ) VALUES (
            auth.uid(),
            p_form_type,
            p_entity_id,
            p_fields,
            p_validation_state,
            v_new_version,
            p_client_version,
            p_device_id,
            p_platform,
            p_metadata
        )
        RETURNING id INTO v_draft_id;

        -- Save history
        INSERT INTO public.form_draft_history (
            draft_id, fields, version, device_id, platform, action
        ) VALUES (
            v_draft_id, p_fields, v_new_version, p_device_id, p_platform, 'create'
        );
    END IF;

    RETURN QUERY SELECT v_draft_id, v_new_version, false, p_fields, v_new_version;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Resolve a draft conflict
CREATE OR REPLACE FUNCTION public.resolve_draft_conflict(
    p_draft_id UUID,
    p_resolved_fields JSONB,
    p_device_id TEXT,
    p_platform TEXT
)
RETURNS public.form_drafts AS $$
DECLARE
    v_draft public.form_drafts;
    v_new_version INTEGER;
BEGIN
    SELECT * INTO v_draft
    FROM public.form_drafts
    WHERE id = p_draft_id AND user_id = auth.uid();

    IF v_draft.id IS NULL THEN
        RAISE EXCEPTION 'Draft not found or access denied';
    END IF;

    v_new_version := v_draft.version + 1;

    -- Save history
    INSERT INTO public.form_draft_history (
        draft_id, fields, version, device_id, platform, action
    ) VALUES (
        p_draft_id, p_resolved_fields, v_new_version, p_device_id, p_platform, 'resolve'
    );

    -- Update draft
    UPDATE public.form_drafts
    SET fields = p_resolved_fields,
        version = v_new_version,
        conflict_resolved = true,
        device_id = p_device_id,
        platform = p_platform,
        updated_at = NOW(),
        last_synced_at = NOW()
    WHERE id = p_draft_id
    RETURNING * INTO v_draft;

    RETURN v_draft;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get user's drafts
CREATE OR REPLACE FUNCTION public.get_form_drafts(
    p_form_type TEXT DEFAULT NULL,
    p_include_expired BOOLEAN DEFAULT false
)
RETURNS SETOF public.form_drafts AS $$
BEGIN
    RETURN QUERY
    SELECT *
    FROM public.form_drafts
    WHERE user_id = auth.uid()
      AND (p_form_type IS NULL OR form_type = p_form_type)
      AND (p_include_expired OR expires_at > NOW())
    ORDER BY updated_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get a specific draft
CREATE OR REPLACE FUNCTION public.get_form_draft(
    p_form_type TEXT,
    p_entity_id TEXT DEFAULT NULL
)
RETURNS public.form_drafts AS $$
BEGIN
    RETURN QUERY
    SELECT *
    FROM public.form_drafts
    WHERE user_id = auth.uid()
      AND form_type = p_form_type
      AND COALESCE(entity_id, '') = COALESCE(p_entity_id, '')
      AND expires_at > NOW()
    LIMIT 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Delete a draft
CREATE OR REPLACE FUNCTION public.delete_form_draft(
    p_draft_id UUID
)
RETURNS BOOLEAN AS $$
BEGIN
    DELETE FROM public.form_drafts
    WHERE id = p_draft_id AND user_id = auth.uid();

    RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Delete draft by form type
CREATE OR REPLACE FUNCTION public.delete_form_draft_by_type(
    p_form_type TEXT,
    p_entity_id TEXT DEFAULT NULL
)
RETURNS BOOLEAN AS $$
BEGIN
    DELETE FROM public.form_drafts
    WHERE user_id = auth.uid()
      AND form_type = p_form_type
      AND COALESCE(entity_id, '') = COALESCE(p_entity_id, '');

    RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Cleanup expired drafts
CREATE OR REPLACE FUNCTION public.cleanup_expired_drafts()
RETURNS INTEGER AS $$
DECLARE
    v_deleted INTEGER;
BEGIN
    DELETE FROM public.form_drafts
    WHERE expires_at < NOW();

    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- TRIGGER: Update timestamps
-- =============================================================================

CREATE OR REPLACE FUNCTION public.update_form_draft_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_form_draft_updated
BEFORE UPDATE ON public.form_drafts
FOR EACH ROW EXECUTE FUNCTION public.update_form_draft_timestamp();

-- =============================================================================
-- COMMENTS
-- =============================================================================

COMMENT ON TABLE public.form_drafts IS
'Cross-device form draft storage with version control and conflict detection';

COMMENT ON TABLE public.form_draft_history IS
'History of draft changes for conflict resolution';

COMMENT ON FUNCTION public.save_form_draft IS
'Save or update a form draft with automatic conflict detection';

COMMENT ON FUNCTION public.resolve_draft_conflict IS
'Resolve a draft conflict with merged fields';

COMMENT ON FUNCTION public.cleanup_expired_drafts IS
'Remove expired drafts - run via cron job';
