-- ============================================================================
-- Fix Digest Trigger Function (Simplified)
-- ============================================================================
-- Simplifies the trigger function to not require vault secrets since
-- the Edge Function has verify_jwt = false in config.toml.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.trigger_digest_edge_function(p_frequency text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request_id bigint;
BEGIN
  -- Make HTTP POST request to the Edge Function using pg_net
  -- Note: verify_jwt = false is set in config.toml, so no auth needed
  SELECT net.http_post(
    url := 'https://***REMOVED***/functions/v1/send-digest-notifications',
    body := jsonb_build_object(
      'frequency', p_frequency,
      'limit', 100
    ),
    headers := jsonb_build_object(
      'Content-Type', 'application/json'
    )
  ) INTO v_request_id;

  RETURN v_request_id;
END;
$$;

COMMENT ON FUNCTION public.trigger_digest_edge_function IS 'Triggers the send-digest-notifications Edge Function for a specific frequency. Called by pg_cron jobs.';

