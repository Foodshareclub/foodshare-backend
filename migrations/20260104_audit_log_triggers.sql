-- =============================================================================
-- Audit Log Triggers
--
-- Tracks changes to important tables for compliance, debugging, and analytics.
-- Uses a unified audit_logs table with JSONB for flexibility.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Audit Log Table
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    table_name TEXT NOT NULL,
    record_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
    old_data JSONB,
    new_data JSONB,
    changed_fields TEXT[],
    user_id UUID REFERENCES auth.users(id),
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_audit_logs_table_name ON audit_logs(table_name);
CREATE INDEX IF NOT EXISTS idx_audit_logs_record_id ON audit_logs(record_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_operation ON audit_logs(operation);

-- Partitioning by month for performance (optional, for high-volume)
-- CREATE INDEX IF NOT EXISTS idx_audit_logs_created_month ON audit_logs(DATE_TRUNC('month', created_at));

-- -----------------------------------------------------------------------------
-- Generic Audit Trigger Function
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trigger_audit_log()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_old_data JSONB;
    v_new_data JSONB;
    v_changed_fields TEXT[];
    v_record_id TEXT;
    v_user_id UUID;
BEGIN
    -- Get current user
    v_user_id := auth.uid();

    -- Determine record ID
    IF TG_OP = 'DELETE' THEN
        v_record_id := OLD.id::TEXT;
        v_old_data := to_jsonb(OLD);
        v_new_data := NULL;
    ELSIF TG_OP = 'INSERT' THEN
        v_record_id := NEW.id::TEXT;
        v_old_data := NULL;
        v_new_data := to_jsonb(NEW);
    ELSE -- UPDATE
        v_record_id := NEW.id::TEXT;
        v_old_data := to_jsonb(OLD);
        v_new_data := to_jsonb(NEW);

        -- Calculate changed fields
        SELECT ARRAY_AGG(key)
        INTO v_changed_fields
        FROM (
            SELECT key
            FROM jsonb_each(v_new_data)
            WHERE NOT v_old_data ? key
               OR v_old_data->key IS DISTINCT FROM v_new_data->key
        ) changed;
    END IF;

    -- Don't log if nothing changed on update
    IF TG_OP = 'UPDATE' AND v_changed_fields IS NULL THEN
        RETURN NEW;
    END IF;

    -- Insert audit log (async via queue or direct)
    INSERT INTO audit_logs (
        table_name,
        record_id,
        operation,
        old_data,
        new_data,
        changed_fields,
        user_id
    ) VALUES (
        TG_TABLE_NAME,
        v_record_id,
        TG_OP,
        v_old_data,
        v_new_data,
        v_changed_fields,
        v_user_id
    );

    RETURN COALESCE(NEW, OLD);
END;
$$;

-- -----------------------------------------------------------------------------
-- Sensitive Fields Redaction
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION redact_sensitive_fields(p_data JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_sensitive_fields TEXT[] := ARRAY[
        'password', 'password_hash', 'token', 'secret',
        'api_key', 'access_token', 'refresh_token',
        'credit_card', 'ssn', 'bank_account'
    ];
    v_field TEXT;
BEGIN
    FOREACH v_field IN ARRAY v_sensitive_fields
    LOOP
        IF p_data ? v_field THEN
            p_data := p_data || jsonb_build_object(v_field, '***REDACTED***');
        END IF;
    END LOOP;
    RETURN p_data;
END;
$$;

-- -----------------------------------------------------------------------------
-- Apply Audit Triggers to Key Tables
-- -----------------------------------------------------------------------------

-- Posts
DROP TRIGGER IF EXISTS trg_audit_posts ON posts;
CREATE TRIGGER trg_audit_posts
    AFTER INSERT OR UPDATE OR DELETE ON posts
    FOR EACH ROW
    EXECUTE FUNCTION trigger_audit_log();

-- Profiles
DROP TRIGGER IF EXISTS trg_audit_profiles ON profiles;
CREATE TRIGGER trg_audit_profiles
    AFTER UPDATE OR DELETE ON profiles
    FOR EACH ROW
    EXECUTE FUNCTION trigger_audit_log();

-- Reviews
DROP TRIGGER IF EXISTS trg_audit_reviews ON reviews;
CREATE TRIGGER trg_audit_reviews
    AFTER INSERT OR UPDATE OR DELETE ON reviews
    FOR EACH ROW
    EXECUTE FUNCTION trigger_audit_log();

-- Transactions/Arrangements
DROP TRIGGER IF EXISTS trg_audit_arrangements ON arrangements;
CREATE TRIGGER trg_audit_arrangements
    AFTER INSERT OR UPDATE OR DELETE ON arrangements
    FOR EACH ROW
    EXECUTE FUNCTION trigger_audit_log();

-- Reports (for moderation)
DROP TRIGGER IF EXISTS trg_audit_reports ON reports;
CREATE TRIGGER trg_audit_reports
    AFTER INSERT OR UPDATE OR DELETE ON reports
    FOR EACH ROW
    EXECUTE FUNCTION trigger_audit_log();

-- -----------------------------------------------------------------------------
-- Audit Query Functions
-- -----------------------------------------------------------------------------

-- Get audit history for a record
CREATE OR REPLACE FUNCTION get_audit_history(
    p_table_name TEXT,
    p_record_id TEXT,
    p_limit INTEGER DEFAULT 50
)
RETURNS TABLE (
    operation TEXT,
    changed_fields TEXT[],
    old_data JSONB,
    new_data JSONB,
    user_id UUID,
    created_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT
        al.operation,
        al.changed_fields,
        al.old_data,
        al.new_data,
        al.user_id,
        al.created_at
    FROM audit_logs al
    WHERE al.table_name = p_table_name
    AND al.record_id = p_record_id
    ORDER BY al.created_at DESC
    LIMIT p_limit;
$$;

-- Get recent changes by user
CREATE OR REPLACE FUNCTION get_user_audit_log(
    p_user_id UUID,
    p_limit INTEGER DEFAULT 50
)
RETURNS TABLE (
    table_name TEXT,
    record_id TEXT,
    operation TEXT,
    changed_fields TEXT[],
    created_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT
        al.table_name,
        al.record_id,
        al.operation,
        al.changed_fields,
        al.created_at
    FROM audit_logs al
    WHERE al.user_id = p_user_id
    ORDER BY al.created_at DESC
    LIMIT p_limit;
$$;

-- Get audit summary for a time period
CREATE OR REPLACE FUNCTION get_audit_summary(
    p_start_date TIMESTAMPTZ,
    p_end_date TIMESTAMPTZ DEFAULT NOW()
)
RETURNS TABLE (
    table_name TEXT,
    operation TEXT,
    count BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT
        al.table_name,
        al.operation,
        COUNT(*) as count
    FROM audit_logs al
    WHERE al.created_at BETWEEN p_start_date AND p_end_date
    GROUP BY al.table_name, al.operation
    ORDER BY al.table_name, al.operation;
$$;

-- -----------------------------------------------------------------------------
-- Cleanup Old Audit Logs
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cleanup_old_audit_logs(
    p_retention_days INTEGER DEFAULT 90
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_deleted_count INTEGER;
BEGIN
    DELETE FROM audit_logs
    WHERE created_at < NOW() - (p_retention_days || ' days')::INTERVAL;

    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

    RETURN v_deleted_count;
END;
$$;

-- RLS Policies for audit_logs
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Only admins can view audit logs
CREATE POLICY "Admins can view audit logs" ON audit_logs
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM profiles
            WHERE profiles.id = auth.uid()
            AND profiles.role = 'admin'
        )
    );

COMMENT ON TABLE audit_logs IS 'Unified audit log for tracking changes to important tables';
COMMENT ON FUNCTION trigger_audit_log IS 'Generic trigger function for audit logging';
COMMENT ON FUNCTION get_audit_history IS 'Get audit history for a specific record';
COMMENT ON FUNCTION cleanup_old_audit_logs IS 'Cleanup audit logs older than retention period';
