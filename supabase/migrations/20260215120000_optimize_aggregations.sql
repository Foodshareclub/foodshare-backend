-- Optimize aggregation queries: replace 3 sequential COUNT queries with single RPC
-- Used by _shared/aggregation.ts for feed BFF responses

CREATE OR REPLACE FUNCTION get_user_unread_counts(p_user_id UUID)
RETURNS TABLE(
  unread_notifications BIGINT,
  unread_messages BIGINT,
  pending_requests BIGINT
) AS $$
  SELECT
    (SELECT COUNT(*) FROM notifications WHERE user_id = p_user_id AND read = false),
    (SELECT COUNT(*) FROM chat_messages WHERE recipient_id = p_user_id AND read = false),
    (SELECT COUNT(*) FROM listing_requests WHERE owner_id = p_user_id AND status = 'pending');
$$ LANGUAGE SQL STABLE;
