-- Create email audit log table for compliance and security tracking
-- This table records all sensitive email operations for forensics and debugging

CREATE TABLE IF NOT EXISTS email_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Event classification
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),

  -- Actor (who performed the action)
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Target (who/what was affected)
  target_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  target_email TEXT,

  -- Provider context
  provider TEXT,

  -- Action details
  action TEXT NOT NULL,
  details JSONB DEFAULT '{}'::jsonb,

  -- Request tracking
  request_id TEXT,
  ip_address INET,
  user_agent TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Indexes for fast querying
  CONSTRAINT email_audit_log_event_type_check CHECK (event_type ~ '^[a-z_]+\.[a-z_]+$')
);

-- Create indexes for common query patterns
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_email_audit_log_user_id
  ON email_audit_log(user_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_email_audit_log_event_type
  ON email_audit_log(event_type, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_email_audit_log_severity
  ON email_audit_log(severity, created_at DESC)
  WHERE severity IN ('warning', 'critical');

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_email_audit_log_target_email
  ON email_audit_log(target_email, created_at DESC)
  WHERE target_email IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_email_audit_log_created_at
  ON email_audit_log(created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_email_audit_log_request_id
  ON email_audit_log(request_id)
  WHERE request_id IS NOT NULL;

-- GIN index for JSONB details column
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_email_audit_log_details
  ON email_audit_log USING GIN (details);

-- Enable Row Level Security
ALTER TABLE email_audit_log ENABLE ROW LEVEL SECURITY;

-- Policy: Service role can do everything
CREATE POLICY "Service role full access" ON email_audit_log
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Policy: Admins can read all audit logs
CREATE POLICY "Admins can read audit logs" ON email_audit_log
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
      WHERE ur.profile_id = auth.uid()
      AND r.name IN ('admin', 'superadmin')
    )
  );

-- Policy: Users can read their own audit events
CREATE POLICY "Users can read own audit events" ON email_audit_log
  FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid() OR target_user_id = auth.uid()
  );

-- Add helpful comment
COMMENT ON TABLE email_audit_log IS 'Audit trail for all sensitive email operations. Retains logs for compliance and forensics.';

COMMENT ON COLUMN email_audit_log.event_type IS 'Dot-separated event type (e.g., email.send, suppression.add)';
COMMENT ON COLUMN email_audit_log.severity IS 'Event severity: info, warning, or critical';
COMMENT ON COLUMN email_audit_log.user_id IS 'User who performed the action';
COMMENT ON COLUMN email_audit_log.target_user_id IS 'User affected by the action';
COMMENT ON COLUMN email_audit_log.target_email IS 'Email address affected';
COMMENT ON COLUMN email_audit_log.provider IS 'Email provider used (resend, brevo, etc.)';
COMMENT ON COLUMN email_audit_log.action IS 'Human-readable action description';
COMMENT ON COLUMN email_audit_log.details IS 'Additional context as JSON';
COMMENT ON COLUMN email_audit_log.request_id IS 'Request ID for correlation';

-- Retention policy: Delete audit logs older than 1 year (run periodically via cron)
-- This keeps the table size manageable while maintaining compliance requirements

-- Example cleanup function (call via pg_cron):
CREATE OR REPLACE FUNCTION cleanup_old_audit_logs()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  DELETE FROM email_audit_log
  WHERE created_at < NOW() - INTERVAL '1 year'
  AND severity = 'info'; -- Keep warning and critical longer

  DELETE FROM email_audit_log
  WHERE created_at < NOW() - INTERVAL '2 years'
  AND severity IN ('warning', 'critical');
END;
$$;

COMMENT ON FUNCTION cleanup_old_audit_logs IS 'Clean up audit logs older than retention period (1 year for info, 2 years for warning/critical)';

-- Helper function: Get recent critical events
CREATE OR REPLACE FUNCTION get_recent_critical_audit_events(hours INTEGER DEFAULT 24)
RETURNS TABLE(
  event_type TEXT,
  user_id UUID,
  target_email TEXT,
  action TEXT,
  details JSONB,
  created_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT event_type, user_id, target_email, action, details, created_at
  FROM email_audit_log
  WHERE severity = 'critical'
  AND created_at > NOW() - (hours || ' hours')::INTERVAL
  ORDER BY created_at DESC;
$$;

COMMENT ON FUNCTION get_recent_critical_audit_events IS 'Get critical audit events from the last N hours';

-- Helper function: Get audit stats
CREATE OR REPLACE FUNCTION get_audit_stats(hours INTEGER DEFAULT 24)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT jsonb_build_object(
    'total_events', COUNT(*),
    'by_severity', jsonb_object_agg(
      severity,
      severity_count
    ),
    'by_event_type', (
      SELECT jsonb_object_agg(event_type, event_count)
      FROM (
        SELECT event_type, COUNT(*) as event_count
        FROM email_audit_log
        WHERE created_at > NOW() - (hours || ' hours')::INTERVAL
        GROUP BY event_type
        ORDER BY event_count DESC
        LIMIT 10
      ) top_events
    ),
    'critical_count', (
      SELECT COUNT(*)
      FROM email_audit_log
      WHERE severity = 'critical'
      AND created_at > NOW() - (hours || ' hours')::INTERVAL
    )
  )
  FROM (
    SELECT severity, COUNT(*) as severity_count
    FROM email_audit_log
    WHERE created_at > NOW() - (hours || ' hours')::INTERVAL
    GROUP BY severity
  ) severity_stats;
$$;

COMMENT ON FUNCTION get_audit_stats IS 'Get aggregated audit statistics for the last N hours';
