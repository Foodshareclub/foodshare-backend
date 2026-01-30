-- ============================================================================
-- APPLE APP STORE SUBSCRIPTION MANAGEMENT
-- Server-side subscription lifecycle management with webhook processing
-- ============================================================================

-- Create billing schema
CREATE SCHEMA IF NOT EXISTS billing;

-- Grant usage to authenticated and service role
GRANT USAGE ON SCHEMA billing TO authenticated, service_role;

-- ============================================================================
-- SUBSCRIPTIONS TABLE
-- Core subscription state tracking
-- ============================================================================

CREATE TABLE IF NOT EXISTS billing.subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Apple identifiers
  original_transaction_id text NOT NULL UNIQUE,
  product_id text NOT NULL,
  bundle_id text NOT NULL,

  -- Subscription state
  status text NOT NULL DEFAULT 'unknown' CHECK (status IN (
    'active',           -- Subscription is active and in good standing
    'expired',          -- Subscription has expired
    'in_grace_period',  -- Payment failed but in grace period
    'in_billing_retry', -- Payment failed, Apple is retrying
    'revoked',          -- Subscription was refunded or revoked
    'unknown'           -- Initial state before first webhook
  )),

  -- Period dates
  purchase_date timestamptz,
  original_purchase_date timestamptz,
  expires_date timestamptz,

  -- Renewal info
  auto_renew_status boolean DEFAULT true,
  auto_renew_product_id text,

  -- Environment
  environment text NOT NULL DEFAULT 'Production' CHECK (environment IN ('Production', 'Sandbox')),

  -- Metadata
  app_account_token uuid,  -- Set by iOS app during purchase for user lookup
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id
  ON billing.subscriptions(user_id);

CREATE INDEX IF NOT EXISTS idx_subscriptions_status
  ON billing.subscriptions(status)
  WHERE status IN ('active', 'in_grace_period');

CREATE INDEX IF NOT EXISTS idx_subscriptions_expires_date
  ON billing.subscriptions(expires_date DESC)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_subscriptions_app_account_token
  ON billing.subscriptions(app_account_token)
  WHERE app_account_token IS NOT NULL;

-- ============================================================================
-- SUBSCRIPTION EVENTS TABLE
-- Audit trail of all Apple notifications (idempotent by notification_uuid)
-- ============================================================================

CREATE TABLE IF NOT EXISTS billing.subscription_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Idempotency key - prevents duplicate processing
  notification_uuid uuid NOT NULL UNIQUE,

  -- Event info
  notification_type text NOT NULL,
  subtype text,

  -- References
  subscription_id uuid REFERENCES billing.subscriptions(id) ON DELETE SET NULL,
  original_transaction_id text NOT NULL,

  -- Raw payload for debugging
  signed_payload text NOT NULL,
  decoded_payload jsonb NOT NULL,

  -- Processing status
  processed boolean NOT NULL DEFAULT false,
  processing_error text,

  -- Timestamps
  signed_date timestamptz,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_subscription_events_original_transaction_id
  ON billing.subscription_events(original_transaction_id);

CREATE INDEX IF NOT EXISTS idx_subscription_events_notification_type
  ON billing.subscription_events(notification_type, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_subscription_events_received_at
  ON billing.subscription_events(received_at DESC);

CREATE INDEX IF NOT EXISTS idx_subscription_events_unprocessed
  ON billing.subscription_events(received_at)
  WHERE processed = false;

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

ALTER TABLE billing.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.subscription_events ENABLE ROW LEVEL SECURITY;

-- Users can only read their own subscription
CREATE POLICY "Users can read own subscription"
  ON billing.subscriptions FOR SELECT
  USING (user_id = auth.uid());

-- Service role has full access for webhook processing
CREATE POLICY "Service role has full access to subscriptions"
  ON billing.subscriptions FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Users cannot read subscription events (admin only)
CREATE POLICY "Service role has full access to events"
  ON billing.subscription_events FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Update updated_at on subscription changes
CREATE OR REPLACE FUNCTION billing.update_subscription_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_subscriptions_updated_at ON billing.subscriptions;
CREATE TRIGGER update_subscriptions_updated_at
  BEFORE UPDATE ON billing.subscriptions
  FOR EACH ROW EXECUTE FUNCTION billing.update_subscription_updated_at();

-- ============================================================================
-- RPC FUNCTIONS
-- ============================================================================

-- Get user subscription details
CREATE OR REPLACE FUNCTION billing.get_user_subscription(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = billing
AS $$
DECLARE
  v_result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'subscription_id', s.id,
    'product_id', s.product_id,
    'status', s.status,
    'expires_date', s.expires_date,
    'auto_renew_status', s.auto_renew_status,
    'is_active', s.status IN ('active', 'in_grace_period'),
    'environment', s.environment
  )
  INTO v_result
  FROM billing.subscriptions s
  WHERE s.user_id = p_user_id
    AND s.status IN ('active', 'in_grace_period', 'in_billing_retry')
  ORDER BY s.expires_date DESC NULLS LAST
  LIMIT 1;

  RETURN COALESCE(v_result, jsonb_build_object(
    'subscription_id', null,
    'product_id', null,
    'status', 'none',
    'expires_date', null,
    'auto_renew_status', false,
    'is_active', false,
    'environment', null
  ));
END;
$$;

-- Check if user has premium access
CREATE OR REPLACE FUNCTION billing.is_user_premium(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = billing
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM billing.subscriptions s
    WHERE s.user_id = p_user_id
      AND s.status IN ('active', 'in_grace_period')
      AND (s.expires_date IS NULL OR s.expires_date > now())
  );
$$;

-- Upsert subscription (called from webhook)
CREATE OR REPLACE FUNCTION billing.upsert_subscription(
  p_user_id uuid,
  p_original_transaction_id text,
  p_product_id text,
  p_bundle_id text,
  p_status text,
  p_purchase_date timestamptz,
  p_original_purchase_date timestamptz,
  p_expires_date timestamptz,
  p_auto_renew_status boolean,
  p_auto_renew_product_id text,
  p_environment text,
  p_app_account_token uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = billing
AS $$
DECLARE
  v_subscription_id uuid;
BEGIN
  INSERT INTO billing.subscriptions (
    user_id,
    original_transaction_id,
    product_id,
    bundle_id,
    status,
    purchase_date,
    original_purchase_date,
    expires_date,
    auto_renew_status,
    auto_renew_product_id,
    environment,
    app_account_token
  ) VALUES (
    p_user_id,
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
  )
  ON CONFLICT (original_transaction_id) DO UPDATE SET
    user_id = COALESCE(EXCLUDED.user_id, billing.subscriptions.user_id),
    product_id = EXCLUDED.product_id,
    status = EXCLUDED.status,
    purchase_date = EXCLUDED.purchase_date,
    expires_date = EXCLUDED.expires_date,
    auto_renew_status = EXCLUDED.auto_renew_status,
    auto_renew_product_id = EXCLUDED.auto_renew_product_id,
    environment = EXCLUDED.environment,
    app_account_token = COALESCE(EXCLUDED.app_account_token, billing.subscriptions.app_account_token),
    updated_at = now()
  RETURNING id INTO v_subscription_id;

  RETURN v_subscription_id;
END;
$$;

-- Record subscription event (idempotent)
CREATE OR REPLACE FUNCTION billing.record_subscription_event(
  p_notification_uuid uuid,
  p_notification_type text,
  p_subtype text,
  p_original_transaction_id text,
  p_signed_payload text,
  p_decoded_payload jsonb,
  p_signed_date timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = billing
AS $$
DECLARE
  v_event_id uuid;
  v_already_exists boolean;
BEGIN
  -- Check if event already exists (idempotency)
  SELECT id INTO v_event_id
  FROM billing.subscription_events
  WHERE notification_uuid = p_notification_uuid;

  IF v_event_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'event_id', v_event_id,
      'already_processed', true,
      'created', false
    );
  END IF;

  -- Insert new event
  INSERT INTO billing.subscription_events (
    notification_uuid,
    notification_type,
    subtype,
    original_transaction_id,
    signed_payload,
    decoded_payload,
    signed_date
  ) VALUES (
    p_notification_uuid,
    p_notification_type,
    p_subtype,
    p_original_transaction_id,
    p_signed_payload,
    p_decoded_payload,
    p_signed_date
  )
  RETURNING id INTO v_event_id;

  RETURN jsonb_build_object(
    'event_id', v_event_id,
    'already_processed', false,
    'created', true
  );
END;
$$;

-- Mark event as processed
CREATE OR REPLACE FUNCTION billing.mark_event_processed(
  p_event_id uuid,
  p_subscription_id uuid DEFAULT NULL,
  p_error text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = billing
AS $$
BEGIN
  UPDATE billing.subscription_events
  SET
    processed = true,
    subscription_id = p_subscription_id,
    processing_error = p_error
  WHERE id = p_event_id;
END;
$$;

-- Find user by app_account_token or original_transaction_id
CREATE OR REPLACE FUNCTION billing.find_user_for_transaction(
  p_app_account_token uuid,
  p_original_transaction_id text
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = billing
AS $$
DECLARE
  v_user_id uuid;
BEGIN
  -- First try app_account_token (most reliable - set by iOS app)
  IF p_app_account_token IS NOT NULL THEN
    SELECT user_id INTO v_user_id
    FROM billing.subscriptions
    WHERE app_account_token = p_app_account_token
    LIMIT 1;

    IF v_user_id IS NOT NULL THEN
      RETURN v_user_id;
    END IF;
  END IF;

  -- Fall back to existing subscription with same transaction ID
  SELECT user_id INTO v_user_id
  FROM billing.subscriptions
  WHERE original_transaction_id = p_original_transaction_id
  LIMIT 1;

  RETURN v_user_id;
END;
$$;

-- ============================================================================
-- GRANTS
-- ============================================================================

GRANT SELECT ON billing.subscriptions TO authenticated;
GRANT SELECT, INSERT, UPDATE ON billing.subscriptions TO service_role;
GRANT SELECT, INSERT, UPDATE ON billing.subscription_events TO service_role;

GRANT EXECUTE ON FUNCTION billing.get_user_subscription(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION billing.is_user_premium(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION billing.upsert_subscription(uuid, text, text, text, text, timestamptz, timestamptz, timestamptz, boolean, text, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION billing.record_subscription_event(uuid, text, text, text, text, jsonb, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION billing.mark_event_processed(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION billing.find_user_for_transaction(uuid, text) TO service_role;

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON SCHEMA billing IS 'Subscription and billing management for Apple App Store';
COMMENT ON TABLE billing.subscriptions IS 'Core subscription state tracking for Apple auto-renewable subscriptions';
COMMENT ON TABLE billing.subscription_events IS 'Audit trail of all Apple App Store Server Notifications V2';
COMMENT ON FUNCTION billing.get_user_subscription IS 'Returns subscription details for a user';
COMMENT ON FUNCTION billing.is_user_premium IS 'Returns true if user has an active subscription';
COMMENT ON FUNCTION billing.upsert_subscription IS 'Creates or updates a subscription record';
COMMENT ON FUNCTION billing.record_subscription_event IS 'Records a webhook event idempotently by notification_uuid';
COMMENT ON FUNCTION billing.mark_event_processed IS 'Marks an event as processed with optional subscription reference';
COMMENT ON FUNCTION billing.find_user_for_transaction IS 'Finds user by app_account_token or original_transaction_id';
