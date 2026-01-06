-- =============================================================================
-- Sync Version Functions
--
-- Implements optimistic concurrency control and sync versioning.
-- Enables efficient incremental sync for mobile clients.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Sync Version Tracking Table
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_versions (
    table_name TEXT PRIMARY KEY,
    current_version BIGINT NOT NULL DEFAULT 1,
    last_modified_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Initialize sync versions for key tables
INSERT INTO sync_versions (table_name, current_version)
VALUES
    ('posts', 1),
    ('profiles', 1),
    ('chat_rooms', 1),
    ('chat_messages', 1),
    ('notifications', 1),
    ('favorites', 1),
    ('reviews', 1),
    ('challenges', 1),
    ('forum_posts', 1)
ON CONFLICT (table_name) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Row-Level Version Column (Add to tables if not exists)
-- -----------------------------------------------------------------------------
-- Note: Run these ALTER TABLEs only if columns don't exist

DO $$
BEGIN
    -- Add version column to posts
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'posts' AND column_name = 'sync_version') THEN
        ALTER TABLE posts ADD COLUMN sync_version BIGINT DEFAULT 1;
    END IF;

    -- Add version column to profiles
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'profiles' AND column_name = 'sync_version') THEN
        ALTER TABLE profiles ADD COLUMN sync_version BIGINT DEFAULT 1;
    END IF;

    -- Add version column to chat_messages
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'chat_messages' AND column_name = 'sync_version') THEN
        ALTER TABLE chat_messages ADD COLUMN sync_version BIGINT DEFAULT 1;
    END IF;

    -- Add version column to notifications
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'notifications' AND column_name = 'sync_version') THEN
        ALTER TABLE notifications ADD COLUMN sync_version BIGINT DEFAULT 1;
    END IF;
END $$;

-- Indexes for sync queries
CREATE INDEX IF NOT EXISTS idx_posts_sync_version ON posts(sync_version);
CREATE INDEX IF NOT EXISTS idx_profiles_sync_version ON profiles(sync_version);
CREATE INDEX IF NOT EXISTS idx_chat_messages_sync_version ON chat_messages(sync_version);
CREATE INDEX IF NOT EXISTS idx_notifications_sync_version ON notifications(sync_version);

-- -----------------------------------------------------------------------------
-- Increment Version Trigger
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trigger_increment_sync_version()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_new_version BIGINT;
BEGIN
    -- Get next version for the table
    UPDATE sync_versions
    SET
        current_version = current_version + 1,
        last_modified_at = NOW()
    WHERE table_name = TG_TABLE_NAME
    RETURNING current_version INTO v_new_version;

    -- If no row exists, create it
    IF v_new_version IS NULL THEN
        INSERT INTO sync_versions (table_name, current_version)
        VALUES (TG_TABLE_NAME, 1)
        ON CONFLICT (table_name) DO UPDATE
        SET current_version = sync_versions.current_version + 1
        RETURNING current_version INTO v_new_version;
    END IF;

    -- Set version on the row
    NEW.sync_version := v_new_version;
    NEW.updated_at := NOW();

    RETURN NEW;
END;
$$;

-- Apply to key tables
DROP TRIGGER IF EXISTS trg_sync_version_posts ON posts;
CREATE TRIGGER trg_sync_version_posts
    BEFORE INSERT OR UPDATE ON posts
    FOR EACH ROW
    EXECUTE FUNCTION trigger_increment_sync_version();

DROP TRIGGER IF EXISTS trg_sync_version_profiles ON profiles;
CREATE TRIGGER trg_sync_version_profiles
    BEFORE INSERT OR UPDATE ON profiles
    FOR EACH ROW
    EXECUTE FUNCTION trigger_increment_sync_version();

DROP TRIGGER IF EXISTS trg_sync_version_messages ON chat_messages;
CREATE TRIGGER trg_sync_version_messages
    BEFORE INSERT OR UPDATE ON chat_messages
    FOR EACH ROW
    EXECUTE FUNCTION trigger_increment_sync_version();

DROP TRIGGER IF EXISTS trg_sync_version_notifications ON notifications;
CREATE TRIGGER trg_sync_version_notifications
    BEFORE INSERT OR UPDATE ON notifications
    FOR EACH ROW
    EXECUTE FUNCTION trigger_increment_sync_version();

-- -----------------------------------------------------------------------------
-- Get Changes Since Version
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_changes_since(
    p_table_name TEXT,
    p_since_version BIGINT,
    p_user_id UUID DEFAULT NULL,
    p_limit INTEGER DEFAULT 100
)
RETURNS TABLE (
    id UUID,
    data JSONB,
    sync_version BIGINT,
    operation TEXT,
    changed_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY EXECUTE format(
        'SELECT
            t.id,
            to_jsonb(t) as data,
            t.sync_version,
            CASE
                WHEN t.deleted_at IS NOT NULL THEN ''delete''
                WHEN t.sync_version = 1 THEN ''insert''
                ELSE ''update''
            END as operation,
            t.updated_at as changed_at
        FROM %I t
        WHERE t.sync_version > $1
        %s
        ORDER BY t.sync_version ASC
        LIMIT $2',
        p_table_name,
        CASE
            WHEN p_user_id IS NOT NULL THEN 'AND (t.user_id = $3 OR t.profile_id = $3)'
            ELSE ''
        END
    ) USING p_since_version, p_limit, p_user_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- Get Current Sync State
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_sync_state(p_user_id UUID DEFAULT NULL)
RETURNS TABLE (
    table_name TEXT,
    current_version BIGINT,
    last_modified_at TIMESTAMPTZ,
    pending_count BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT
        sv.table_name,
        sv.current_version,
        sv.last_modified_at,
        0::BIGINT as pending_count
    FROM sync_versions sv
    ORDER BY sv.table_name;
$$;

-- -----------------------------------------------------------------------------
-- Optimistic Lock Check
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_version_conflict(
    p_table_name TEXT,
    p_record_id UUID,
    p_expected_version BIGINT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
    v_current_version BIGINT;
BEGIN
    EXECUTE format(
        'SELECT sync_version FROM %I WHERE id = $1',
        p_table_name
    ) INTO v_current_version USING p_record_id;

    RETURN v_current_version = p_expected_version;
END;
$$;

-- -----------------------------------------------------------------------------
-- Update with Version Check
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_with_version_check(
    p_table_name TEXT,
    p_record_id UUID,
    p_expected_version BIGINT,
    p_updates JSONB
)
RETURNS TABLE (
    success BOOLEAN,
    new_version BIGINT,
    error TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_current_version BIGINT;
    v_new_version BIGINT;
    v_update_pairs TEXT;
    v_key TEXT;
    v_value JSONB;
BEGIN
    -- Check current version
    EXECUTE format(
        'SELECT sync_version FROM %I WHERE id = $1 FOR UPDATE',
        p_table_name
    ) INTO v_current_version USING p_record_id;

    IF v_current_version IS NULL THEN
        RETURN QUERY SELECT FALSE, NULL::BIGINT, 'Record not found';
        RETURN;
    END IF;

    IF v_current_version != p_expected_version THEN
        RETURN QUERY SELECT FALSE, v_current_version, 'Version conflict';
        RETURN;
    END IF;

    -- Build update statement
    v_update_pairs := '';
    FOR v_key, v_value IN SELECT * FROM jsonb_each(p_updates)
    LOOP
        IF v_update_pairs != '' THEN
            v_update_pairs := v_update_pairs || ', ';
        END IF;
        v_update_pairs := v_update_pairs || format('%I = %L', v_key, v_value #>> '{}');
    END LOOP;

    -- Execute update (trigger will increment version)
    EXECUTE format(
        'UPDATE %I SET %s WHERE id = $1 RETURNING sync_version',
        p_table_name,
        v_update_pairs
    ) INTO v_new_version USING p_record_id;

    RETURN QUERY SELECT TRUE, v_new_version, NULL::TEXT;
END;
$$;

-- -----------------------------------------------------------------------------
-- Batch Sync Function for Mobile
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sync_batch(
    p_user_id UUID,
    p_versions JSONB -- {"posts": 100, "profiles": 50, ...}
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
    v_result JSONB := '{}'::JSONB;
    v_table TEXT;
    v_since_version BIGINT;
    v_changes JSONB;
BEGIN
    FOR v_table, v_since_version IN
        SELECT key, (value)::BIGINT
        FROM jsonb_each_text(p_versions)
    LOOP
        SELECT jsonb_agg(row_to_json(changes))
        INTO v_changes
        FROM get_changes_since(v_table, v_since_version, p_user_id, 100) changes;

        v_result := v_result || jsonb_build_object(v_table, COALESCE(v_changes, '[]'::JSONB));
    END LOOP;

    -- Add current versions
    v_result := v_result || jsonb_build_object(
        '_versions',
        (SELECT jsonb_object_agg(table_name, current_version) FROM sync_versions)
    );

    RETURN v_result;
END;
$$;

-- -----------------------------------------------------------------------------
-- Mark Records for Deletion (Soft Delete)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION soft_delete_record(
    p_table_name TEXT,
    p_record_id UUID,
    p_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_success BOOLEAN;
BEGIN
    EXECUTE format(
        'UPDATE %I SET deleted_at = NOW(), deleted_by = $2, is_active = FALSE WHERE id = $1 RETURNING TRUE',
        p_table_name
    ) INTO v_success USING p_record_id, p_user_id;

    RETURN COALESCE(v_success, FALSE);
END;
$$;

-- -----------------------------------------------------------------------------
-- Get Deleted Records Since (for sync cleanup)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_deleted_since(
    p_table_name TEXT,
    p_since TIMESTAMPTZ,
    p_limit INTEGER DEFAULT 100
)
RETURNS TABLE (
    id UUID,
    deleted_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY EXECUTE format(
        'SELECT id, deleted_at FROM %I WHERE deleted_at > $1 ORDER BY deleted_at ASC LIMIT $2',
        p_table_name
    ) USING p_since, p_limit;
END;
$$;

COMMENT ON TABLE sync_versions IS 'Tracks current sync version per table for incremental sync';
COMMENT ON FUNCTION get_changes_since IS 'Returns changes since a given sync version';
COMMENT ON FUNCTION update_with_version_check IS 'Updates a record with optimistic concurrency control';
COMMENT ON FUNCTION sync_batch IS 'Batch sync function for mobile clients';
COMMENT ON FUNCTION soft_delete_record IS 'Marks a record as deleted for sync propagation';
