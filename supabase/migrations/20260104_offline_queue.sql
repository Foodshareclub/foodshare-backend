-- =============================================================================
-- Phase 9: Offline Queue Orchestration Infrastructure
-- =============================================================================
-- Pending operations tracking and replay for offline-first functionality
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================================
-- PENDING OPERATIONS TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.pending_operations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Owner
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,

    -- Operation details
    operation_type TEXT NOT NULL CHECK (operation_type IN (
        'create_listing', 'update_listing', 'delete_listing',
        'send_message', 'update_profile', 'create_review',
        'toggle_favorite', 'create_forum_post', 'create_forum_comment'
    )),
    entity_type TEXT NOT NULL,
    entity_id TEXT,

    -- Payload
    payload JSONB NOT NULL,

    -- Dependencies (other operation IDs that must complete first)
    depends_on UUID[],

    -- Status
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending', 'processing', 'completed', 'failed', 'conflicted'
    )),
    error_message TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 3,

    -- Conflict resolution
    conflict_data JSONB,
    conflict_resolution TEXT CHECK (conflict_resolution IN ('client_wins', 'server_wins', 'merge', 'manual')),

    -- Ordering
    sequence_number SERIAL,
    priority INTEGER NOT NULL DEFAULT 0,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    synced_at TIMESTAMPTZ
);

-- =============================================================================
-- OPERATION SYNC LOG
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.operation_sync_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    operation_id UUID REFERENCES public.pending_operations(id) ON DELETE SET NULL,
    user_id UUID NOT NULL,
    device_id TEXT NOT NULL,

    action TEXT NOT NULL CHECK (action IN ('enqueue', 'process', 'complete', 'fail', 'conflict', 'resolve')),
    details JSONB,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- INDEXES
-- =============================================================================

CREATE INDEX idx_pending_ops_user ON public.pending_operations(user_id, status, sequence_number);
CREATE INDEX idx_pending_ops_pending ON public.pending_operations(status, priority DESC, sequence_number)
    WHERE status = 'pending';
CREATE INDEX idx_pending_ops_device ON public.pending_operations(device_id, created_at DESC);

CREATE INDEX idx_sync_log_user ON public.operation_sync_log(user_id, created_at DESC);
CREATE INDEX idx_sync_log_operation ON public.operation_sync_log(operation_id) WHERE operation_id IS NOT NULL;

-- =============================================================================
-- RLS POLICIES
-- =============================================================================

ALTER TABLE public.pending_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operation_sync_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own operations" ON public.pending_operations FOR ALL TO authenticated
    USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users view own sync log" ON public.operation_sync_log FOR SELECT TO authenticated
    USING (user_id = auth.uid());

CREATE POLICY "Service role manages all" ON public.pending_operations FOR ALL TO service_role USING (true);
CREATE POLICY "Service role manages log" ON public.operation_sync_log FOR ALL TO service_role USING (true);

-- =============================================================================
-- FUNCTIONS
-- =============================================================================

-- Enqueue operation
CREATE OR REPLACE FUNCTION public.enqueue_operation(
    p_operation_type TEXT,
    p_entity_type TEXT,
    p_payload JSONB,
    p_device_id TEXT,
    p_entity_id TEXT DEFAULT NULL,
    p_depends_on UUID[] DEFAULT NULL,
    p_priority INTEGER DEFAULT 0
)
RETURNS UUID AS $$
DECLARE
    v_id UUID;
BEGIN
    INSERT INTO public.pending_operations (
        user_id, device_id, operation_type, entity_type, entity_id,
        payload, depends_on, priority
    ) VALUES (
        auth.uid(), p_device_id, p_operation_type, p_entity_type, p_entity_id,
        p_payload, p_depends_on, p_priority
    )
    RETURNING id INTO v_id;

    -- Log
    INSERT INTO public.operation_sync_log (operation_id, user_id, device_id, action, details)
    VALUES (v_id, auth.uid(), p_device_id, 'enqueue', jsonb_build_object('type', p_operation_type));

    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get pending operations for sync
CREATE OR REPLACE FUNCTION public.get_pending_operations(
    p_device_id TEXT,
    p_limit INTEGER DEFAULT 50
)
RETURNS SETOF public.pending_operations AS $$
BEGIN
    RETURN QUERY
    SELECT *
    FROM public.pending_operations
    WHERE user_id = auth.uid()
      AND status = 'pending'
      AND (depends_on IS NULL OR NOT EXISTS (
          SELECT 1 FROM public.pending_operations dep
          WHERE dep.id = ANY(pending_operations.depends_on)
            AND dep.status != 'completed'
      ))
    ORDER BY priority DESC, sequence_number
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Mark operation completed
CREATE OR REPLACE FUNCTION public.complete_operation(
    p_operation_id UUID,
    p_result JSONB DEFAULT NULL
)
RETURNS BOOLEAN AS $$
BEGIN
    UPDATE public.pending_operations
    SET status = 'completed',
        processed_at = NOW(),
        synced_at = NOW()
    WHERE id = p_operation_id AND user_id = auth.uid();

    INSERT INTO public.operation_sync_log (operation_id, user_id, device_id, action, details)
    SELECT p_operation_id, user_id, device_id, 'complete', p_result
    FROM public.pending_operations WHERE id = p_operation_id;

    RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Replay all pending operations (returns operations in dependency order)
CREATE OR REPLACE FUNCTION public.replay_operations(p_device_id TEXT)
RETURNS TABLE (
    operation_id UUID,
    operation_type TEXT,
    entity_type TEXT,
    payload JSONB,
    sequence_number INTEGER
) AS $$
BEGIN
    RETURN QUERY
    WITH RECURSIVE ordered_ops AS (
        SELECT o.*, 0 as depth
        FROM public.pending_operations o
        WHERE o.user_id = auth.uid() AND o.status = 'pending' AND o.depends_on IS NULL

        UNION ALL

        SELECT o.*, oo.depth + 1
        FROM public.pending_operations o
        JOIN ordered_ops oo ON oo.id = ANY(o.depends_on)
        WHERE o.user_id = auth.uid() AND o.status = 'pending'
    )
    SELECT DISTINCT o.id, o.operation_type, o.entity_type, o.payload, o.sequence_number
    FROM ordered_ops o
    ORDER BY o.sequence_number;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON TABLE public.pending_operations IS 'Offline operations queue with dependency tracking';
COMMENT ON TABLE public.operation_sync_log IS 'Audit log for operation sync events';
