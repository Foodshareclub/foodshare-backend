-- ============================================================================
-- Add Digest Processing Functions
-- Helper functions for the send-digest-notifications Edge Function
-- ============================================================================

-- ============================================================================
-- get_pending_digest_notifications - Fetch digest items ready for delivery
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_pending_digest_notifications(
  p_frequency text,
  p_limit integer DEFAULT 100
)
RETURNS TABLE (
  user_id uuid,
  items jsonb,
  item_count integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    dq.user_id,
    jsonb_agg(
      jsonb_build_object(
        'id', dq.id,
        'type', dq.notification_type,
        'category', dq.category::text,
        'title', dq.title,
        'body', dq.body,
        'data', dq.data,
        'created_at', dq.created_at
      ) ORDER BY dq.created_at DESC
    ) AS items,
    COUNT(*)::integer AS item_count
  FROM notification_digest_queue dq
  WHERE dq.status = 'pending'
    AND dq.frequency = p_frequency
    AND dq.scheduled_for <= NOW()
  GROUP BY dq.user_id
  ORDER BY COUNT(*) DESC
  LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_pending_digest_notifications(text, integer) TO service_role;

COMMENT ON FUNCTION public.get_pending_digest_notifications IS 'Fetches pending digest notifications grouped by user for batch processing';

-- ============================================================================
-- mark_digest_notifications_sent - Mark digest items as delivered
-- ============================================================================

CREATE OR REPLACE FUNCTION public.mark_digest_notifications_sent(p_notification_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE notification_digest_queue
  SET status = 'sent',
      sent_at = NOW()
  WHERE id = ANY(p_notification_ids)
    AND status = 'pending';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_digest_notifications_sent(uuid[]) TO service_role;

COMMENT ON FUNCTION public.mark_digest_notifications_sent IS 'Marks digest notifications as sent after delivery';

-- ============================================================================
-- cleanup_old_digest_queue - Remove old processed entries
-- ============================================================================

CREATE OR REPLACE FUNCTION public.cleanup_old_digest_queue(p_days_old integer DEFAULT 7)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM notification_digest_queue
  WHERE status IN ('sent', 'failed', 'expired')
    AND (sent_at < NOW() - (p_days_old || ' days')::interval
         OR (sent_at IS NULL AND created_at < NOW() - (p_days_old || ' days')::interval));

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cleanup_old_digest_queue(integer) TO service_role;

COMMENT ON FUNCTION public.cleanup_old_digest_queue IS 'Removes old processed digest queue entries for cleanup';
