-- Fix: Allow text notification IDs (Google Play uses string messageId, not UUID)
-- The notification_uuid column stays UUID for internal use, but we generate it from the text ID

-- Drop and recreate the wrapper function to accept text
DROP FUNCTION IF EXISTS public.billing_record_subscription_event;

CREATE OR REPLACE FUNCTION public.billing_record_subscription_event(
  p_notification_uuid text,  -- Changed from uuid to text
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
SET search_path = billing, public
AS $$
DECLARE
  v_uuid uuid;
  v_result jsonb;
BEGIN
  -- Convert text to UUID (use md5 hash for non-UUID strings)
  BEGIN
    v_uuid := p_notification_uuid::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    -- Generate deterministic UUID from the string (for idempotency)
    v_uuid := md5(p_notification_uuid)::uuid;
  END;
  
  -- Call the billing schema function
  SELECT billing.record_subscription_event(
    v_uuid,
    p_platform,
    p_notification_type,
    p_subtype,
    p_original_transaction_id,
    p_signed_payload,
    p_decoded_payload,
    p_signed_date
  ) INTO v_result;
  
  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.billing_record_subscription_event TO service_role;

-- Also update the underlying billing function to be more flexible
DROP FUNCTION IF EXISTS billing.record_subscription_event;

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
SET search_path = billing, public
AS $$
DECLARE
  v_event_id uuid;
  v_already_processed boolean := false;
BEGIN
  -- Check if event already exists (idempotency)
  SELECT id INTO v_event_id
  FROM billing.subscription_events
  WHERE notification_uuid = p_notification_uuid;
  
  IF v_event_id IS NOT NULL THEN
    v_already_processed := true;
  ELSE
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
  END IF;
  
  RETURN jsonb_build_object(
    'event_id', v_event_id,
    'already_processed', v_already_processed
  );
END;
$$;
