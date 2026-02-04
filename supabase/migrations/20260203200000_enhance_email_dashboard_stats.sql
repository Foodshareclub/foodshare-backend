-- ============================================================================
-- Enhanced Email Dashboard Statistics
-- Provides real-time metrics from email_delivery_log and provider tracking
-- ============================================================================

-- Create email_provider_stats table for real-time provider tracking
CREATE TABLE IF NOT EXISTS email_provider_stats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  date date NOT NULL DEFAULT CURRENT_DATE,

  -- Request counts
  requests_total integer NOT NULL DEFAULT 0,
  requests_success integer NOT NULL DEFAULT 0,
  requests_failed integer NOT NULL DEFAULT 0,

  -- Delivery stats
  emails_sent integer NOT NULL DEFAULT 0,
  emails_delivered integer NOT NULL DEFAULT 0,
  emails_opened integer NOT NULL DEFAULT 0,
  emails_clicked integer NOT NULL DEFAULT 0,
  emails_bounced integer NOT NULL DEFAULT 0,
  emails_complained integer NOT NULL DEFAULT 0,

  -- Performance
  avg_latency_ms integer NOT NULL DEFAULT 0,
  total_latency_ms bigint NOT NULL DEFAULT 0,

  -- Quotas
  daily_quota_limit integer NOT NULL DEFAULT 500,
  monthly_quota_limit integer NOT NULL DEFAULT 15000,

  -- Timestamps
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE(provider, date)
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_email_provider_stats_provider_date
  ON email_provider_stats(provider, date DESC);

-- ============================================================================
-- Increment provider stats (called after each email operation)
-- ============================================================================

CREATE OR REPLACE FUNCTION increment_email_provider_stats(
  p_provider text,
  p_success boolean,
  p_latency_ms integer DEFAULT 0
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO email_provider_stats (
    provider, date, requests_total, requests_success, requests_failed,
    emails_sent, avg_latency_ms, total_latency_ms
  )
  VALUES (
    p_provider, CURRENT_DATE, 1,
    CASE WHEN p_success THEN 1 ELSE 0 END,
    CASE WHEN p_success THEN 0 ELSE 1 END,
    CASE WHEN p_success THEN 1 ELSE 0 END,
    p_latency_ms, p_latency_ms
  )
  ON CONFLICT (provider, date) DO UPDATE SET
    requests_total = email_provider_stats.requests_total + 1,
    requests_success = email_provider_stats.requests_success + CASE WHEN p_success THEN 1 ELSE 0 END,
    requests_failed = email_provider_stats.requests_failed + CASE WHEN p_success THEN 0 ELSE 1 END,
    emails_sent = email_provider_stats.emails_sent + CASE WHEN p_success THEN 1 ELSE 0 END,
    total_latency_ms = email_provider_stats.total_latency_ms + p_latency_ms,
    avg_latency_ms = CASE
      WHEN email_provider_stats.requests_total > 0
      THEN ((email_provider_stats.total_latency_ms + p_latency_ms) / (email_provider_stats.requests_total + 1))::integer
      ELSE p_latency_ms
    END,
    updated_at = now();
END;
$$;

-- ============================================================================
-- Update delivery event stats (called by webhook handler)
-- ============================================================================

CREATE OR REPLACE FUNCTION update_email_provider_delivery_stats(
  p_provider text,
  p_status text,
  p_date date DEFAULT CURRENT_DATE
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO email_provider_stats (provider, date)
  VALUES (p_provider, p_date)
  ON CONFLICT (provider, date) DO UPDATE SET
    emails_delivered = email_provider_stats.emails_delivered + CASE WHEN p_status = 'delivered' THEN 1 ELSE 0 END,
    emails_opened = email_provider_stats.emails_opened + CASE WHEN p_status = 'opened' THEN 1 ELSE 0 END,
    emails_clicked = email_provider_stats.emails_clicked + CASE WHEN p_status = 'clicked' THEN 1 ELSE 0 END,
    emails_bounced = email_provider_stats.emails_bounced + CASE WHEN p_status = 'bounced' THEN 1 ELSE 0 END,
    emails_complained = email_provider_stats.emails_complained + CASE WHEN p_status = 'complained' THEN 1 ELSE 0 END,
    updated_at = now();
END;
$$;

-- ============================================================================
-- Enhanced Dashboard Stats (uses real data from email_delivery_log)
-- ============================================================================

DROP FUNCTION IF EXISTS get_email_dashboard_stats_v2();
CREATE OR REPLACE FUNCTION get_email_dashboard_stats_v2()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
  v_result jsonb;
  v_today date := CURRENT_DATE;
  v_30_days_ago date := CURRENT_DATE - INTERVAL '30 days';
  v_7_days_ago date := CURRENT_DATE - INTERVAL '7 days';
BEGIN
  SELECT jsonb_build_object(
    -- Overall metrics (30 days)
    'totalSent', COALESCE((
      SELECT COUNT(*) FROM email_delivery_log
      WHERE queued_at >= v_30_days_ago AND status != 'queued'
    ), 0),
    'totalDelivered', COALESCE((
      SELECT COUNT(*) FROM email_delivery_log
      WHERE queued_at >= v_30_days_ago AND status IN ('delivered', 'opened', 'clicked')
    ), 0),
    'totalOpened', COALESCE((
      SELECT COUNT(*) FROM email_delivery_log
      WHERE queued_at >= v_30_days_ago AND status IN ('opened', 'clicked')
    ), 0),
    'totalClicked', COALESCE((
      SELECT COUNT(*) FROM email_delivery_log
      WHERE queued_at >= v_30_days_ago AND status = 'clicked'
    ), 0),
    'totalBounced', COALESCE((
      SELECT COUNT(*) FROM email_delivery_log
      WHERE queued_at >= v_30_days_ago AND status = 'bounced'
    ), 0),
    'totalFailed', COALESCE((
      SELECT COUNT(*) FROM email_delivery_log
      WHERE queued_at >= v_30_days_ago AND status = 'failed'
    ), 0),
    'totalComplained', COALESCE((
      SELECT COUNT(*) FROM email_delivery_log
      WHERE queued_at >= v_30_days_ago AND status = 'complained'
    ), 0),

    -- Today's metrics
    'sentToday', COALESCE((
      SELECT COUNT(*) FROM email_delivery_log
      WHERE queued_at >= v_today AND status != 'queued'
    ), 0),

    -- Queue status
    'queuePending', COALESCE((
      SELECT COUNT(*) FROM email_delivery_log WHERE status = 'queued'
    ), 0),

    -- Subscriber counts
    'totalSubscribers', COALESCE((
      SELECT COUNT(DISTINCT user_id) FROM notification_preferences
      WHERE channel = 'email' AND enabled = true
    ), 0),
    'activeSubscribers', COALESCE((
      SELECT COUNT(DISTINCT np.user_id) FROM notification_preferences np
      JOIN profiles p ON p.id = np.user_id
      WHERE np.channel = 'email' AND np.enabled = true
    ), 0),

    -- Provider stats (today)
    'providers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'provider', provider,
        'requestsTotal', requests_total,
        'requestsSuccess', requests_success,
        'requestsFailed', requests_failed,
        'emailsSent', emails_sent,
        'emailsDelivered', emails_delivered,
        'emailsOpened', emails_opened,
        'emailsClicked', emails_clicked,
        'emailsBounced', emails_bounced,
        'successRate', CASE WHEN requests_total > 0
          THEN ROUND((requests_success::numeric / requests_total) * 100, 1)
          ELSE 100 END,
        'avgLatencyMs', avg_latency_ms,
        'dailyQuotaUsed', emails_sent,
        'dailyQuotaLimit', daily_quota_limit
      ))
      FROM email_provider_stats
      WHERE date = v_today
    ), '[]'::jsonb),

    -- Provider stats (30 days aggregate)
    'providers30d', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'provider', provider,
        'emailsSent', total_sent,
        'emailsDelivered', total_delivered,
        'emailsOpened', total_opened,
        'emailsClicked', total_clicked,
        'emailsBounced', total_bounced,
        'successRate', CASE WHEN total_requests > 0
          THEN ROUND((total_success::numeric / total_requests) * 100, 1)
          ELSE 100 END
      ))
      FROM (
        SELECT
          provider,
          SUM(requests_total) as total_requests,
          SUM(requests_success) as total_success,
          SUM(emails_sent) as total_sent,
          SUM(emails_delivered) as total_delivered,
          SUM(emails_opened) as total_opened,
          SUM(emails_clicked) as total_clicked,
          SUM(emails_bounced) as total_bounced
        FROM email_provider_stats
        WHERE date >= v_30_days_ago
        GROUP BY provider
      ) agg
    ), '[]'::jsonb),

    -- Rates (30 days)
    'openRate', COALESCE((
      SELECT ROUND(
        (COUNT(*) FILTER (WHERE status IN ('opened', 'clicked'))::numeric /
         NULLIF(COUNT(*) FILTER (WHERE status IN ('delivered', 'opened', 'clicked')), 0)) * 100, 1
      )
      FROM email_delivery_log
      WHERE queued_at >= v_30_days_ago
    ), 0),
    'clickRate', COALESCE((
      SELECT ROUND(
        (COUNT(*) FILTER (WHERE status = 'clicked')::numeric /
         NULLIF(COUNT(*) FILTER (WHERE status IN ('opened', 'clicked')), 0)) * 100, 1
      )
      FROM email_delivery_log
      WHERE queued_at >= v_30_days_ago
    ), 0),
    'bounceRate', COALESCE((
      SELECT ROUND(
        (COUNT(*) FILTER (WHERE status = 'bounced')::numeric /
         NULLIF(COUNT(*) FILTER (WHERE status != 'queued'), 0)) * 100, 1
      )
      FROM email_delivery_log
      WHERE queued_at >= v_30_days_ago
    ), 0),

    -- Daily breakdown (last 7 days for chart)
    'dailyStats', COALESCE((
      SELECT jsonb_agg(daily_data ORDER BY day)
      FROM (
        SELECT
          queued_at::date as day,
          jsonb_build_object(
            'date', queued_at::date,
            'sent', COUNT(*) FILTER (WHERE status != 'queued'),
            'delivered', COUNT(*) FILTER (WHERE status IN ('delivered', 'opened', 'clicked')),
            'opened', COUNT(*) FILTER (WHERE status IN ('opened', 'clicked')),
            'clicked', COUNT(*) FILTER (WHERE status = 'clicked'),
            'bounced', COUNT(*) FILTER (WHERE status = 'bounced')
          ) as daily_data
        FROM email_delivery_log
        WHERE queued_at >= v_7_days_ago
        GROUP BY queued_at::date
      ) daily
    ), '[]'::jsonb),

    -- Email type breakdown
    'byType', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'type', email_type,
        'sent', cnt,
        'percentage', ROUND((cnt::numeric / NULLIF(total, 0)) * 100, 1)
      ))
      FROM (
        SELECT
          email_type,
          COUNT(*) as cnt,
          SUM(COUNT(*)) OVER () as total
        FROM email_delivery_log
        WHERE queued_at >= v_30_days_ago AND status != 'queued'
        GROUP BY email_type
      ) type_stats
    ), '[]'::jsonb),

    -- Recent campaigns
    'recentCampaigns', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', id,
        'name', name,
        'subject', subject,
        'sentAt', sent_at,
        'totalSent', total_sent,
        'totalOpened', total_opened,
        'totalClicked', total_clicked,
        'openRate', CASE WHEN total_sent > 0
          THEN ROUND((total_opened::numeric / total_sent) * 100, 1) ELSE 0 END,
        'clickRate', CASE WHEN total_opened > 0
          THEN ROUND((total_clicked::numeric / total_opened) * 100, 1) ELSE 0 END
      ) ORDER BY sent_at DESC)
      FROM newsletter_campaigns
      WHERE status = 'sent' AND sent_at >= v_30_days_ago
      LIMIT 5
    ), '[]'::jsonb),

    -- Metadata
    'generatedAt', now(),
    'periodStart', v_30_days_ago,
    'periodEnd', v_today

  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- ============================================================================
-- Provider health check stats
-- ============================================================================

CREATE OR REPLACE FUNCTION get_email_provider_health()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
BEGIN
  RETURN (
    SELECT jsonb_agg(jsonb_build_object(
      'provider', s.provider,

      -- Today's stats
      'today', jsonb_build_object(
        'requests', COALESCE(t.requests_total, 0),
        'success', COALESCE(t.requests_success, 0),
        'failed', COALESCE(t.requests_failed, 0),
        'successRate', CASE WHEN COALESCE(t.requests_total, 0) > 0
          THEN ROUND((t.requests_success::numeric / t.requests_total) * 100, 1)
          ELSE 100 END,
        'avgLatencyMs', COALESCE(t.avg_latency_ms, 0),
        'sent', COALESCE(t.emails_sent, 0),
        'delivered', COALESCE(t.emails_delivered, 0),
        'opened', COALESCE(t.emails_opened, 0),
        'clicked', COALESCE(t.emails_clicked, 0),
        'bounced', COALESCE(t.emails_bounced, 0)
      ),

      -- This month's stats
      'month', jsonb_build_object(
        'requests', COALESCE(m.requests_total, 0),
        'success', COALESCE(m.requests_success, 0),
        'sent', COALESCE(m.emails_sent, 0),
        'delivered', COALESCE(m.emails_delivered, 0)
      ),

      -- Quotas
      'quota', jsonb_build_object(
        'dailyUsed', COALESCE(t.emails_sent, 0),
        'dailyLimit', COALESCE(t.daily_quota_limit, 500),
        'dailyRemaining', GREATEST(COALESCE(t.daily_quota_limit, 500) - COALESCE(t.emails_sent, 0), 0),
        'monthlyUsed', COALESCE(m.emails_sent, 0),
        'monthlyLimit', COALESCE(t.monthly_quota_limit, 15000),
        'monthlyRemaining', GREATEST(COALESCE(t.monthly_quota_limit, 15000) - COALESCE(m.emails_sent, 0), 0)
      ),

      -- Status
      'status', CASE
        WHEN COALESCE(t.requests_total, 0) = 0 THEN 'idle'
        WHEN COALESCE(t.requests_success, 0)::numeric / NULLIF(t.requests_total, 1) >= 0.95 THEN 'healthy'
        WHEN COALESCE(t.requests_success, 0)::numeric / NULLIF(t.requests_total, 1) >= 0.80 THEN 'degraded'
        ELSE 'unhealthy'
      END
    ))
    FROM (
      SELECT DISTINCT provider FROM email_provider_stats
      UNION
      SELECT unnest(ARRAY['resend', 'brevo', 'aws_ses', 'mailersend'])
    ) s
    LEFT JOIN email_provider_stats t ON t.provider = s.provider AND t.date = CURRENT_DATE
    LEFT JOIN (
      SELECT
        provider,
        SUM(requests_total) as requests_total,
        SUM(requests_success) as requests_success,
        SUM(emails_sent) as emails_sent,
        SUM(emails_delivered) as emails_delivered
      FROM email_provider_stats
      WHERE date >= DATE_TRUNC('month', CURRENT_DATE)
      GROUP BY provider
    ) m ON m.provider = s.provider
  );
END;
$$;

-- ============================================================================
-- Permissions
-- ============================================================================

GRANT SELECT ON email_provider_stats TO authenticated;
GRANT EXECUTE ON FUNCTION increment_email_provider_stats TO service_role;
GRANT EXECUTE ON FUNCTION update_email_provider_delivery_stats TO service_role;
GRANT EXECUTE ON FUNCTION get_email_dashboard_stats_v2 TO authenticated;
GRANT EXECUTE ON FUNCTION get_email_provider_health TO authenticated;

-- ============================================================================
-- RLS
-- ============================================================================

ALTER TABLE email_provider_stats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view email provider stats"
  ON email_provider_stats FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
      WHERE ur.profile_id = auth.uid()
      AND r.name IN ('admin', 'superadmin')
    )
  );

-- ============================================================================
-- Comments
-- ============================================================================

COMMENT ON TABLE email_provider_stats IS
  'Real-time email provider statistics tracked per day per provider';

COMMENT ON FUNCTION get_email_dashboard_stats_v2 IS
  'Comprehensive email dashboard statistics from email_delivery_log';

COMMENT ON FUNCTION get_email_provider_health IS
  'Provider health and quota status for dashboard';

COMMENT ON FUNCTION increment_email_provider_stats IS
  'Called after each email send attempt to track provider performance';

COMMENT ON FUNCTION update_email_provider_delivery_stats IS
  'Called by webhook handler to track delivery events per provider';
