-- =============================================================================
-- Add Public Wrapper for State Validation + Fix Metrics Calculation
-- =============================================================================

-- Public wrapper for state transition validation
CREATE OR REPLACE FUNCTION public.billing_validate_status_transition(
  p_current_status text,
  p_new_status text,
  p_event_type text
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = billing, public
AS $$
  SELECT billing.validate_status_transition(p_current_status, p_new_status, p_event_type);
$$;

GRANT EXECUTE ON FUNCTION public.billing_validate_status_transition TO service_role;

-- =============================================================================
-- Fix update_daily_metrics to populate ALL columns
-- =============================================================================

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
      reactivations,
      in_grace_period,
      grace_recovered,
      total_events,
      failed_events
    )
    SELECT
      p_date,
      v_platform,
      -- Active subscriptions
      (SELECT count(*) FROM billing.subscriptions
       WHERE platform = v_platform AND status = 'active'),
      -- New subscriptions (created today)
      (SELECT count(*) FROM billing.subscription_events
       WHERE platform = v_platform
         AND notification_type IN ('SUBSCRIBED', 'subscription_created', 'OFFER_REDEEMED')
         AND subtype IS DISTINCT FROM 'RESUBSCRIBE'
         AND received_at::date = p_date),
      -- Churned subscriptions
      (SELECT count(*) FROM billing.subscription_events
       WHERE platform = v_platform
         AND notification_type IN ('EXPIRED', 'subscription_expired', 'subscription_canceled', 'REVOKE', 'revoked')
         AND received_at::date = p_date),
      -- Reactivations (resubscribe or came back from expired)
      (SELECT count(*) FROM billing.subscription_events
       WHERE platform = v_platform
         AND (
           (notification_type = 'SUBSCRIBED' AND subtype = 'RESUBSCRIBE')
           OR notification_type = 'subscription_reactivated'
           OR (notification_type = 'DID_CHANGE_RENEWAL_STATUS' AND subtype != 'AUTO_RENEW_DISABLED')
         )
         AND received_at::date = p_date),
      -- In grace period
      (SELECT count(*) FROM billing.subscriptions
       WHERE platform = v_platform AND status = 'in_grace_period'),
      -- Grace recovered (billing issue resolved)
      (SELECT count(*) FROM billing.subscription_events
       WHERE platform = v_platform
         AND notification_type IN ('DID_RENEW', 'billing_recovered')
         AND subtype = 'BILLING_RECOVERY'
         AND received_at::date = p_date),
      -- Total events today
      (SELECT count(*) FROM billing.subscription_events
       WHERE platform = v_platform AND received_at::date = p_date),
      -- Failed events
      (SELECT count(*) FROM billing.subscription_events
       WHERE platform = v_platform
         AND received_at::date = p_date
         AND processing_error IS NOT NULL)
    ON CONFLICT (metric_date, platform) DO UPDATE SET
      total_active = EXCLUDED.total_active,
      new_subscriptions = EXCLUDED.new_subscriptions,
      churned_subscriptions = EXCLUDED.churned_subscriptions,
      reactivations = EXCLUDED.reactivations,
      in_grace_period = EXCLUDED.in_grace_period,
      grace_recovered = EXCLUDED.grace_recovered,
      total_events = EXCLUDED.total_events,
      failed_events = EXCLUDED.failed_events,
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

-- Public wrapper for update_daily_metrics (needed for cron)
CREATE OR REPLACE FUNCTION public.billing_update_daily_metrics(p_date date DEFAULT CURRENT_DATE)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = billing, public
AS $$
  SELECT billing.update_daily_metrics(p_date);
$$;

GRANT EXECUTE ON FUNCTION public.billing_update_daily_metrics TO service_role;

-- Public wrapper for process_dlq (needed for cron)
CREATE OR REPLACE FUNCTION public.billing_process_dlq()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = billing, public
AS $$
  SELECT billing.process_dlq();
$$;

GRANT EXECUTE ON FUNCTION public.billing_process_dlq TO service_role;

-- Public wrapper for cleanup_old_events (needed for cron)
CREATE OR REPLACE FUNCTION public.billing_cleanup_old_events(p_retention_days int DEFAULT 90)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = billing, public
AS $$
  SELECT billing.cleanup_old_events(p_retention_days);
$$;

GRANT EXECUTE ON FUNCTION public.billing_cleanup_old_events TO service_role;

-- Get current subscription status for validation
CREATE OR REPLACE FUNCTION public.billing_get_current_status(
  p_original_transaction_id text,
  p_platform text
)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = billing, public
AS $$
  SELECT COALESCE(
    (SELECT status FROM billing.subscriptions
     WHERE original_transaction_id = p_original_transaction_id
       AND platform = p_platform
     LIMIT 1),
    'unknown'
  );
$$;

GRANT EXECUTE ON FUNCTION public.billing_get_current_status TO service_role;
