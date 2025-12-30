-- ============================================================================
-- Delta Sync Infrastructure
-- Incremental data sync with version tracking and conflict resolution
-- ============================================================================

-- Drop existing objects if they exist
DROP TABLE IF EXISTS public.pending_operations CASCADE;
DROP TABLE IF EXISTS public.sync_checkpoints CASCADE;
DROP SEQUENCE IF EXISTS public.sync_version_seq CASCADE;
DROP FUNCTION IF EXISTS public.update_sync_version();
DROP FUNCTION IF EXISTS public.get_delta_sync(uuid, text[]);
DROP FUNCTION IF EXISTS public.apply_pending_operation(uuid);

-- ============================================================================
-- Global sync version sequence
-- ============================================================================

CREATE SEQUENCE IF NOT EXISTS public.sync_version_seq START 1;

COMMENT ON SEQUENCE public.sync_version_seq IS 'Global version counter for sync tracking';

-- ============================================================================
-- Add sync_version to syncable tables
-- ============================================================================

-- Add sync_version column to posts
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'posts' AND column_name = 'sync_version') THEN
    ALTER TABLE public.posts ADD COLUMN sync_version bigint DEFAULT nextval('sync_version_seq');
  END IF;
END $$;

-- Add sync_version column to notifications
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'notifications' AND column_name = 'sync_version') THEN
    ALTER TABLE public.notifications ADD COLUMN sync_version bigint DEFAULT nextval('sync_version_seq');
  END IF;
END $$;

-- Add sync_version column to rooms
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'rooms' AND column_name = 'sync_version') THEN
    ALTER TABLE public.rooms ADD COLUMN sync_version bigint DEFAULT nextval('sync_version_seq');
  END IF;
END $$;

-- Create indexes for efficient sync queries
CREATE INDEX IF NOT EXISTS idx_posts_sync_version ON public.posts(sync_version);
CREATE INDEX IF NOT EXISTS idx_notifications_sync_version ON public.notifications(sync_version);
CREATE INDEX IF NOT EXISTS idx_rooms_sync_version ON public.rooms(sync_version);

-- ============================================================================
-- update_sync_version - Trigger function to auto-update sync version
-- ============================================================================

CREATE OR REPLACE FUNCTION public.update_sync_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.sync_version := nextval('sync_version_seq');
  RETURN NEW;
END;
$$;

-- Create triggers for automatic sync version updates
DROP TRIGGER IF EXISTS trg_posts_sync_version ON public.posts;
CREATE TRIGGER trg_posts_sync_version
  BEFORE INSERT OR UPDATE ON public.posts
  FOR EACH ROW EXECUTE FUNCTION update_sync_version();

DROP TRIGGER IF EXISTS trg_notifications_sync_version ON public.notifications;
CREATE TRIGGER trg_notifications_sync_version
  BEFORE INSERT OR UPDATE ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION update_sync_version();

DROP TRIGGER IF EXISTS trg_rooms_sync_version ON public.rooms;
CREATE TRIGGER trg_rooms_sync_version
  BEFORE INSERT OR UPDATE ON public.rooms
  FOR EACH ROW EXECUTE FUNCTION update_sync_version();

-- ============================================================================
-- sync_checkpoints - Tracks last sync point per user per table
-- ============================================================================

CREATE TABLE public.sync_checkpoints (
  user_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
  table_name text NOT NULL,
  last_sync_version bigint NOT NULL DEFAULT 0,
  last_sync_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, table_name)
);

CREATE INDEX idx_sync_checkpoints_user ON public.sync_checkpoints(user_id);

COMMENT ON TABLE public.sync_checkpoints IS 'Tracks last sync point per user per table';

-- ============================================================================
-- pending_operations - Queue for optimistic update conflict resolution
-- ============================================================================

CREATE TABLE public.pending_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  operation_type text NOT NULL CHECK (operation_type IN ('create', 'update', 'delete')),
  table_name text NOT NULL,
  record_id uuid,
  payload jsonb NOT NULL,
  client_timestamp timestamptz NOT NULL,
  server_timestamp timestamptz NOT NULL DEFAULT NOW(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'conflict', 'rejected', 'resolved')),
  conflict_resolution jsonb,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pending_ops_user ON public.pending_operations(user_id, status);
CREATE INDEX idx_pending_ops_record ON public.pending_operations(table_name, record_id);

COMMENT ON TABLE public.pending_operations IS 'Queue for optimistic update conflict resolution';

-- ============================================================================
-- get_delta_sync - Returns changes since last sync
-- ============================================================================

/**
 * get_delta_sync - Returns changes since user's last sync
 *
 * Features:
 * - Returns only modified records since last checkpoint
 * - Updates checkpoint atomically
 * - Supports multiple tables in one call
 *
 * @param p_user_id - The user's ID
 * @param p_tables - Array of tables to sync (default: notifications, rooms)
 *
 * @returns JSONB with changes per table
 */
CREATE OR REPLACE FUNCTION public.get_delta_sync(
  p_user_id uuid,
  p_tables text[] DEFAULT ARRAY['notifications', 'rooms']
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb := '{}'::jsonb;
  v_table text;
  v_checkpoint bigint;
  v_current_version bigint;
  v_changes jsonb;
  v_change_count integer := 0;
BEGIN
  -- Get current max sync version
  SELECT MAX(sync_version) INTO v_current_version
  FROM (
    SELECT sync_version FROM posts WHERE sync_version IS NOT NULL
    UNION ALL
    SELECT sync_version FROM notifications WHERE sync_version IS NOT NULL
    UNION ALL
    SELECT sync_version FROM rooms WHERE sync_version IS NOT NULL
  ) all_versions;

  v_current_version := COALESCE(v_current_version, 0);

  -- Process each requested table
  FOREACH v_table IN ARRAY p_tables
  LOOP
    -- Get checkpoint for this table
    SELECT last_sync_version INTO v_checkpoint
    FROM sync_checkpoints
    WHERE user_id = p_user_id AND table_name = v_table;

    v_checkpoint := COALESCE(v_checkpoint, 0);

    -- Get changes based on table
    CASE v_table
      WHEN 'notifications' THEN
        SELECT COALESCE(jsonb_agg(
          jsonb_build_object(
            'id', n.id,
            'title', n.notification_title,
            'text', n.notification_text,
            'timestamp', n.timestamp,
            'readAt', n.read_at,
            'screen', n.initial_page_name,
            'params', n.parameter_data,
            'syncVersion', n.sync_version,
            '_operation', 'upsert'
          )
        ), '[]'::jsonb) INTO v_changes
        FROM notifications n
        WHERE n.profile_id = p_user_id
          AND n.sync_version > v_checkpoint;

      WHEN 'rooms' THEN
        SELECT COALESCE(jsonb_agg(
          jsonb_build_object(
            'id', r.id,
            'postId', r.post_id,
            'sharer', r.sharer,
            'requester', r.requester,
            'lastMessage', r.last_message,
            'lastMessageTime', r.last_message_time,
            'lastMessageSentBy', r.last_message_sent_by,
            'syncVersion', r.sync_version,
            '_operation', 'upsert'
          )
        ), '[]'::jsonb) INTO v_changes
        FROM rooms r
        WHERE (r.sharer = p_user_id OR r.requester = p_user_id)
          AND r.sync_version > v_checkpoint;

      WHEN 'posts' THEN
        SELECT COALESCE(jsonb_agg(
          jsonb_build_object(
            'id', fi.id,
            'postName', fi.post_name,
            'description', fi.description,
            'images', fi.images,
            'postType', fi.post_type,
            'isActive', fi.is_active,
            'latitude', fi.latitude,
            'longitude', fi.longitude,
            'pickupAddress', fi.pickup_address,
            'createdAt', fi.created_at,
            'updatedAt', fi.updated_at,
            'syncVersion', fi.sync_version,
            '_operation', CASE WHEN fi.deleted_at IS NOT NULL THEN 'delete' ELSE 'upsert' END
          )
        ), '[]'::jsonb) INTO v_changes
        FROM posts fi
        WHERE fi.profile_id = p_user_id
          AND fi.sync_version > v_checkpoint;

      ELSE
        v_changes := '[]'::jsonb;
    END CASE;

    v_result := v_result || jsonb_build_object(v_table, v_changes);
    v_change_count := v_change_count + jsonb_array_length(v_changes);

    -- Update checkpoint
    INSERT INTO sync_checkpoints (user_id, table_name, last_sync_version, last_sync_at)
    VALUES (p_user_id, v_table, v_current_version, NOW())
    ON CONFLICT (user_id, table_name) DO UPDATE
    SET last_sync_version = EXCLUDED.last_sync_version,
        last_sync_at = EXCLUDED.last_sync_at;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'changes', v_result,
    'stats', jsonb_build_object(
      'totalChanges', v_change_count,
      'currentVersion', v_current_version
    ),
    'meta', jsonb_build_object(
      'timestamp', NOW(),
      'tables', p_tables
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_delta_sync(uuid, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_delta_sync(uuid, text[]) TO service_role;

COMMENT ON FUNCTION public.get_delta_sync IS 'Returns changes since last sync with automatic checkpoint update';

-- ============================================================================
-- submit_pending_operation - Submits client operation for conflict check
-- ============================================================================

/**
 * submit_pending_operation - Submits an operation for conflict detection
 *
 * @param p_user_id - The user's ID
 * @param p_operation_type - 'create', 'update', or 'delete'
 * @param p_table_name - Target table
 * @param p_record_id - Record ID (null for create)
 * @param p_payload - Operation payload
 * @param p_client_timestamp - Client's timestamp when change was made
 *
 * @returns JSONB with operation status
 */
CREATE OR REPLACE FUNCTION public.submit_pending_operation(
  p_user_id uuid,
  p_operation_type text,
  p_table_name text,
  p_record_id uuid,
  p_payload jsonb,
  p_client_timestamp timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_operation_id uuid;
  v_current_record record;
  v_has_conflict boolean := false;
  v_server_timestamp timestamptz;
BEGIN
  -- Check for potential conflicts on update/delete
  IF p_operation_type IN ('update', 'delete') AND p_record_id IS NOT NULL THEN
    CASE p_table_name
      WHEN 'posts' THEN
        SELECT updated_at INTO v_server_timestamp
        FROM posts
        WHERE id = p_record_id AND profile_id = p_user_id;

      WHEN 'rooms' THEN
        SELECT last_message_time INTO v_server_timestamp
        FROM rooms
        WHERE id = p_record_id
          AND (sharer = p_user_id OR requester = p_user_id);

      ELSE
        v_server_timestamp := NULL;
    END CASE;

    -- Check if server has newer changes
    IF v_server_timestamp IS NOT NULL AND v_server_timestamp > p_client_timestamp THEN
      v_has_conflict := true;
    END IF;
  END IF;

  -- Insert pending operation
  INSERT INTO pending_operations (
    user_id, operation_type, table_name, record_id,
    payload, client_timestamp, status
  ) VALUES (
    p_user_id, p_operation_type, p_table_name, p_record_id,
    p_payload, p_client_timestamp,
    CASE WHEN v_has_conflict THEN 'conflict' ELSE 'pending' END
  )
  RETURNING id INTO v_operation_id;

  IF v_has_conflict THEN
    -- Get current server state for resolution
    UPDATE pending_operations
    SET conflict_resolution = jsonb_build_object(
      'serverTimestamp', v_server_timestamp,
      'clientTimestamp', p_client_timestamp,
      'needsResolution', true
    )
    WHERE id = v_operation_id;

    RETURN jsonb_build_object(
      'success', false,
      'operationId', v_operation_id,
      'conflict', true,
      'serverTimestamp', v_server_timestamp,
      'clientTimestamp', p_client_timestamp,
      'message', 'Server has newer changes. Please resolve conflict.'
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'operationId', v_operation_id,
    'status', 'pending',
    'message', 'Operation queued for processing'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_pending_operation(uuid, text, text, uuid, jsonb, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_pending_operation(uuid, text, text, uuid, jsonb, timestamptz) TO service_role;

COMMENT ON FUNCTION public.submit_pending_operation IS 'Submits client operation for conflict detection';

-- ============================================================================
-- apply_pending_operation - Applies a pending operation
-- ============================================================================

/**
 * apply_pending_operation - Applies a queued operation
 *
 * @param p_operation_id - The operation ID
 *
 * @returns JSONB with result
 */
CREATE OR REPLACE FUNCTION public.apply_pending_operation(p_operation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_op record;
  v_result jsonb;
BEGIN
  SELECT * INTO v_op
  FROM pending_operations
  WHERE id = p_operation_id;

  IF v_op IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'OPERATION_NOT_FOUND');
  END IF;

  IF v_op.status = 'conflict' THEN
    RETURN jsonb_build_object('success', false, 'error', 'CONFLICT_UNRESOLVED');
  END IF;

  IF v_op.status != 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'ALREADY_PROCESSED');
  END IF;

  -- Apply operation based on type and table
  BEGIN
    CASE v_op.table_name
      WHEN 'posts' THEN
        CASE v_op.operation_type
          WHEN 'create' THEN
            INSERT INTO posts (profile_id, post_name, description, images, post_type, latitude, longitude, pickup_address)
            SELECT
              v_op.user_id,
              v_op.payload->>'postName',
              v_op.payload->>'description',
              ARRAY(SELECT jsonb_array_elements_text(v_op.payload->'images')),
              COALESCE(v_op.payload->>'postType', 'food'),
              (v_op.payload->>'latitude')::double precision,
              (v_op.payload->>'longitude')::double precision,
              v_op.payload->>'pickupAddress';

          WHEN 'update' THEN
            UPDATE posts
            SET
              post_name = COALESCE(v_op.payload->>'postName', post_name),
              description = COALESCE(v_op.payload->>'description', description),
              is_active = COALESCE((v_op.payload->>'isActive')::boolean, is_active),
              updated_at = NOW()
            WHERE id = v_op.record_id AND profile_id = v_op.user_id;

          WHEN 'delete' THEN
            UPDATE posts
            SET deleted_at = NOW(), is_active = false
            WHERE id = v_op.record_id AND profile_id = v_op.user_id;
        END CASE;

      ELSE
        RAISE EXCEPTION 'Unsupported table: %', v_op.table_name;
    END CASE;

    -- Mark as applied
    UPDATE pending_operations
    SET status = 'applied'
    WHERE id = p_operation_id;

    RETURN jsonb_build_object('success', true, 'status', 'applied');

  EXCEPTION WHEN OTHERS THEN
    UPDATE pending_operations
    SET status = 'rejected', error_message = SQLERRM
    WHERE id = p_operation_id;

    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
  END;
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_pending_operation(uuid) TO service_role;

COMMENT ON FUNCTION public.apply_pending_operation IS 'Applies a pending operation with conflict resolution';

-- ============================================================================
-- get_sync_status - Returns sync status for a user
-- ============================================================================

/**
 * get_sync_status - Returns user's sync status across tables
 *
 * @param p_user_id - The user's ID
 *
 * @returns JSONB with sync status per table
 */
CREATE OR REPLACE FUNCTION public.get_sync_status(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_checkpoints jsonb;
  v_pending_ops integer;
  v_current_version bigint;
BEGIN
  -- Get current version
  SELECT MAX(sync_version) INTO v_current_version
  FROM (
    SELECT sync_version FROM posts WHERE sync_version IS NOT NULL LIMIT 1
    UNION ALL
    SELECT sync_version FROM notifications WHERE sync_version IS NOT NULL LIMIT 1
    UNION ALL
    SELECT sync_version FROM rooms WHERE sync_version IS NOT NULL LIMIT 1
  ) v;

  -- Get checkpoints
  SELECT COALESCE(jsonb_object_agg(
    table_name,
    jsonb_build_object(
      'lastVersion', last_sync_version,
      'lastSyncAt', last_sync_at,
      'behindBy', v_current_version - last_sync_version
    )
  ), '{}'::jsonb) INTO v_checkpoints
  FROM sync_checkpoints
  WHERE user_id = p_user_id;

  -- Get pending operations count
  SELECT COUNT(*) INTO v_pending_ops
  FROM pending_operations
  WHERE user_id = p_user_id AND status IN ('pending', 'conflict');

  RETURN jsonb_build_object(
    'success', true,
    'currentVersion', v_current_version,
    'checkpoints', v_checkpoints,
    'pendingOperations', v_pending_ops,
    'meta', jsonb_build_object('timestamp', NOW())
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_sync_status(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_sync_status(uuid) TO service_role;

COMMENT ON FUNCTION public.get_sync_status IS 'Returns user sync status across tables';
