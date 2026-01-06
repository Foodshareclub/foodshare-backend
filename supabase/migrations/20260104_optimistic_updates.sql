-- =============================================================================
-- Phase 10: Optimistic Update Management Infrastructure
-- =============================================================================
-- Track optimistic updates for rollback and conflict resolution
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================================
-- OPTIMISTIC UPDATES TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.optimistic_updates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Context
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,

    -- Entity
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,

    -- State
    previous_state JSONB NOT NULL,
    optimistic_state JSONB NOT NULL,
    committed_state JSONB,

    -- Status
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending', 'committed', 'rolled_back', 'conflicted'
    )),

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    committed_at TIMESTAMPTZ,
    rolled_back_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '5 minutes'
);

-- =============================================================================
-- INDEXES
-- =============================================================================

CREATE INDEX idx_optimistic_user ON public.optimistic_updates(user_id, status, created_at DESC);
CREATE INDEX idx_optimistic_entity ON public.optimistic_updates(entity_type, entity_id, status);
CREATE INDEX idx_optimistic_expires ON public.optimistic_updates(expires_at) WHERE status = 'pending';

-- =============================================================================
-- RLS POLICIES
-- =============================================================================

ALTER TABLE public.optimistic_updates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own optimistic updates" ON public.optimistic_updates FOR ALL TO authenticated
    USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY "Service role manages all" ON public.optimistic_updates FOR ALL TO service_role USING (true);

-- =============================================================================
-- FUNCTIONS
-- =============================================================================

-- Create optimistic update
CREATE OR REPLACE FUNCTION public.create_optimistic_update(
    p_entity_type TEXT,
    p_entity_id TEXT,
    p_previous_state JSONB,
    p_optimistic_state JSONB,
    p_device_id TEXT
)
RETURNS UUID AS $$
DECLARE
    v_id UUID;
BEGIN
    INSERT INTO public.optimistic_updates (
        user_id, device_id, entity_type, entity_id,
        previous_state, optimistic_state
    ) VALUES (
        auth.uid(), p_device_id, p_entity_type, p_entity_id,
        p_previous_state, p_optimistic_state
    )
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Commit optimistic update
CREATE OR REPLACE FUNCTION public.commit_optimistic_update(
    p_update_id UUID,
    p_committed_state JSONB DEFAULT NULL
)
RETURNS BOOLEAN AS $$
BEGIN
    UPDATE public.optimistic_updates
    SET status = 'committed',
        committed_state = COALESCE(p_committed_state, optimistic_state),
        committed_at = NOW()
    WHERE id = p_update_id AND user_id = auth.uid() AND status = 'pending';
    RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Rollback optimistic update
CREATE OR REPLACE FUNCTION public.rollback_optimistic_update(p_update_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_previous JSONB;
BEGIN
    UPDATE public.optimistic_updates
    SET status = 'rolled_back', rolled_back_at = NOW()
    WHERE id = p_update_id AND user_id = auth.uid() AND status = 'pending'
    RETURNING previous_state INTO v_previous;
    RETURN v_previous;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Cleanup expired
CREATE OR REPLACE FUNCTION public.cleanup_expired_optimistic_updates()
RETURNS INTEGER AS $$
DECLARE
    v_count INTEGER;
BEGIN
    UPDATE public.optimistic_updates
    SET status = 'rolled_back', rolled_back_at = NOW()
    WHERE status = 'pending' AND expires_at < NOW();
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON TABLE public.optimistic_updates IS 'Tracks optimistic UI updates for rollback on failure';
