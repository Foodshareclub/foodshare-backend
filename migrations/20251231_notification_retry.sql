-- =============================================================================
-- Notification Retry Logic Enhancement
-- =============================================================================
-- Adds retry mechanism for failed push notifications.
-- Implements exponential backoff with configurable max attempts.
-- =============================================================================

-- =============================================================================
-- Alter notification_queue table for retry support
-- =============================================================================

-- Add retry columns if they don't exist
ALTER TABLE notification_queue
  ADD COLUMN IF NOT EXISTS attempts INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts INT DEFAULT 3,
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS error_history JSONB DEFAULT '[]'::JSONB;

-- Create index for retry processing
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notification_queue_retry
  ON notification_queue(next_retry_at)
  WHERE status = 'failed' AND attempts < max_attempts;

-- Create index for failed notifications monitoring
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notification_queue_failed
  ON notification_queue(created_at DESC)
  WHERE status = 'failed';

-- =============================================================================
-- Retry Processing Functions
-- =============================================================================

-- Function to get notifications ready for retry
CREATE OR REPLACE FUNCTION get_retryable_notifications(
  p_limit INT DEFAULT 100
)
RETURNS TABLE (
  id UUID,
  profile_id UUID,
  device_token TEXT,
  platform TEXT,
  title TEXT,
  body TEXT,
  data JSONB,
  attempts INT,
  last_error TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  SET LOCAL statement_timeout = '5s';

  RETURN QUERY
  SELECT
    nq.id,
    nq.profile_id,
    nq.device_token,
    nq.platform,
    nq.title,
    nq.body,
    nq.data,
    nq.attempts,
    nq.last_error
  FROM notification_queue nq
  WHERE nq.status = 'failed'
    AND nq.attempts < nq.max_attempts
    AND nq.next_retry_at <= NOW()
  ORDER BY nq.next_retry_at ASC
  LIMIT p_limit
  FOR UPDATE SKIP LOCKED;
END;
$$;

-- Function to mark notification as being retried
CREATE OR REPLACE FUNCTION start_notification_retry(
  p_notification_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE notification_queue
  SET
    status = 'processing',
    last_attempt_at = NOW(),
    attempts = attempts + 1
  WHERE id = p_notification_id
    AND status = 'failed';

  RETURN FOUND;
END;
$$;

-- Function to mark notification retry as successful
CREATE OR REPLACE FUNCTION complete_notification_retry(
  p_notification_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE notification_queue
  SET
    status = 'sent',
    sent_at = NOW(),
    last_error = NULL,
    next_retry_at = NULL
  WHERE id = p_notification_id;
END;
$$;

-- Function to mark notification retry as failed
CREATE OR REPLACE FUNCTION fail_notification_retry(
  p_notification_id UUID,
  p_error TEXT,
  p_is_permanent BOOLEAN DEFAULT FALSE
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_attempts INT;
  v_max_attempts INT;
  v_next_retry TIMESTAMPTZ;
  v_error_entry JSONB;
BEGIN
  -- Get current attempts
  SELECT attempts, max_attempts INTO v_attempts, v_max_attempts
  FROM notification_queue
  WHERE id = p_notification_id;

  -- Build error history entry
  v_error_entry := jsonb_build_object(
    'error', p_error,
    'attempt', v_attempts,
    'timestamp', NOW()
  );

  -- Calculate next retry with exponential backoff
  -- Retry delays: 5min, 15min, 45min (base * 3^attempt)
  IF NOT p_is_permanent AND v_attempts < v_max_attempts THEN
    v_next_retry := NOW() + (5 * POWER(3, v_attempts - 1) * INTERVAL '1 minute');
  ELSE
    v_next_retry := NULL;
  END IF;

  UPDATE notification_queue
  SET
    status = CASE
      WHEN p_is_permanent OR v_attempts >= v_max_attempts THEN 'permanently_failed'
      ELSE 'failed'
    END,
    last_error = p_error,
    next_retry_at = v_next_retry,
    error_history = error_history || v_error_entry
  WHERE id = p_notification_id;

  -- If permanently failed due to invalid token, mark device as inactive
  IF p_is_permanent AND p_error LIKE '%invalid%token%' THEN
    UPDATE push_tokens
    SET is_active = FALSE, updated_at = NOW()
    WHERE token = (SELECT device_token FROM notification_queue WHERE id = p_notification_id);
  END IF;
END;
$$;

-- =============================================================================
-- Batch Retry Processing
-- =============================================================================

-- Function to process batch of retryable notifications
CREATE OR REPLACE FUNCTION process_notification_retries(
  p_batch_size INT DEFAULT 50
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_processed INT := 0;
  v_ready INT;
  v_notification RECORD;
BEGIN
  SET LOCAL statement_timeout = '30s';

  -- Count ready notifications
  SELECT COUNT(*) INTO v_ready
  FROM notification_queue
  WHERE status = 'failed'
    AND attempts < max_attempts
    AND next_retry_at <= NOW();

  -- Mark batch as processing
  UPDATE notification_queue
  SET status = 'processing', last_attempt_at = NOW()
  WHERE id IN (
    SELECT id FROM notification_queue
    WHERE status = 'failed'
      AND attempts < max_attempts
      AND next_retry_at <= NOW()
    ORDER BY next_retry_at
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  );

  GET DIAGNOSTICS v_processed = ROW_COUNT;

  RETURN jsonb_build_object(
    'success', true,
    'processed', v_processed,
    'ready', v_ready,
    'timestamp', NOW()
  );
END;
$$;

-- =============================================================================
-- Monitoring Functions
-- =============================================================================

-- Function to get notification retry statistics
CREATE OR REPLACE FUNCTION get_notification_retry_stats(
  p_hours INT DEFAULT 24
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
BEGIN
  SET LOCAL statement_timeout = '10s';

  SELECT jsonb_build_object(
    'period_hours', p_hours,
    'total_queued', (SELECT COUNT(*) FROM notification_queue WHERE created_at > NOW() - (p_hours || ' hours')::INTERVAL),
    'sent', (SELECT COUNT(*) FROM notification_queue WHERE status = 'sent' AND created_at > NOW() - (p_hours || ' hours')::INTERVAL),
    'failed', (SELECT COUNT(*) FROM notification_queue WHERE status = 'failed' AND created_at > NOW() - (p_hours || ' hours')::INTERVAL),
    'permanently_failed', (SELECT COUNT(*) FROM notification_queue WHERE status = 'permanently_failed' AND created_at > NOW() - (p_hours || ' hours')::INTERVAL),
    'pending_retry', (SELECT COUNT(*) FROM notification_queue WHERE status = 'failed' AND attempts < max_attempts AND created_at > NOW() - (p_hours || ' hours')::INTERVAL),
    'by_platform', (
      SELECT COALESCE(jsonb_agg(p), '[]'::JSONB)
      FROM (
        SELECT
          platform,
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
          AVG(attempts)::DECIMAL(3,1) AS avg_attempts
        FROM notification_queue
        WHERE created_at > NOW() - (p_hours || ' hours')::INTERVAL
        GROUP BY platform
      ) p
    ),
    'by_attempt_count', (
      SELECT COALESCE(jsonb_agg(a), '[]'::JSONB)
      FROM (
        SELECT
          attempts,
          COUNT(*) AS count,
          AVG(EXTRACT(EPOCH FROM (sent_at - created_at)))::INT AS avg_delivery_seconds
        FROM notification_queue
        WHERE created_at > NOW() - (p_hours || ' hours')::INTERVAL
          AND status = 'sent'
        GROUP BY attempts
        ORDER BY attempts
      ) a
    ),
    'common_errors', (
      SELECT COALESCE(jsonb_agg(e), '[]'::JSONB)
      FROM (
        SELECT
          last_error,
          COUNT(*) AS count
        FROM notification_queue
        WHERE status IN ('failed', 'permanently_failed')
          AND created_at > NOW() - (p_hours || ' hours')::INTERVAL
          AND last_error IS NOT NULL
        GROUP BY last_error
        ORDER BY count DESC
        LIMIT 10
      ) e
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- =============================================================================
-- Cleanup Functions
-- =============================================================================

-- Function to clean up old notification queue entries
CREATE OR REPLACE FUNCTION cleanup_notification_queue(
  p_retention_days INT DEFAULT 7
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted_sent INT;
  v_deleted_failed INT;
BEGIN
  -- Delete old sent notifications
  DELETE FROM notification_queue
  WHERE status = 'sent'
    AND sent_at < NOW() - (p_retention_days || ' days')::INTERVAL;
  GET DIAGNOSTICS v_deleted_sent = ROW_COUNT;

  -- Delete old permanently failed notifications (longer retention)
  DELETE FROM notification_queue
  WHERE status = 'permanently_failed'
    AND created_at < NOW() - ((p_retention_days * 2) || ' days')::INTERVAL;
  GET DIAGNOSTICS v_deleted_failed = ROW_COUNT;

  RETURN jsonb_build_object(
    'success', true,
    'deleted_sent', v_deleted_sent,
    'deleted_failed', v_deleted_failed,
    'retention_days', p_retention_days,
    'cleaned_at', NOW()
  );
END;
$$;

-- =============================================================================
-- Dead Letter Queue
-- =============================================================================

-- Create dead letter table for permanently failed notifications (for debugging)
CREATE TABLE IF NOT EXISTS notification_dead_letters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  original_id UUID NOT NULL,
  profile_id UUID,
  platform TEXT,
  title TEXT,
  body TEXT,
  data JSONB,
  attempts INT,
  error_history JSONB,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  failed_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for querying dead letters
CREATE INDEX IF NOT EXISTS idx_notification_dead_letters_created
  ON notification_dead_letters(failed_at DESC);

-- Trigger to move permanently failed to dead letter queue
CREATE OR REPLACE FUNCTION move_to_dead_letter()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'permanently_failed' AND OLD.status != 'permanently_failed' THEN
    INSERT INTO notification_dead_letters (
      original_id, profile_id, platform, title, body, data,
      attempts, error_history, last_error, created_at
    ) VALUES (
      NEW.id, NEW.profile_id, NEW.platform, NEW.title, NEW.body, NEW.data,
      NEW.attempts, NEW.error_history, NEW.last_error, NEW.created_at
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notification_dead_letter ON notification_queue;
CREATE TRIGGER trg_notification_dead_letter
  AFTER UPDATE ON notification_queue
  FOR EACH ROW
  EXECUTE FUNCTION move_to_dead_letter();

-- =============================================================================
-- Grant Permissions
-- =============================================================================

GRANT EXECUTE ON FUNCTION get_retryable_notifications TO service_role;
GRANT EXECUTE ON FUNCTION start_notification_retry TO service_role;
GRANT EXECUTE ON FUNCTION complete_notification_retry TO service_role;
GRANT EXECUTE ON FUNCTION fail_notification_retry TO service_role;
GRANT EXECUTE ON FUNCTION process_notification_retries TO service_role;
GRANT EXECUTE ON FUNCTION get_notification_retry_stats TO service_role;
GRANT EXECUTE ON FUNCTION cleanup_notification_queue TO service_role;

-- =============================================================================
-- Comments
-- =============================================================================

COMMENT ON FUNCTION get_retryable_notifications IS 'Returns notifications ready for retry with FOR UPDATE SKIP LOCKED';
COMMENT ON FUNCTION start_notification_retry IS 'Marks a notification as being retried';
COMMENT ON FUNCTION complete_notification_retry IS 'Marks a retry attempt as successful';
COMMENT ON FUNCTION fail_notification_retry IS 'Records retry failure with exponential backoff';
COMMENT ON FUNCTION process_notification_retries IS 'Batch processes retryable notifications';
COMMENT ON FUNCTION get_notification_retry_stats IS 'Returns retry statistics for monitoring';
COMMENT ON FUNCTION cleanup_notification_queue IS 'Cleans up old notification queue entries';
COMMENT ON TABLE notification_dead_letters IS 'Archive of permanently failed notifications for debugging';
