-- Create public wrapper functions for billing schema
-- These allow Supabase RPC to call billing functions without schema prefix

-- Wrapper for record_subscription_event
CREATE OR REPLACE FUNCTION public.billing_record_subscription_event(
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
LANGUAGE sql
SECURITY DEFINER
SET search_path = billing, public
AS $$
  SELECT billing.record_subscription_event(
    p_notification_uuid,
    p_platform,
    p_notification_type,
    p_subtype,
    p_original_transaction_id,
    p_signed_payload,
    p_decoded_payload,
    p_signed_date
  );
$$;

-- Wrapper for find_user_for_transaction
CREATE OR REPLACE FUNCTION public.billing_find_user_for_transaction(
  p_app_account_token uuid,
  p_original_transaction_id text
)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = billing, public
AS $$
  SELECT billing.find_user_for_transaction(p_app_account_token, p_original_transaction_id);
$$;

-- Wrapper for upsert_subscription
CREATE OR REPLACE FUNCTION public.billing_upsert_subscription(
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
LANGUAGE sql
SECURITY DEFINER
SET search_path = billing, public
AS $$
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
  );
$$;

-- Wrapper for mark_event_processed
CREATE OR REPLACE FUNCTION public.billing_mark_event_processed(
  p_event_id uuid,
  p_subscription_id uuid DEFAULT NULL,
  p_error text DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = billing, public
AS $$
  SELECT billing.mark_event_processed(p_event_id, p_subscription_id, p_error);
$$;

-- Wrapper for is_user_premium
CREATE OR REPLACE FUNCTION public.billing_is_user_premium(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = billing, public
AS $$
  SELECT billing.is_user_premium(p_user_id);
$$;

-- Wrapper for get_user_subscription
CREATE OR REPLACE FUNCTION public.billing_get_user_subscription(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = billing, public
AS $$
  SELECT billing.get_user_subscription(p_user_id);
$$;

-- Grant execute to service_role
GRANT EXECUTE ON FUNCTION public.billing_record_subscription_event TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_find_user_for_transaction TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_upsert_subscription TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_mark_event_processed TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_is_user_premium TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_get_user_subscription TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_is_user_premium TO authenticated;
GRANT EXECUTE ON FUNCTION public.billing_get_user_subscription TO authenticated;
