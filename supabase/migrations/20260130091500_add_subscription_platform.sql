-- ============================================================================
-- ADD PLATFORM SUPPORT TO BILLING SCHEMA
-- Enables cross-platform subscription management (Apple, Google Play, Stripe)
-- ============================================================================

-- Add platform column to subscriptions
ALTER TABLE billing.subscriptions
  ADD COLUMN IF NOT EXISTS platform text NOT NULL DEFAULT 'apple'
    CHECK (platform IN ('apple', 'google_play', 'stripe'));

-- Add platform column to subscription_events
ALTER TABLE billing.subscription_events
  ADD COLUMN IF NOT EXISTS platform text NOT NULL DEFAULT 'apple'
    CHECK (platform IN ('apple', 'google_play', 'stripe'));

-- Create index for platform queries
CREATE INDEX IF NOT EXISTS idx_subscriptions_platform
  ON billing.subscriptions(platform);

CREATE INDEX IF NOT EXISTS idx_subscription_events_platform
  ON billing.subscription_events(platform);

-- ============================================================================
-- UPDATE RPC FUNCTIONS TO INCLUDE PLATFORM
-- ============================================================================

-- Drop and recreate upsert_subscription with platform parameter
DROP FUNCTION IF EXISTS billing.upsert_subscription(uuid, text, text, text, text, timestamptz, timestamptz, timestamptz, boolean, text, text, uuid);

CREATE OR REPLACE FUNCTION billing.upsert_subscription(
  p_user_id uuid,
  p_platform text DEFAULT 'apple',
  p_original_transaction_id text DEFAULT '',
  p_product_id text DEFAULT '',
  p_bundle_id text DEFAULT '',
  p_status text DEFAULT 'unknown',
  p_purchase_date timestamptz DEFAULT NULL,
  p_original_purchase_date timestamptz DEFAULT NULL,
  p_expires_date timestamptz DEFAULT NULL,
  p_auto_renew_status boolean DEFAULT true,
  p_auto_renew_product_id text DEFAULT NULL,
  p_environment text DEFAULT 'Production',
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
    platform,
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
  )
  ON CONFLICT (original_transaction_id) DO UPDATE SET
    user_id = COALESCE(EXCLUDED.user_id, billing.subscriptions.user_id),
    platform = EXCLUDED.platform,
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

-- Drop and recreate record_subscription_event with platform parameter
DROP FUNCTION IF EXISTS billing.record_subscription_event(uuid, text, text, text, text, jsonb, timestamptz);

CREATE OR REPLACE FUNCTION billing.record_subscription_event(
  p_notification_uuid uuid,
  p_platform text DEFAULT 'apple',
  p_notification_type text DEFAULT '',
  p_subtype text DEFAULT NULL,
  p_original_transaction_id text DEFAULT '',
  p_signed_payload text DEFAULT '',
  p_decoded_payload jsonb DEFAULT '{}',
  p_signed_date timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = billing
AS $$
DECLARE
  v_event_id uuid;
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
    platform,
    notification_type,
    subtype,
    original_transaction_id,
    signed_payload,
    decoded_payload,
    signed_date
  ) VALUES (
    p_notification_uuid,
    p_platform,
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

-- ============================================================================
-- UPDATE GRANTS
-- ============================================================================

GRANT EXECUTE ON FUNCTION billing.upsert_subscription(uuid, text, text, text, text, text, timestamptz, timestamptz, timestamptz, boolean, text, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION billing.record_subscription_event(uuid, text, text, text, text, text, jsonb, timestamptz) TO service_role;

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON COLUMN billing.subscriptions.platform IS 'Subscription platform: apple, google_play, or stripe';
COMMENT ON COLUMN billing.subscription_events.platform IS 'Event source platform: apple, google_play, or stripe';
