-- =============================================================================
-- Audit Trail Triggers
-- =============================================================================
-- Creates comprehensive audit logging for sensitive tables.
-- Tracks all INSERT, UPDATE, DELETE operations with:
-- - Changed data (old/new values)
-- - User who made the change
-- - Correlation ID for distributed tracing
-- - Timestamp
-- =============================================================================

-- Create audit schema if not exists
CREATE SCHEMA IF NOT EXISTS audit;

-- =============================================================================
-- Audit Log Table
-- =============================================================================

CREATE TABLE IF NOT EXISTS audit.logged_actions (
  id BIGSERIAL PRIMARY KEY,
  table_name TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
  old_data JSONB,
  new_data JSONB,
  changed_fields TEXT[], -- List of fields that changed (for UPDATE)
  changed_by UUID REFERENCES auth.users(id),
  correlation_id TEXT, -- For distributed tracing
  client_ip INET,
  user_agent TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Indexes for common queries
  CONSTRAINT valid_data CHECK (
    (action = 'INSERT' AND old_data IS NULL AND new_data IS NOT NULL) OR
    (action = 'UPDATE' AND old_data IS NOT NULL AND new_data IS NOT NULL) OR
    (action = 'DELETE' AND old_data IS NOT NULL AND new_data IS NULL)
  )
);

-- Partition by month for better performance
-- Note: In production, you'd create partitions for each month
CREATE INDEX IF NOT EXISTS idx_audit_logged_actions_table_action
  ON audit.logged_actions(table_name, action);

CREATE INDEX IF NOT EXISTS idx_audit_logged_actions_changed_by
  ON audit.logged_actions(changed_by);

CREATE INDEX IF NOT EXISTS idx_audit_logged_actions_changed_at
  ON audit.logged_actions(changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logged_actions_correlation
  ON audit.logged_actions(correlation_id)
  WHERE correlation_id IS NOT NULL;

-- =============================================================================
-- Generic Audit Trigger Function
-- =============================================================================

CREATE OR REPLACE FUNCTION audit.log_changes()
RETURNS TRIGGER AS $$
DECLARE
  v_old_data JSONB;
  v_new_data JSONB;
  v_changed_fields TEXT[];
  v_correlation_id TEXT;
  v_client_ip INET;
  v_user_agent TEXT;
BEGIN
  -- Get correlation ID from session config (set by Edge Functions)
  v_correlation_id := current_setting('app.correlation_id', true);

  -- Get client info from session config (if available)
  v_client_ip := NULLIF(current_setting('app.client_ip', true), '')::INET;
  v_user_agent := current_setting('app.user_agent', true);

  -- Handle different operations
  IF TG_OP = 'INSERT' THEN
    v_new_data := to_jsonb(NEW);

    INSERT INTO audit.logged_actions (
      table_name, action, old_data, new_data, changed_fields,
      changed_by, correlation_id, client_ip, user_agent
    ) VALUES (
      TG_TABLE_NAME, 'INSERT', NULL, v_new_data, NULL,
      auth.uid(), v_correlation_id, v_client_ip, v_user_agent
    );

    RETURN NEW;

  ELSIF TG_OP = 'UPDATE' THEN
    v_old_data := to_jsonb(OLD);
    v_new_data := to_jsonb(NEW);

    -- Calculate changed fields
    SELECT array_agg(key) INTO v_changed_fields
    FROM (
      SELECT key
      FROM jsonb_each(v_new_data)
      WHERE v_old_data->key IS DISTINCT FROM v_new_data->key
    ) changed;

    -- Only log if something actually changed
    IF v_changed_fields IS NOT NULL AND array_length(v_changed_fields, 1) > 0 THEN
      INSERT INTO audit.logged_actions (
        table_name, action, old_data, new_data, changed_fields,
        changed_by, correlation_id, client_ip, user_agent
      ) VALUES (
        TG_TABLE_NAME, 'UPDATE', v_old_data, v_new_data, v_changed_fields,
        auth.uid(), v_correlation_id, v_client_ip, v_user_agent
      );
    END IF;

    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    v_old_data := to_jsonb(OLD);

    INSERT INTO audit.logged_actions (
      table_name, action, old_data, new_data, changed_fields,
      changed_by, correlation_id, client_ip, user_agent
    ) VALUES (
      TG_TABLE_NAME, 'DELETE', v_old_data, NULL, NULL,
      auth.uid(), v_correlation_id, v_client_ip, v_user_agent
    );

    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- Apply Triggers to Sensitive Tables
-- =============================================================================

-- Posts (listings)
DROP TRIGGER IF EXISTS audit_posts ON posts;
CREATE TRIGGER audit_posts
  AFTER INSERT OR UPDATE OR DELETE ON posts
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

-- Profiles
DROP TRIGGER IF EXISTS audit_profiles ON profiles;
CREATE TRIGGER audit_profiles
  AFTER UPDATE OR DELETE ON profiles
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

-- Rooms (chat)
DROP TRIGGER IF EXISTS audit_rooms ON rooms;
CREATE TRIGGER audit_rooms
  AFTER INSERT OR UPDATE OR DELETE ON rooms
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

-- Device tokens (security-sensitive)
DROP TRIGGER IF EXISTS audit_device_tokens ON device_tokens;
CREATE TRIGGER audit_device_tokens
  AFTER INSERT OR DELETE ON device_tokens
  FOR EACH ROW EXECUTE FUNCTION audit.log_changes();

-- =============================================================================
-- Audit Query Helpers
-- =============================================================================

-- Get audit history for a specific record
CREATE OR REPLACE FUNCTION audit.get_record_history(
  p_table_name TEXT,
  p_record_id UUID,
  p_limit INT DEFAULT 50
)
RETURNS TABLE (
  action TEXT,
  changed_fields TEXT[],
  old_data JSONB,
  new_data JSONB,
  changed_by UUID,
  changed_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    la.action,
    la.changed_fields,
    la.old_data,
    la.new_data,
    la.changed_by,
    la.changed_at
  FROM audit.logged_actions la
  WHERE la.table_name = p_table_name
    AND (
      (la.new_data->>'id')::UUID = p_record_id
      OR (la.old_data->>'id')::UUID = p_record_id
    )
  ORDER BY la.changed_at DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get recent audit activity for a user
CREATE OR REPLACE FUNCTION audit.get_user_activity(
  p_user_id UUID,
  p_since TIMESTAMPTZ DEFAULT NOW() - INTERVAL '7 days',
  p_limit INT DEFAULT 100
)
RETURNS TABLE (
  table_name TEXT,
  action TEXT,
  record_id UUID,
  changed_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    la.table_name,
    la.action,
    COALESCE(
      (la.new_data->>'id')::UUID,
      (la.old_data->>'id')::UUID
    ) AS record_id,
    la.changed_at
  FROM audit.logged_actions la
  WHERE la.changed_by = p_user_id
    AND la.changed_at >= p_since
  ORDER BY la.changed_at DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- Audit Log Cleanup (for data retention)
-- =============================================================================

-- Cleanup old audit logs (call from scheduled job)
CREATE OR REPLACE FUNCTION audit.cleanup_old_logs(
  p_retention_days INT DEFAULT 90
)
RETURNS INT AS $$
DECLARE
  v_deleted INT;
BEGIN
  DELETE FROM audit.logged_actions
  WHERE changed_at < NOW() - (p_retention_days || ' days')::INTERVAL;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN v_deleted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- RLS Policies for Audit Log
-- =============================================================================

ALTER TABLE audit.logged_actions ENABLE ROW LEVEL SECURITY;

-- Only admins can read audit logs
CREATE POLICY audit_logs_admin_read ON audit.logged_actions
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_roles ur
      JOIN roles r ON ur.role_id = r.id
      WHERE ur.user_id = auth.uid()
        AND r.name = 'admin'
    )
  );

-- Users can see their own activity
CREATE POLICY audit_logs_own_activity ON audit.logged_actions
  FOR SELECT
  TO authenticated
  USING (changed_by = auth.uid());

COMMENT ON TABLE audit.logged_actions IS 'Comprehensive audit log for tracking all changes to sensitive tables';
COMMENT ON FUNCTION audit.log_changes IS 'Generic trigger function that logs all changes to audit.logged_actions';
