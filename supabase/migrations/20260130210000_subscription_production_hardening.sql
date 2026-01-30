-- =============================================================================
-- Subscription System Production Hardening
-- =============================================================================
-- P0 Critical: Database performance, DLQ, transaction isolation
-- P1 High: Monitoring tables, revenue tracking
-- =============================================================================

-- =============================================================================
-- 1. PERFORMANCE INDEXES (P0)
-- =============================================================================

-- High-traffic query optimization: user subscription lookups
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_subscriptions_user_platform_status
  ON billing.subscriptions(user_id, platform, status, expires_date DESC);

-- Event processing monitoring: find failed events quickly
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_subscription_events_processing_errors
  ON billing.subscription_events(processed, received_at DESC)
  WHERE processing_error IS NOT NULL;

-- Platform-specific active subscription queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_subscriptions_platform_active
  ON billing.subscriptions(platform, status, expires_date DESC)
  WHERE status IN ('active', 'in_grace_period');

-- Fast deduplication checks using hash index
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_subscription_events_notification_hash
  ON billing.subscription_events USING hash(notification_uuid);

-- Event type analysis
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_subscription_events_type_date
  ON billing.subscription_events(notification_type, received_at DESC);

-- Original transaction lookups for Apple/Google
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_subscription_events_original_txn
  ON billing.subscription_events(original_transaction_id, received_at DESC)
  WHERE original_transaction_id IS NOT NULL AND original_transaction_id != '';

-- =============================================================================
-- 2. DEAD LETTER QUEUE (P0)
-- =============================================================================

CREATE TABLE IF NOT EXISTS billing.subscription_events_dlq (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  original_event_id uuid REFERENCES billing.subscription_events(id) ON DELETE SET NULL,
  platform text NOT NULL,
  notification_type text NOT NULL,
  original_transaction_id text,
  failure_reason text NOT NULL,
  failure_details jsonb DEFAULT '{}',
  retry_count int NOT NULL DEFAULT 0,
  max_retries int NOT NULL DEFAULT 5,
  next_retry_at timestamptz,
  last_retry_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by text, -- 'auto', 'manual', 'expired'
  raw_payload text
);

-- Index for retry processing
CREATE INDEX IF NOT EXISTS idx_dlq_next_retry
  ON billing.subscription_events_dlq(next_retry_at)
  WHERE resolved_at IS NULL AND next_retry_at IS NOT NULL;

-- Index for monitoring
CREATE INDEX IF NOT EXISTS idx_dlq_platform_created
  ON billing.subscription_events_dlq(platform, created_at DESC)
  WHERE resolved_at IS NULL;

-- Enable RLS
ALTER TABLE billing.subscription_events_dlq ENABLE ROW LEVEL SECURITY;

-- Only service role can access DLQ
CREATE POLICY "Service role full access to DLQ"
  ON billing.subscription_events_dlq
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Function to add event to DLQ
CREATE OR REPLACE FUNCTION billing.add_to_dlq(
  p_event_id uuid,
  p_platform text,
  p_notification_type text,
  p_original_transaction_id text,
  p_failure_reason text,
  p_failure_details jsonb DEFAULT '{}',
  p_raw_payload text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = billing, public
AS $$
DECLARE
  v_dlq_id uuid;
  v_retry_delay interval;
BEGIN
  -- Calculate next retry time with exponential backoff (base: 1 minute)
  v_retry_delay := interval '1 minute';

  INSERT INTO billing.subscription_events_dlq (
    original_event_id,
    platform,
    notification_type,
    original_transaction_id,
    failure_reason,
    failure_details,
    next_retry_at,
    raw_payload
  ) VALUES (
    p_event_id,
    p_platform,
    p_notification_type,
    p_original_transaction_id,
    p_failure_reason,
    p_failure_details,
    now() + v_retry_delay,
    p_raw_payload
  )
  RETURNING id INTO v_dlq_id;

  RETURN v_dlq_id;
END;
$$;

-- Function to process DLQ entries (called by cron job)
CREATE OR REPLACE FUNCTION billing.process_dlq()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = billing, public
AS $$
DECLARE
  v_processed int := 0;
  v_expired int := 0;
  v_record RECORD;
BEGIN
  -- Mark expired entries (exceeded max retries)
  UPDATE billing.subscription_events_dlq
  SET
    resolved_at = now(),
    resolved_by = 'expired'
  WHERE
    resolved_at IS NULL
    AND retry_count >= max_retries;

  GET DIAGNOSTICS v_expired = ROW_COUNT;

  -- Get entries ready for retry
  FOR v_record IN
    SELECT id, retry_count
    FROM billing.subscription_events_dlq
    WHERE resolved_at IS NULL
      AND next_retry_at <= now()
      AND retry_count < max_retries
    ORDER BY next_retry_at
    LIMIT 10  -- Process in batches
  LOOP
    -- Update retry count and next retry time (exponential backoff)
    UPDATE billing.subscription_events_dlq
    SET
      retry_count = retry_count + 1,
      last_retry_at = now(),
      next_retry_at = now() + (power(2, retry_count + 1) * interval '1 minute')
    WHERE id = v_record.id;

    v_processed := v_processed + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'processed', v_processed,
    'expired', v_expired,
    'timestamp', now()
  );
END;
$$;

-- =============================================================================
-- 3. TRANSACTIONAL EVENT PROCESSING (P0)
-- =============================================================================

CREATE OR REPLACE FUNCTION billing.process_webhook_atomically(
  p_notification_uuid text,
  p_platform text,
  p_notification_type text,
  p_subtype text,
  p_original_transaction_id text,
  p_signed_payload text,
  p_decoded_payload jsonb,
  p_signed_date timestamptz,
  p_user_id uuid,
  p_product_id text,
  p_bundle_id text,
  p_status text,
  p_purchase_date timestamptz,
  p_original_purchase_date timestamptz,
  p_expires_date timestamptz,
  p_auto_renew_status boolean,
  p_auto_renew_product_id text,
  p_environment text,
  p_app_account_token uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = billing, public
AS $$
DECLARE
  v_event_result jsonb;
  v_subscription_id uuid;
  v_event_id uuid;
  v_already_processed boolean;
  v_uuid uuid;
BEGIN
  -- Convert notification UUID to actual UUID
  BEGIN
    v_uuid := p_notification_uuid::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    v_uuid := md5(p_notification_uuid)::uuid;
  END;

  -- Step 1: Record event (idempotent)
  SELECT billing.record_subscription_event(
    v_uuid,
    p_platform,
    p_notification_type,
    p_subtype,
    p_original_transaction_id,
    p_signed_payload,
    p_decoded_payload,
    p_signed_date
  ) INTO v_event_result;

  v_event_id := (v_event_result->>'event_id')::uuid;
  v_already_processed := (v_event_result->>'already_processed')::boolean;

  -- If already processed, return early
  IF v_already_processed THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_processed', true,
      'event_id', v_event_id
    );
  END IF;

  -- Step 2: Upsert subscription (only if we have a user)
  IF p_user_id IS NOT NULL THEN
    SELECT billing.upsert_subscription(
      p_user_id,
      p_platform,
      p_original_transaction_id,
      p_product_id,
      p_bundle_id,
      p_status,
      p_purchase_date,
      p_original_purchase_date,
      p_expires_date,
      p_auto_renew_status,
      p_auto_renew_product_id,
      p_environment,
      p_app_account_token
    ) INTO v_subscription_id;
  END IF;

  -- Step 3: Mark event as processed
  PERFORM billing.mark_event_processed(v_event_id, v_subscription_id, NULL);

  RETURN jsonb_build_object(
    'success', true,
    'already_processed', false,
    'event_id', v_event_id,
    'subscription_id', v_subscription_id
  );

EXCEPTION WHEN OTHERS THEN
  -- Add to DLQ on failure
  PERFORM billing.add_to_dlq(
    v_event_id,
    p_platform,
    p_notification_type,
    p_original_transaction_id,
    SQLERRM,
    jsonb_build_object('sqlstate', SQLSTATE, 'detail', COALESCE(PG_EXCEPTION_DETAIL, '')),
    p_signed_payload
  );

  -- Re-raise the error
  RAISE;
END;
$$;

-- Public wrapper for atomic processing
CREATE OR REPLACE FUNCTION public.billing_process_webhook_atomically(
  p_notification_uuid text,
  p_platform text,
  p_notification_type text,
  p_subtype text,
  p_original_transaction_id text,
  p_signed_payload text,
  p_decoded_payload jsonb,
  p_signed_date timestamptz,
  p_user_id uuid,
  p_product_id text,
  p_bundle_id text,
  p_status text,
  p_purchase_date timestamptz,
  p_original_purchase_date timestamptz,
  p_expires_date timestamptz,
  p_auto_renew_status boolean,
  p_auto_renew_product_id text,
  p_environment text,
  p_app_account_token uuid
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = billing, public
AS $$
  SELECT billing.process_webhook_atomically(
    p_notification_uuid,
    p_platform,
    p_notification_type,
    p_subtype,
    p_original_transaction_id,
    p_signed_payload,
    p_decoded_payload,
    p_signed_date,
    p_user_id,
    p_product_id,
    p_bundle_id,
    p_status,
    p_purchase_date,
    p_original_purchase_date,
    p_expires_date,
    p_auto_renew_status,
    p_auto_renew_product_id,
    p_environment,
    p_app_account_token
  );
$$;

GRANT EXECUTE ON FUNCTION public.billing_process_webhook_atomically TO service_role;

-- =============================================================================
-- 4. REVENUE METRICS TABLE (P1)
-- =============================================================================

CREATE TABLE IF NOT EXISTS billing.subscription_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_date date NOT NULL,
  platform text NOT NULL,

  -- Subscription counts
  total_active int NOT NULL DEFAULT 0,
  new_subscriptions int NOT NULL DEFAULT 0,
  churned_subscriptions int NOT NULL DEFAULT 0,
  reactivations int NOT NULL DEFAULT 0,

  -- Revenue (in cents)
  mrr_cents bigint NOT NULL DEFAULT 0,
  mrr_change_cents bigint NOT NULL DEFAULT 0,

  -- Events
  total_events int NOT NULL DEFAULT 0,
  failed_events int NOT NULL DEFAULT 0,

  -- Grace period
  in_grace_period int NOT NULL DEFAULT 0,
  grace_recovered int NOT NULL DEFAULT 0,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE(metric_date, platform)
);

-- Index for metric queries
CREATE INDEX IF NOT EXISTS idx_subscription_metrics_date
  ON billing.subscription_metrics(metric_date DESC, platform);

-- Enable RLS
ALTER TABLE billing.subscription_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role access to metrics"
  ON billing.subscription_metrics
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Function to update daily metrics (called by cron)
CREATE OR REPLACE FUNCTION billing.update_daily_metrics(p_date date DEFAULT CURRENT_DATE)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = billing, public
AS $$
DECLARE
  v_platform text;
  v_metrics jsonb := '[]'::jsonb;
BEGIN
  -- Calculate metrics for each platform
  FOR v_platform IN SELECT DISTINCT platform FROM billing.subscriptions
  LOOP
    INSERT INTO billing.subscription_metrics (
      metric_date,
      platform,
      total_active,
      new_subscriptions,
      churned_subscriptions,
      in_grace_period,
      total_events
    )
    SELECT
      p_date,
      v_platform,
      (SELECT count(*) FROM billing.subscriptions
       WHERE platform = v_platform AND status = 'active'),
      (SELECT count(*) FROM billing.subscription_events
       WHERE platform = v_platform
         AND notification_type IN ('SUBSCRIBED', 'subscription_created')
         AND received_at::date = p_date),
      (SELECT count(*) FROM billing.subscription_events
       WHERE platform = v_platform
         AND notification_type IN ('EXPIRED', 'subscription_expired', 'subscription_canceled')
         AND received_at::date = p_date),
      (SELECT count(*) FROM billing.subscriptions
       WHERE platform = v_platform AND status = 'in_grace_period'),
      (SELECT count(*) FROM billing.subscription_events
       WHERE platform = v_platform AND received_at::date = p_date)
    ON CONFLICT (metric_date, platform) DO UPDATE SET
      total_active = EXCLUDED.total_active,
      new_subscriptions = EXCLUDED.new_subscriptions,
      churned_subscriptions = EXCLUDED.churned_subscriptions,
      in_grace_period = EXCLUDED.in_grace_period,
      total_events = EXCLUDED.total_events,
      updated_at = now();

    v_metrics := v_metrics || jsonb_build_object(
      'platform', v_platform,
      'date', p_date,
      'updated', true
    );
  END LOOP;

  RETURN v_metrics;
END;
$$;

-- =============================================================================
-- 5. SUBSCRIPTION STATE MACHINE VALIDATION (P2)
-- =============================================================================

CREATE OR REPLACE FUNCTION billing.validate_status_transition(
  p_current_status text,
  p_new_status text,
  p_event_type text
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_valid_transitions jsonb := '{
    "active": ["expired", "in_grace_period", "paused", "in_billing_retry", "revoked", "refunded"],
    "expired": ["active"],
    "in_grace_period": ["active", "expired", "in_billing_retry"],
    "in_billing_retry": ["active", "expired", "in_grace_period"],
    "paused": ["active", "expired"],
    "on_hold": ["active", "expired"],
    "revoked": [],
    "refunded": [],
    "pending": ["active", "expired"],
    "unknown": ["active", "expired", "in_grace_period", "paused", "pending"]
  }'::jsonb;
  v_allowed jsonb;
BEGIN
  -- Get allowed transitions for current status
  v_allowed := v_valid_transitions->p_current_status;

  IF v_allowed IS NULL THEN
    -- Unknown current status, allow transition
    RETURN true;
  END IF;

  -- Check if new status is in allowed list
  RETURN v_allowed ? p_new_status;
END;
$$;

-- =============================================================================
-- 6. MONITORING VIEWS (P1)
-- =============================================================================

CREATE OR REPLACE VIEW billing.subscription_health AS
SELECT
  platform,
  COUNT(*) FILTER (WHERE status = 'active') as active_count,
  COUNT(*) FILTER (WHERE status = 'in_grace_period') as grace_period_count,
  COUNT(*) FILTER (WHERE status = 'expired') as expired_count,
  COUNT(*) FILTER (WHERE status IN ('active', 'in_grace_period')) as premium_count,
  COUNT(*) as total_count,
  MAX(updated_at) as last_updated
FROM billing.subscriptions
GROUP BY platform;

CREATE OR REPLACE VIEW billing.dlq_summary AS
SELECT
  platform,
  COUNT(*) FILTER (WHERE resolved_at IS NULL) as pending,
  COUNT(*) FILTER (WHERE resolved_at IS NOT NULL AND resolved_by = 'auto') as auto_resolved,
  COUNT(*) FILTER (WHERE resolved_at IS NOT NULL AND resolved_by = 'expired') as expired,
  COUNT(*) as total,
  MIN(next_retry_at) FILTER (WHERE resolved_at IS NULL) as next_retry,
  MAX(created_at) as last_failure
FROM billing.subscription_events_dlq
GROUP BY platform;

CREATE OR REPLACE VIEW billing.recent_events AS
SELECT
  se.id,
  se.platform,
  se.notification_type,
  se.subtype,
  se.original_transaction_id,
  se.processed,
  se.processing_error,
  se.received_at,
  s.user_id,
  s.status as current_status
FROM billing.subscription_events se
LEFT JOIN billing.subscriptions s
  ON se.original_transaction_id = s.original_transaction_id
  AND se.platform = s.platform
ORDER BY se.received_at DESC
LIMIT 100;

-- =============================================================================
-- 7. CLEANUP FUNCTION (Maintenance)
-- =============================================================================

CREATE OR REPLACE FUNCTION billing.cleanup_old_events(p_retention_days int DEFAULT 90)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = billing, public
AS $$
DECLARE
  v_deleted_events int;
  v_deleted_dlq int;
BEGIN
  -- Delete old processed events (keep unprocessed ones longer)
  DELETE FROM billing.subscription_events
  WHERE processed = true
    AND received_at < now() - (p_retention_days || ' days')::interval;
  GET DIAGNOSTICS v_deleted_events = ROW_COUNT;

  -- Delete old resolved DLQ entries
  DELETE FROM billing.subscription_events_dlq
  WHERE resolved_at IS NOT NULL
    AND resolved_at < now() - (p_retention_days || ' days')::interval;
  GET DIAGNOSTICS v_deleted_dlq = ROW_COUNT;

  RETURN jsonb_build_object(
    'deleted_events', v_deleted_events,
    'deleted_dlq', v_deleted_dlq,
    'retention_days', p_retention_days,
    'timestamp', now()
  );
END;
$$;

-- =============================================================================
-- 8. GRANT PERMISSIONS
-- =============================================================================

GRANT EXECUTE ON FUNCTION billing.add_to_dlq TO service_role;
GRANT EXECUTE ON FUNCTION billing.process_dlq TO service_role;
GRANT EXECUTE ON FUNCTION billing.update_daily_metrics TO service_role;
GRANT EXECUTE ON FUNCTION billing.cleanup_old_events TO service_role;
GRANT EXECUTE ON FUNCTION billing.validate_status_transition TO service_role;
GRANT EXECUTE ON FUNCTION billing.process_webhook_atomically TO service_role;

-- Grant view access
GRANT SELECT ON billing.subscription_health TO service_role;
GRANT SELECT ON billing.dlq_summary TO service_role;
GRANT SELECT ON billing.recent_events TO service_role;
