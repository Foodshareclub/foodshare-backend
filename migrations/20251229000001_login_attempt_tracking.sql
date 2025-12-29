-- Migration: Login Attempt Tracking for Brute Force Protection
-- Purpose: Track authentication attempts to prevent brute force attacks
-- Supports: Cross-platform apps (iOS, Android, Web)

-- Create schema for security-related tables if not exists
CREATE SCHEMA IF NOT EXISTS security;

-- Grant usage to authenticated users (read-only access to their own lockout status)
GRANT USAGE ON SCHEMA security TO authenticated;
GRANT USAGE ON SCHEMA security TO service_role;

-- =============================================================================
-- Login Attempts Table
-- =============================================================================
-- Tracks all authentication attempts (successful and failed)
CREATE TABLE security.login_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL,
    ip_address INET,
    user_agent TEXT,
    app_platform TEXT, -- 'ios', 'android', 'web'
    app_version TEXT,
    success BOOLEAN NOT NULL DEFAULT false,
    failure_reason TEXT, -- 'invalid_password', 'account_locked', 'invalid_email', etc.
    attempt_metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for efficient querying
CREATE INDEX idx_login_attempts_email_time
    ON security.login_attempts(email, created_at DESC);

CREATE INDEX idx_login_attempts_ip_time
    ON security.login_attempts(ip_address, created_at DESC);

CREATE INDEX idx_login_attempts_created_at
    ON security.login_attempts(created_at DESC);

-- Partial index for failed attempts only (most common query)
CREATE INDEX idx_login_attempts_failed
    ON security.login_attempts(email, created_at DESC)
    WHERE success = false;

-- =============================================================================
-- Account Lockouts Table
-- =============================================================================
-- Tracks active lockouts for accounts
CREATE TABLE security.account_lockouts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL UNIQUE,
    locked_until TIMESTAMPTZ NOT NULL,
    lockout_level INT NOT NULL DEFAULT 1, -- 1=5min, 2=30min, 3=24hr
    failed_attempts INT NOT NULL DEFAULT 0,
    last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_account_lockouts_email ON security.account_lockouts(email);
CREATE INDEX idx_account_lockouts_until ON security.account_lockouts(locked_until);

-- =============================================================================
-- IP Rate Limits Table
-- =============================================================================
-- Tracks IP-based rate limiting (100 attempts/hour per IP)
CREATE TABLE security.ip_rate_limits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ip_address INET NOT NULL UNIQUE,
    attempt_count INT NOT NULL DEFAULT 1,
    window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
    blocked_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ip_rate_limits_ip ON security.ip_rate_limits(ip_address);
CREATE INDEX idx_ip_rate_limits_blocked ON security.ip_rate_limits(blocked_until) WHERE blocked_until IS NOT NULL;

-- =============================================================================
-- Functions
-- =============================================================================

-- Function to record a login attempt and return lockout status
CREATE OR REPLACE FUNCTION security.record_login_attempt(
    p_email TEXT,
    p_ip_address INET DEFAULT NULL,
    p_user_agent TEXT DEFAULT NULL,
    p_app_platform TEXT DEFAULT NULL,
    p_app_version TEXT DEFAULT NULL,
    p_success BOOLEAN DEFAULT false,
    p_failure_reason TEXT DEFAULT NULL,
    p_metadata JSONB DEFAULT '{}'
)
RETURNS TABLE (
    is_locked BOOLEAN,
    locked_until TIMESTAMPTZ,
    failed_count INT,
    ip_blocked BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_lockout RECORD;
    v_ip_limit RECORD;
    v_failed_count INT;
    v_lockout_minutes INT;
    v_lockout_level INT;
    v_is_locked BOOLEAN := false;
    v_locked_until TIMESTAMPTZ := NULL;
    v_ip_blocked BOOLEAN := false;
BEGIN
    -- Insert the login attempt
    INSERT INTO security.login_attempts (
        email, ip_address, user_agent, app_platform,
        app_version, success, failure_reason, attempt_metadata
    ) VALUES (
        lower(trim(p_email)), p_ip_address, p_user_agent, p_app_platform,
        p_app_version, p_success, p_failure_reason, p_metadata
    );

    -- If successful login, clear any existing lockout
    IF p_success THEN
        DELETE FROM security.account_lockouts WHERE email = lower(trim(p_email));

        -- Also decrement IP rate limit on success
        UPDATE security.ip_rate_limits
        SET attempt_count = GREATEST(0, attempt_count - 1),
            updated_at = now()
        WHERE ip_address = p_ip_address;

        RETURN QUERY SELECT false, NULL::TIMESTAMPTZ, 0, false;
        RETURN;
    END IF;

    -- Handle failed login
    -- Count recent failed attempts (last 15 minutes)
    SELECT COUNT(*)::INT INTO v_failed_count
    FROM security.login_attempts
    WHERE email = lower(trim(p_email))
      AND success = false
      AND created_at > now() - interval '15 minutes';

    -- Check/update IP rate limit
    IF p_ip_address IS NOT NULL THEN
        INSERT INTO security.ip_rate_limits (ip_address, attempt_count, window_start)
        VALUES (p_ip_address, 1, now())
        ON CONFLICT (ip_address) DO UPDATE SET
            attempt_count = CASE
                WHEN security.ip_rate_limits.window_start < now() - interval '1 hour'
                THEN 1
                ELSE security.ip_rate_limits.attempt_count + 1
            END,
            window_start = CASE
                WHEN security.ip_rate_limits.window_start < now() - interval '1 hour'
                THEN now()
                ELSE security.ip_rate_limits.window_start
            END,
            blocked_until = CASE
                WHEN security.ip_rate_limits.attempt_count >= 99
                THEN now() + interval '1 hour'
                ELSE security.ip_rate_limits.blocked_until
            END,
            updated_at = now()
        RETURNING * INTO v_ip_limit;

        v_ip_blocked := v_ip_limit.blocked_until IS NOT NULL AND v_ip_limit.blocked_until > now();
    END IF;

    -- Determine lockout level based on failed attempts
    IF v_failed_count >= 20 THEN
        v_lockout_level := 3;
        v_lockout_minutes := 1440; -- 24 hours
    ELSIF v_failed_count >= 10 THEN
        v_lockout_level := 2;
        v_lockout_minutes := 30;
    ELSIF v_failed_count >= 5 THEN
        v_lockout_level := 1;
        v_lockout_minutes := 5;
    ELSE
        v_lockout_level := 0;
        v_lockout_minutes := 0;
    END IF;

    -- Apply lockout if threshold reached
    IF v_lockout_level > 0 THEN
        INSERT INTO security.account_lockouts (
            email, locked_until, lockout_level, failed_attempts, last_attempt_at
        ) VALUES (
            lower(trim(p_email)),
            now() + (v_lockout_minutes || ' minutes')::interval,
            v_lockout_level,
            v_failed_count,
            now()
        )
        ON CONFLICT (email) DO UPDATE SET
            locked_until = CASE
                WHEN security.account_lockouts.lockout_level < v_lockout_level
                THEN now() + (v_lockout_minutes || ' minutes')::interval
                ELSE security.account_lockouts.locked_until
            END,
            lockout_level = GREATEST(security.account_lockouts.lockout_level, v_lockout_level),
            failed_attempts = v_failed_count,
            last_attempt_at = now(),
            updated_at = now()
        RETURNING * INTO v_lockout;

        v_is_locked := v_lockout.locked_until > now();
        v_locked_until := v_lockout.locked_until;
    END IF;

    RETURN QUERY SELECT v_is_locked, v_locked_until, v_failed_count, v_ip_blocked;
END;
$$;

-- Function to check if an account is currently locked
CREATE OR REPLACE FUNCTION security.check_lockout_status(
    p_email TEXT,
    p_ip_address INET DEFAULT NULL
)
RETURNS TABLE (
    is_locked BOOLEAN,
    locked_until TIMESTAMPTZ,
    lockout_level INT,
    failed_attempts INT,
    ip_blocked BOOLEAN,
    ip_blocked_until TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_lockout RECORD;
    v_ip_limit RECORD;
BEGIN
    -- Check account lockout
    SELECT * INTO v_lockout
    FROM security.account_lockouts
    WHERE email = lower(trim(p_email))
      AND locked_until > now();

    -- Check IP block
    IF p_ip_address IS NOT NULL THEN
        SELECT * INTO v_ip_limit
        FROM security.ip_rate_limits
        WHERE ip_address = p_ip_address
          AND blocked_until > now();
    END IF;

    RETURN QUERY SELECT
        v_lockout.id IS NOT NULL,
        v_lockout.locked_until,
        COALESCE(v_lockout.lockout_level, 0),
        COALESCE(v_lockout.failed_attempts, 0),
        v_ip_limit.id IS NOT NULL,
        v_ip_limit.blocked_until;
END;
$$;

-- Function to clear expired lockouts (for cleanup cron job)
CREATE OR REPLACE FUNCTION security.cleanup_expired_lockouts()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_deleted_lockouts INT;
    v_deleted_ip_limits INT;
    v_deleted_attempts INT;
BEGIN
    -- Clear expired account lockouts
    DELETE FROM security.account_lockouts WHERE locked_until < now();
    GET DIAGNOSTICS v_deleted_lockouts = ROW_COUNT;

    -- Clear expired IP blocks
    UPDATE security.ip_rate_limits
    SET blocked_until = NULL, attempt_count = 0, window_start = now(), updated_at = now()
    WHERE blocked_until < now();
    GET DIAGNOSTICS v_deleted_ip_limits = ROW_COUNT;

    -- Clear old login attempts (older than 30 days)
    DELETE FROM security.login_attempts WHERE created_at < now() - interval '30 days';
    GET DIAGNOSTICS v_deleted_attempts = ROW_COUNT;

    RETURN v_deleted_lockouts + v_deleted_ip_limits + v_deleted_attempts;
END;
$$;

-- =============================================================================
-- RLS Policies
-- =============================================================================

-- Enable RLS on all tables
ALTER TABLE security.login_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE security.account_lockouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE security.ip_rate_limits ENABLE ROW LEVEL SECURITY;

-- Login attempts: Only service role can read/write
CREATE POLICY "Service role full access to login_attempts"
    ON security.login_attempts
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Account lockouts: Only service role can read/write
CREATE POLICY "Service role full access to account_lockouts"
    ON security.account_lockouts
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- IP rate limits: Only service role can read/write
CREATE POLICY "Service role full access to ip_rate_limits"
    ON security.ip_rate_limits
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- =============================================================================
-- Grants
-- =============================================================================

-- Grant execute on functions to service_role (Edge Functions)
GRANT EXECUTE ON FUNCTION security.record_login_attempt TO service_role;
GRANT EXECUTE ON FUNCTION security.check_lockout_status TO service_role;
GRANT EXECUTE ON FUNCTION security.cleanup_expired_lockouts TO service_role;

-- =============================================================================
-- Comments
-- =============================================================================

COMMENT ON TABLE security.login_attempts IS 'Tracks all authentication attempts for security monitoring and brute force protection';
COMMENT ON TABLE security.account_lockouts IS 'Tracks currently locked accounts due to too many failed login attempts';
COMMENT ON TABLE security.ip_rate_limits IS 'Tracks IP-based rate limiting to prevent distributed brute force attacks';

COMMENT ON FUNCTION security.record_login_attempt IS 'Records a login attempt and returns current lockout status. Call from Edge Function on each auth attempt.';
COMMENT ON FUNCTION security.check_lockout_status IS 'Checks if an email or IP is currently locked out. Call before allowing login attempt.';
COMMENT ON FUNCTION security.cleanup_expired_lockouts IS 'Cleanup function to remove expired lockouts. Should be called via pg_cron daily.';
