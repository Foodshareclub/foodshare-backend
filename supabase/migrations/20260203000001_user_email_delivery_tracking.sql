-- =============================================================================
-- User Email Delivery Tracking Migration
-- =============================================================================
-- Creates infrastructure for per-user email delivery tracking:
-- - email_delivery_log table for tracking every email
-- - user_email_health materialized view for delivery stats
-- - Fair queue processing functions
-- - Delivery metrics RPCs
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Email Delivery Log Table
-- Track every newsletter/notification delivery per user
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS email_delivery_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  campaign_id uuid REFERENCES newsletter_campaigns(id) ON DELETE SET NULL,
  email_type text NOT NULL CHECK (email_type IN ('newsletter', 'digest', 'notification', 'transactional', 'marketing')),
  template_slug text,

  -- Delivery status
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained', 'failed')),
  provider text,
  message_id text,

  -- Timing
  queued_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  opened_at timestamptz,
  clicked_at timestamptz,

  -- Error tracking
  error_code text,
  error_message text,
  retry_count integer NOT NULL DEFAULT 0,

  -- Metadata
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Timestamps
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_email_delivery_user_queued
  ON email_delivery_log(user_id, queued_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_delivery_campaign_status
  ON email_delivery_log(campaign_id, status)
  WHERE campaign_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_email_delivery_status_queued
  ON email_delivery_log(status, queued_at)
  WHERE status IN ('queued', 'sent');

CREATE INDEX IF NOT EXISTS idx_email_delivery_undelivered
  ON email_delivery_log(user_id)
  WHERE status NOT IN ('delivered', 'opened', 'clicked');

CREATE INDEX IF NOT EXISTS idx_email_delivery_message_id
  ON email_delivery_log(message_id)
  WHERE message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_email_delivery_provider
  ON email_delivery_log(provider, sent_at DESC)
  WHERE provider IS NOT NULL;

-- Trigger to update updated_at
CREATE OR REPLACE FUNCTION update_email_delivery_log_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_email_delivery_log_updated_at ON email_delivery_log;
CREATE TRIGGER trigger_email_delivery_log_updated_at
  BEFORE UPDATE ON email_delivery_log
  FOR EACH ROW
  EXECUTE FUNCTION update_email_delivery_log_updated_at();

-- Enable RLS
ALTER TABLE email_delivery_log ENABLE ROW LEVEL SECURITY;

-- RLS Policies
-- Users can view their own delivery logs
CREATE POLICY "Users can view own delivery logs"
  ON email_delivery_log
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Service role can manage all logs
CREATE POLICY "Service role full access to delivery logs"
  ON email_delivery_log
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- User Email Health Materialized View
-- Aggregated delivery stats per user for efficient health checks
-- -----------------------------------------------------------------------------

CREATE MATERIALIZED VIEW IF NOT EXISTS user_email_health AS
SELECT
  user_id,
  COUNT(*) AS total_emails,
  COUNT(*) FILTER (WHERE status IN ('delivered', 'opened', 'clicked')) AS delivered,
  COUNT(*) FILTER (WHERE status IN ('opened', 'clicked')) AS opened,
  COUNT(*) FILTER (WHERE status = 'clicked') AS clicked,
  COUNT(*) FILTER (WHERE status = 'bounced') AS bounced,
  COUNT(*) FILTER (WHERE status = 'complained') AS complained,
  COUNT(*) FILTER (WHERE status = 'failed') AS failed,
  ROUND(
    COUNT(*) FILTER (WHERE status IN ('delivered', 'opened', 'clicked'))::numeric /
    NULLIF(COUNT(*), 0) * 100, 2
  ) AS delivery_rate,
  ROUND(
    COUNT(*) FILTER (WHERE status IN ('opened', 'clicked'))::numeric /
    NULLIF(COUNT(*) FILTER (WHERE status IN ('delivered', 'opened', 'clicked')), 0) * 100, 2
  ) AS open_rate,
  MAX(delivered_at) AS last_delivered_at,
  MAX(opened_at) AS last_opened_at,
  MAX(queued_at) AS last_queued_at
FROM email_delivery_log
WHERE queued_at > NOW() - INTERVAL '90 days'
GROUP BY user_id;

-- Unique index for concurrent refresh
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_email_health_user_id
  ON user_email_health(user_id);

-- Index for delivery rate sorting
CREATE INDEX IF NOT EXISTS idx_user_email_health_delivery_rate
  ON user_email_health(delivery_rate DESC NULLS LAST);

-- -----------------------------------------------------------------------------
-- Function: Refresh User Email Health
-- Call this daily via cron to keep stats updated
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION refresh_user_email_health()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY user_email_health;
END;
$$;

GRANT EXECUTE ON FUNCTION refresh_user_email_health() TO service_role;

-- -----------------------------------------------------------------------------
-- Function: Get Underserved Users
-- Returns users who haven't received recent emails (fairness algorithm)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_underserved_users(
  p_campaign_id uuid,
  p_limit integer DEFAULT 100
)
RETURNS TABLE(
  user_id uuid,
  last_email_at timestamptz,
  delivery_rate numeric
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT
    p.id AS user_id,
    h.last_delivered_at AS last_email_at,
    COALESCE(h.delivery_rate, 100) AS delivery_rate
  FROM profiles p
  LEFT JOIN user_email_health h ON h.user_id = p.id
  LEFT JOIN email_delivery_log edl ON edl.user_id = p.id
    AND edl.campaign_id = p_campaign_id
  WHERE p.email IS NOT NULL
    AND edl.id IS NULL  -- Not yet sent this campaign
  ORDER BY
    h.last_delivered_at NULLS FIRST,  -- Prioritize users who haven't received email
    h.delivery_rate DESC NULLS LAST   -- Then by best delivery rate
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION get_underserved_users(uuid, integer) TO service_role;

-- -----------------------------------------------------------------------------
-- Function: Queue Newsletter with Fairness
-- Queues newsletter emails to underserved users first
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION queue_newsletter_fair(
  p_campaign_id uuid,
  p_batch_size integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_queued integer := 0;
  v_user record;
  v_campaign_template text;
BEGIN
  -- Get campaign template
  SELECT template_slug INTO v_campaign_template
  FROM newsletter_campaigns
  WHERE id = p_campaign_id;

  -- Queue emails for underserved users
  FOR v_user IN
    SELECT * FROM get_underserved_users(p_campaign_id, p_batch_size)
  LOOP
    INSERT INTO email_delivery_log (
      user_id,
      campaign_id,
      email_type,
      template_slug,
      status
    ) VALUES (
      v_user.user_id,
      p_campaign_id,
      'newsletter',
      v_campaign_template,
      'queued'
    );

    v_queued := v_queued + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'queued', v_queued,
    'campaignId', p_campaign_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION queue_newsletter_fair(uuid, integer) TO service_role;

-- -----------------------------------------------------------------------------
-- Function: Get User Email Metrics
-- Comprehensive delivery metrics for a specific user
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_user_email_metrics(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT jsonb_build_object(
    'userId', p_user_id,
    'totalEmails', COUNT(*),
    'delivered', COUNT(*) FILTER (WHERE status IN ('delivered', 'opened', 'clicked')),
    'opened', COUNT(*) FILTER (WHERE status IN ('opened', 'clicked')),
    'clicked', COUNT(*) FILTER (WHERE status = 'clicked'),
    'bounced', COUNT(*) FILTER (WHERE status = 'bounced'),
    'complained', COUNT(*) FILTER (WHERE status = 'complained'),
    'failed', COUNT(*) FILTER (WHERE status = 'failed'),
    'deliveryRate', ROUND(
      COUNT(*) FILTER (WHERE status IN ('delivered', 'opened', 'clicked'))::numeric /
      NULLIF(COUNT(*), 0) * 100, 2
    ),
    'openRate', ROUND(
      COUNT(*) FILTER (WHERE status IN ('opened', 'clicked'))::numeric /
      NULLIF(COUNT(*) FILTER (WHERE status IN ('delivered', 'opened', 'clicked')), 0) * 100, 2
    ),
    'lastDelivered', MAX(delivered_at),
    'lastOpened', MAX(opened_at),
    'recentEmails', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', id,
        'type', email_type,
        'template', template_slug,
        'status', status,
        'sentAt', sent_at,
        'deliveredAt', delivered_at,
        'openedAt', opened_at
      ) ORDER BY queued_at DESC), '[]'::jsonb)
      FROM (
        SELECT id, email_type, template_slug, status, sent_at, delivered_at, opened_at, queued_at
        FROM email_delivery_log
        WHERE user_id = p_user_id
        ORDER BY queued_at DESC
        LIMIT 10
      ) recent
    )
  )
  FROM email_delivery_log
  WHERE user_id = p_user_id
    AND queued_at > NOW() - INTERVAL '90 days';
$$;

GRANT EXECUTE ON FUNCTION get_user_email_metrics(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION get_user_email_metrics(uuid) TO service_role;

-- -----------------------------------------------------------------------------
-- Function: Get Campaign Fairness Metrics
-- Metrics showing delivery distribution and fairness
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_campaign_fairness_metrics(p_campaign_id uuid)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  WITH stats AS (
    SELECT
      COUNT(DISTINCT user_id) AS total_users,
      COUNT(*) FILTER (WHERE status = 'queued') AS pending,
      COUNT(*) FILTER (WHERE status = 'sent') AS sent,
      COUNT(*) FILTER (WHERE status IN ('delivered', 'opened', 'clicked')) AS delivered,
      COUNT(*) FILTER (WHERE status IN ('opened', 'clicked')) AS opened,
      COUNT(*) FILTER (WHERE status = 'clicked') AS clicked,
      COUNT(*) FILTER (WHERE status = 'bounced') AS bounced,
      COUNT(*) FILTER (WHERE status = 'failed') AS failed,
      MIN(sent_at) AS first_sent,
      MAX(sent_at) AS last_sent,
      AVG(EXTRACT(EPOCH FROM (sent_at - queued_at))) AS avg_queue_time_sec
    FROM email_delivery_log
    WHERE campaign_id = p_campaign_id
  ),
  campaign_info AS (
    SELECT
      id,
      name,
      subject,
      status AS campaign_status,
      created_at,
      sent_at AS campaign_sent_at
    FROM newsletter_campaigns
    WHERE id = p_campaign_id
  )
  SELECT jsonb_build_object(
    'campaignId', p_campaign_id,
    'campaignName', ci.name,
    'campaignSubject', ci.subject,
    'campaignStatus', ci.campaign_status,
    'totalUsers', s.total_users,
    'pending', s.pending,
    'sent', s.sent,
    'delivered', s.delivered,
    'opened', s.opened,
    'clicked', s.clicked,
    'bounced', s.bounced,
    'failed', s.failed,
    'deliveryRate', ROUND(s.delivered::numeric / NULLIF(s.total_users, 0) * 100, 2),
    'openRate', ROUND(s.opened::numeric / NULLIF(s.delivered, 0) * 100, 2),
    'clickRate', ROUND(s.clicked::numeric / NULLIF(s.opened, 0) * 100, 2),
    'bounceRate', ROUND(s.bounced::numeric / NULLIF(s.total_users, 0) * 100, 2),
    'firstSent', s.first_sent,
    'lastSent', s.last_sent,
    'avgQueueTimeSec', ROUND(s.avg_queue_time_sec::numeric, 2),
    'isComplete', s.pending = 0
  )
  FROM stats s
  CROSS JOIN campaign_info ci;
$$;

GRANT EXECUTE ON FUNCTION get_campaign_fairness_metrics(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION get_campaign_fairness_metrics(uuid) TO service_role;

-- -----------------------------------------------------------------------------
-- Function: Update Email Status
-- Updates delivery status from webhook events
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION update_email_delivery_status(
  p_message_id text,
  p_status text,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated boolean := false;
BEGIN
  -- Validate status
  IF p_status NOT IN ('sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained', 'failed') THEN
    RAISE EXCEPTION 'Invalid status: %', p_status;
  END IF;

  UPDATE email_delivery_log
  SET
    status = p_status,
    sent_at = CASE WHEN p_status = 'sent' AND sent_at IS NULL THEN now() ELSE sent_at END,
    delivered_at = CASE WHEN p_status = 'delivered' AND delivered_at IS NULL THEN now() ELSE delivered_at END,
    opened_at = CASE WHEN p_status IN ('opened', 'clicked') AND opened_at IS NULL THEN now() ELSE opened_at END,
    clicked_at = CASE WHEN p_status = 'clicked' AND clicked_at IS NULL THEN now() ELSE clicked_at END,
    error_code = CASE WHEN p_status IN ('bounced', 'failed') THEN p_metadata->>'errorCode' ELSE error_code END,
    error_message = CASE WHEN p_status IN ('bounced', 'failed') THEN p_metadata->>'errorMessage' ELSE error_message END,
    metadata = metadata || p_metadata,
    updated_at = now()
  WHERE message_id = p_message_id
  RETURNING true INTO v_updated;

  RETURN COALESCE(v_updated, false);
END;
$$;

GRANT EXECUTE ON FUNCTION update_email_delivery_status(text, text, jsonb) TO service_role;

-- -----------------------------------------------------------------------------
-- Function: Get Pending Emails for Processing
-- Returns batch of queued emails for processing
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_pending_emails_for_processing(
  p_batch_size integer DEFAULT 100,
  p_provider text DEFAULT NULL
)
RETURNS TABLE(
  id uuid,
  user_id uuid,
  campaign_id uuid,
  email_type text,
  template_slug text,
  user_email text,
  user_first_name text,
  retry_count integer,
  metadata jsonb
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    edl.id,
    edl.user_id,
    edl.campaign_id,
    edl.email_type,
    edl.template_slug,
    p.email AS user_email,
    p.first_name AS user_first_name,
    edl.retry_count,
    edl.metadata
  FROM email_delivery_log edl
  JOIN profiles p ON p.id = edl.user_id
  WHERE edl.status = 'queued'
    AND edl.retry_count < 3
    AND p.email IS NOT NULL
  ORDER BY edl.queued_at ASC
  LIMIT p_batch_size
  FOR UPDATE OF edl SKIP LOCKED;
$$;

GRANT EXECUTE ON FUNCTION get_pending_emails_for_processing(integer, text) TO service_role;

-- -----------------------------------------------------------------------------
-- Function: Mark Email as Sent
-- Updates email status after successful send
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION mark_email_as_sent(
  p_delivery_id uuid,
  p_provider text,
  p_message_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE email_delivery_log
  SET
    status = 'sent',
    provider = p_provider,
    message_id = p_message_id,
    sent_at = now(),
    updated_at = now()
  WHERE id = p_delivery_id
    AND status = 'queued';

  RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION mark_email_as_sent(uuid, text, text) TO service_role;

-- -----------------------------------------------------------------------------
-- Function: Mark Email as Failed
-- Updates email status on send failure
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION mark_email_as_failed(
  p_delivery_id uuid,
  p_error_code text,
  p_error_message text,
  p_should_retry boolean DEFAULT true
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE email_delivery_log
  SET
    status = CASE WHEN p_should_retry AND retry_count < 2 THEN 'queued' ELSE 'failed' END,
    error_code = p_error_code,
    error_message = p_error_message,
    retry_count = retry_count + 1,
    updated_at = now()
  WHERE id = p_delivery_id;

  RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION mark_email_as_failed(uuid, text, text, boolean) TO service_role;

-- -----------------------------------------------------------------------------
-- Comments
-- -----------------------------------------------------------------------------

COMMENT ON TABLE email_delivery_log IS 'Tracks every email delivery with status and timing';
COMMENT ON COLUMN email_delivery_log.status IS 'Delivery status: queued, sent, delivered, opened, clicked, bounced, complained, failed';
COMMENT ON COLUMN email_delivery_log.message_id IS 'Provider-assigned message ID for webhook correlation';

COMMENT ON MATERIALIZED VIEW user_email_health IS 'Aggregated 90-day email delivery stats per user';

COMMENT ON FUNCTION refresh_user_email_health() IS 'Refreshes user email health stats (call daily via cron)';
COMMENT ON FUNCTION get_underserved_users(uuid, integer) IS 'Gets users who should receive emails first for fairness';
COMMENT ON FUNCTION queue_newsletter_fair(uuid, integer) IS 'Queues newsletter emails with fairness algorithm';
COMMENT ON FUNCTION get_user_email_metrics(uuid) IS 'Gets comprehensive email metrics for a user';
COMMENT ON FUNCTION get_campaign_fairness_metrics(uuid) IS 'Gets delivery fairness metrics for a campaign';
COMMENT ON FUNCTION update_email_delivery_status(text, text, jsonb) IS 'Updates email status from webhook events';
COMMENT ON FUNCTION get_pending_emails_for_processing(integer, text) IS 'Gets batch of queued emails for processing';
