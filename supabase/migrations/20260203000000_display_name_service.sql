-- =============================================================================
-- Display Name Service Database Migration
-- =============================================================================
-- Creates infrastructure for enterprise display name management:
-- - Admin override table for display name corrections
-- - RPC functions for optimized lookups
-- - Batch lookup support
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Display Name Overrides Table
-- Allows admins to set corrected display names for users
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS display_name_overrides (
  user_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  display_name text NOT NULL CHECK (length(trim(display_name)) >= 2 AND length(display_name) <= 100),
  reason text NOT NULL CHECK (length(reason) >= 1),
  overridden_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Index for efficient expiration checks
CREATE INDEX IF NOT EXISTS idx_display_name_overrides_expires
  ON display_name_overrides(expires_at)
  WHERE expires_at IS NOT NULL;

-- Trigger to update updated_at
CREATE OR REPLACE FUNCTION update_display_name_override_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_display_name_override_updated_at ON display_name_overrides;
CREATE TRIGGER trigger_display_name_override_updated_at
  BEFORE UPDATE ON display_name_overrides
  FOR EACH ROW
  EXECUTE FUNCTION update_display_name_override_updated_at();

-- Enable RLS
ALTER TABLE display_name_overrides ENABLE ROW LEVEL SECURITY;

-- RLS Policies
-- Users can read their own override
CREATE POLICY "Users can view own override"
  ON display_name_overrides
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Service role can manage all overrides
CREATE POLICY "Service role full access"
  ON display_name_overrides
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- RPC: Get Display Name Data for Single User
-- Returns profile and override data for efficient client-side processing
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_display_name_data(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_profile jsonb;
  v_override jsonb;
BEGIN
  -- Get profile data
  SELECT jsonb_build_object(
    'id', id,
    'display_name', display_name,
    'first_name', first_name,
    'second_name', second_name,
    'nickname', nickname,
    'email', email
  )
  INTO v_profile
  FROM profiles
  WHERE id = p_user_id;

  -- Get override if exists and not expired
  SELECT jsonb_build_object(
    'user_id', user_id,
    'display_name', display_name,
    'reason', reason,
    'overridden_by', overridden_by,
    'expires_at', expires_at,
    'created_at', created_at
  )
  INTO v_override
  FROM display_name_overrides
  WHERE user_id = p_user_id
    AND (expires_at IS NULL OR expires_at > now());

  RETURN jsonb_build_object(
    'profile', v_profile,
    'override', v_override
  );
END;
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION get_display_name_data(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION get_display_name_data(uuid) TO service_role;

-- -----------------------------------------------------------------------------
-- RPC: Get Display Name Data for Multiple Users (Batch)
-- Efficient batch lookup with single database round-trip
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_display_name_data_batch(p_user_ids uuid[])
RETURNS TABLE(
  user_id uuid,
  profile jsonb,
  override jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
BEGIN
  -- Limit batch size to 100
  IF array_length(p_user_ids, 1) > 100 THEN
    RAISE EXCEPTION 'Batch size exceeds maximum of 100';
  END IF;

  RETURN QUERY
  WITH user_profiles AS (
    SELECT
      p.id,
      jsonb_build_object(
        'id', p.id,
        'display_name', p.display_name,
        'first_name', p.first_name,
        'second_name', p.second_name,
        'nickname', p.nickname,
        'email', p.email
      ) AS profile_data
    FROM profiles p
    WHERE p.id = ANY(p_user_ids)
  ),
  user_overrides AS (
    SELECT
      o.user_id AS uid,
      jsonb_build_object(
        'user_id', o.user_id,
        'display_name', o.display_name,
        'reason', o.reason,
        'overridden_by', o.overridden_by,
        'expires_at', o.expires_at,
        'created_at', o.created_at
      ) AS override_data
    FROM display_name_overrides o
    WHERE o.user_id = ANY(p_user_ids)
      AND (o.expires_at IS NULL OR o.expires_at > now())
  )
  SELECT
    uid AS user_id,
    up.profile_data AS profile,
    uo.override_data AS override
  FROM unnest(p_user_ids) AS uid
  LEFT JOIN user_profiles up ON up.id = uid
  LEFT JOIN user_overrides uo ON uo.uid = uid;
END;
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION get_display_name_data_batch(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION get_display_name_data_batch(uuid[]) TO service_role;

-- -----------------------------------------------------------------------------
-- Audit Logging for Override Changes
-- Track all changes to display name overrides
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION audit_display_name_override_changes()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO audit.logged_actions (
      schema_name,
      table_name,
      action,
      row_data,
      user_id
    ) VALUES (
      TG_TABLE_SCHEMA,
      TG_TABLE_NAME,
      'INSERT',
      to_jsonb(NEW),
      NEW.overridden_by
    );
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO audit.logged_actions (
      schema_name,
      table_name,
      action,
      row_data,
      changed_fields,
      user_id
    ) VALUES (
      TG_TABLE_SCHEMA,
      TG_TABLE_NAME,
      'UPDATE',
      to_jsonb(NEW),
      (
        SELECT jsonb_object_agg(key, value)
        FROM jsonb_each(to_jsonb(NEW))
        WHERE to_jsonb(OLD) -> key IS DISTINCT FROM value
      ),
      NEW.overridden_by
    );
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO audit.logged_actions (
      schema_name,
      table_name,
      action,
      row_data,
      user_id
    ) VALUES (
      TG_TABLE_SCHEMA,
      TG_TABLE_NAME,
      'DELETE',
      to_jsonb(OLD),
      OLD.overridden_by
    );
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Only create audit trigger if audit schema exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'audit') THEN
    DROP TRIGGER IF EXISTS trigger_audit_display_name_overrides ON display_name_overrides;
    CREATE TRIGGER trigger_audit_display_name_overrides
      AFTER INSERT OR UPDATE OR DELETE ON display_name_overrides
      FOR EACH ROW
      EXECUTE FUNCTION audit_display_name_override_changes();
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Comments
-- -----------------------------------------------------------------------------

COMMENT ON TABLE display_name_overrides IS 'Admin-set display name overrides for users with optional expiration';
COMMENT ON COLUMN display_name_overrides.user_id IS 'User whose display name is being overridden';
COMMENT ON COLUMN display_name_overrides.display_name IS 'The corrected display name to use';
COMMENT ON COLUMN display_name_overrides.reason IS 'Reason for the override (e.g., user request, inappropriate content)';
COMMENT ON COLUMN display_name_overrides.overridden_by IS 'Admin user who set the override';
COMMENT ON COLUMN display_name_overrides.expires_at IS 'Optional expiration timestamp for temporary overrides';

COMMENT ON FUNCTION get_display_name_data(uuid) IS 'Get profile and override data for display name extraction';
COMMENT ON FUNCTION get_display_name_data_batch(uuid[]) IS 'Batch lookup for display name data (max 100 users)';
