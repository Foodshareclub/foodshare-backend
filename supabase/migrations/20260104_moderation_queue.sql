-- Content Moderation Tables
-- Provides infrastructure for content moderation across all content types

-- ============================================================================
-- MODERATION RESULTS
-- Stores final moderation decisions for content
-- ============================================================================

CREATE TABLE IF NOT EXISTS moderation_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_id UUID NOT NULL,
    content_type TEXT NOT NULL CHECK (content_type IN ('listing', 'message', 'review', 'forum_post', 'forum_comment', 'profile', 'report')),
    decision TEXT NOT NULL CHECK (decision IN ('approve', 'approve_with_warning', 'require_review', 'auto_reject', 'shadowban')),
    actions TEXT[] DEFAULT '{}',
    severity TEXT NOT NULL DEFAULT 'none' CHECK (severity IN ('none', 'low', 'medium', 'high', 'critical')),
    confidence DOUBLE PRECISION DEFAULT 1.0,
    status TEXT NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review', 'completed', 'overturned', 'appealed')),
    reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(content_id, content_type)
);

-- Indexes
CREATE INDEX idx_moderation_results_content ON moderation_results(content_id, content_type);
CREATE INDEX idx_moderation_results_status ON moderation_results(status) WHERE status = 'pending_review';
CREATE INDEX idx_moderation_results_decision ON moderation_results(decision);
CREATE INDEX idx_moderation_results_severity ON moderation_results(severity) WHERE severity IN ('high', 'critical');
CREATE INDEX idx_moderation_results_created ON moderation_results(created_at DESC);

-- ============================================================================
-- MODERATION QUEUE
-- Queue for content requiring manual review
-- ============================================================================

CREATE TABLE IF NOT EXISTS moderation_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_id UUID NOT NULL,
    content_type TEXT NOT NULL,
    reason TEXT NOT NULL,
    priority INTEGER DEFAULT 5 CHECK (priority >= 1 AND priority <= 10),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_review', 'completed', 'escalated')),
    assigned_to UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    assigned_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_moderation_queue_status ON moderation_queue(status, priority DESC) WHERE status = 'pending';
CREATE INDEX idx_moderation_queue_assigned ON moderation_queue(assigned_to) WHERE assigned_to IS NOT NULL;
CREATE INDEX idx_moderation_queue_content ON moderation_queue(content_id, content_type);
CREATE INDEX idx_moderation_queue_created ON moderation_queue(created_at DESC);

-- ============================================================================
-- MODERATION REPORTS
-- User-submitted content reports
-- ============================================================================

CREATE TABLE IF NOT EXISTS moderation_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_id UUID NOT NULL,
    content_type TEXT NOT NULL,
    reporter_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    details TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewing', 'resolved', 'dismissed')),
    resolution TEXT,
    resolved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_moderation_reports_content ON moderation_reports(content_id, content_type);
CREATE INDEX idx_moderation_reports_reporter ON moderation_reports(reporter_id);
CREATE INDEX idx_moderation_reports_status ON moderation_reports(status) WHERE status = 'pending';
CREATE INDEX idx_moderation_reports_created ON moderation_reports(created_at DESC);

-- Prevent duplicate reports
CREATE UNIQUE INDEX idx_moderation_reports_unique ON moderation_reports(content_id, content_type, reporter_id)
    WHERE status = 'pending';

-- ============================================================================
-- USER MODERATION HISTORY
-- Tracks user's moderation history for trust scoring
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_moderation_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    violation_count INTEGER DEFAULT 0,
    warning_count INTEGER DEFAULT 0,
    last_violation_at TIMESTAMPTZ,
    last_warning_at TIMESTAMPTZ,
    trust_score DOUBLE PRECISION DEFAULT 0.8 CHECK (trust_score >= 0 AND trust_score <= 1),
    is_shadowbanned BOOLEAN DEFAULT FALSE,
    shadowbanned_at TIMESTAMPTZ,
    is_suspended BOOLEAN DEFAULT FALSE,
    suspended_at TIMESTAMPTZ,
    suspended_until TIMESTAMPTZ,
    suspension_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id)
);

-- Indexes
CREATE INDEX idx_user_moderation_shadowban ON user_moderation_history(user_id) WHERE is_shadowbanned = TRUE;
CREATE INDEX idx_user_moderation_suspended ON user_moderation_history(user_id) WHERE is_suspended = TRUE;
CREATE INDEX idx_user_moderation_trust ON user_moderation_history(trust_score) WHERE trust_score < 0.5;

-- ============================================================================
-- MODERATION LOG
-- Audit log for all moderation activities
-- ============================================================================

CREATE TABLE IF NOT EXISTS moderation_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_type TEXT NOT NULL,
    content_id UUID,
    user_id UUID,
    action TEXT NOT NULL,
    decision TEXT,
    severity TEXT,
    flags TEXT[] DEFAULT '{}',
    moderator_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    notes TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_moderation_log_content ON moderation_log(content_id, content_type);
CREATE INDEX idx_moderation_log_user ON moderation_log(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_moderation_log_moderator ON moderation_log(moderator_id) WHERE moderator_id IS NOT NULL;
CREATE INDEX idx_moderation_log_created ON moderation_log(created_at DESC);

-- Partition by month for performance (optional)
-- CREATE INDEX idx_moderation_log_created_month ON moderation_log(date_trunc('month', created_at));

-- ============================================================================
-- APPEAL REQUESTS
-- Appeals for moderation decisions
-- ============================================================================

CREATE TABLE IF NOT EXISTS moderation_appeals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    moderation_result_id UUID NOT NULL REFERENCES moderation_results(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    additional_info TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewing', 'approved', 'denied')),
    reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMPTZ,
    decision_notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_moderation_appeals_status ON moderation_appeals(status) WHERE status = 'pending';
CREATE INDEX idx_moderation_appeals_user ON moderation_appeals(user_id);
CREATE INDEX idx_moderation_appeals_result ON moderation_appeals(moderation_result_id);

-- Prevent multiple appeals for same decision
CREATE UNIQUE INDEX idx_moderation_appeals_unique ON moderation_appeals(moderation_result_id, user_id)
    WHERE status IN ('pending', 'reviewing');

-- ============================================================================
-- MODERATION KEYWORDS
-- Configurable keyword lists for filtering
-- ============================================================================

CREATE TABLE IF NOT EXISTS moderation_keywords (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    keyword TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('profanity', 'hate_speech', 'prohibited', 'spam', 'pii_pattern')),
    severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    is_regex BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    notes TEXT,
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(keyword, category)
);

-- Indexes
CREATE INDEX idx_moderation_keywords_category ON moderation_keywords(category) WHERE is_active = TRUE;
CREATE INDEX idx_moderation_keywords_active ON moderation_keywords(is_active);

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

ALTER TABLE moderation_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE moderation_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE moderation_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_moderation_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE moderation_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE moderation_appeals ENABLE ROW LEVEL SECURITY;
ALTER TABLE moderation_keywords ENABLE ROW LEVEL SECURITY;

-- Service role full access
CREATE POLICY "Service role full access to moderation_results"
    ON moderation_results FOR ALL
    USING (auth.jwt()->>'role' = 'service_role');

CREATE POLICY "Service role full access to moderation_queue"
    ON moderation_queue FOR ALL
    USING (auth.jwt()->>'role' = 'service_role');

CREATE POLICY "Service role full access to moderation_reports"
    ON moderation_reports FOR ALL
    USING (auth.jwt()->>'role' = 'service_role');

CREATE POLICY "Service role full access to user_moderation_history"
    ON user_moderation_history FOR ALL
    USING (auth.jwt()->>'role' = 'service_role');

CREATE POLICY "Service role full access to moderation_log"
    ON moderation_log FOR ALL
    USING (auth.jwt()->>'role' = 'service_role');

CREATE POLICY "Service role full access to moderation_appeals"
    ON moderation_appeals FOR ALL
    USING (auth.jwt()->>'role' = 'service_role');

CREATE POLICY "Service role full access to moderation_keywords"
    ON moderation_keywords FOR ALL
    USING (auth.jwt()->>'role' = 'service_role');

-- Users can view their own moderation status
CREATE POLICY "Users can view own moderation history"
    ON user_moderation_history FOR SELECT
    USING (auth.uid() = user_id);

-- Users can submit reports
CREATE POLICY "Users can submit reports"
    ON moderation_reports FOR INSERT
    WITH CHECK (auth.uid() = reporter_id);

-- Users can view their own reports
CREATE POLICY "Users can view own reports"
    ON moderation_reports FOR SELECT
    USING (auth.uid() = reporter_id);

-- Users can submit appeals
CREATE POLICY "Users can submit appeals"
    ON moderation_appeals FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Users can view their own appeals
CREATE POLICY "Users can view own appeals"
    ON moderation_appeals FOR SELECT
    USING (auth.uid() = user_id);

-- ============================================================================
-- FUNCTIONS
-- ============================================================================

-- Update user moderation history
CREATE OR REPLACE FUNCTION update_user_moderation_history(
    p_user_id UUID,
    p_trust_penalty DOUBLE PRECISION DEFAULT 0.05
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    INSERT INTO user_moderation_history (user_id, violation_count, last_violation_at, trust_score)
    VALUES (p_user_id, 1, NOW(), 0.8 - p_trust_penalty)
    ON CONFLICT (user_id) DO UPDATE SET
        violation_count = user_moderation_history.violation_count + 1,
        last_violation_at = NOW(),
        trust_score = GREATEST(0, user_moderation_history.trust_score - p_trust_penalty),
        updated_at = NOW();
END;
$$;

-- Check if user is shadowbanned
CREATE OR REPLACE FUNCTION is_user_shadowbanned(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_shadowbanned BOOLEAN;
BEGIN
    SELECT is_shadowbanned INTO v_shadowbanned
    FROM user_moderation_history
    WHERE user_id = p_user_id;

    RETURN COALESCE(v_shadowbanned, FALSE);
END;
$$;

-- Get moderation queue for review
CREATE OR REPLACE FUNCTION get_moderation_queue(
    p_limit INTEGER DEFAULT 20,
    p_content_type TEXT DEFAULT NULL
)
RETURNS TABLE (
    id UUID,
    content_id UUID,
    content_type TEXT,
    reason TEXT,
    priority INTEGER,
    status TEXT,
    created_at TIMESTAMPTZ,
    content_preview TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT
        mq.id,
        mq.content_id,
        mq.content_type,
        mq.reason,
        mq.priority,
        mq.status,
        mq.created_at,
        CASE mq.content_type
            WHEN 'listing' THEN (SELECT title FROM posts WHERE id = mq.content_id)
            WHEN 'review' THEN (SELECT LEFT(comment, 100) FROM reviews WHERE id = mq.content_id)
            WHEN 'forum_post' THEN (SELECT title FROM forum_posts WHERE id = mq.content_id)
            ELSE NULL
        END as content_preview
    FROM moderation_queue mq
    WHERE mq.status = 'pending'
        AND (p_content_type IS NULL OR mq.content_type = p_content_type)
    ORDER BY mq.priority DESC, mq.created_at ASC
    LIMIT p_limit;
END;
$$;

-- Resolve moderation queue item
CREATE OR REPLACE FUNCTION resolve_moderation_queue(
    p_queue_id UUID,
    p_decision TEXT,
    p_moderator_id UUID,
    p_notes TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_content_id UUID;
    v_content_type TEXT;
BEGIN
    -- Get queue item
    SELECT content_id, content_type INTO v_content_id, v_content_type
    FROM moderation_queue
    WHERE id = p_queue_id AND status = 'pending';

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    -- Update queue status
    UPDATE moderation_queue
    SET status = 'completed',
        completed_at = NOW(),
        updated_at = NOW()
    WHERE id = p_queue_id;

    -- Update moderation result
    UPDATE moderation_results
    SET decision = p_decision,
        status = 'completed',
        reviewed_by = p_moderator_id,
        reviewed_at = NOW(),
        updated_at = NOW()
    WHERE content_id = v_content_id AND content_type = v_content_type;

    -- Log the action
    INSERT INTO moderation_log (
        content_type, content_id, action, decision, moderator_id, notes
    ) VALUES (
        v_content_type, v_content_id, 'manual_review', p_decision, p_moderator_id, p_notes
    );

    RETURN TRUE;
END;
$$;

-- Get moderation statistics
CREATE OR REPLACE FUNCTION get_moderation_stats(
    p_start_date DATE DEFAULT CURRENT_DATE - INTERVAL '30 days',
    p_end_date DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE (
    total_items BIGINT,
    auto_approved BIGINT,
    auto_rejected BIGINT,
    manual_review BIGINT,
    avg_processing_time_ms DOUBLE PRECISION,
    top_flags JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT
        COUNT(*) as total_items,
        COUNT(*) FILTER (WHERE decision = 'approve') as auto_approved,
        COUNT(*) FILTER (WHERE decision = 'auto_reject') as auto_rejected,
        COUNT(*) FILTER (WHERE decision = 'require_review') as manual_review,
        AVG((metadata->>'processingTimeMs')::DOUBLE PRECISION) as avg_processing_time_ms,
        (
            SELECT jsonb_agg(flag_counts)
            FROM (
                SELECT jsonb_build_object('flag', flag, 'count', COUNT(*)) as flag_counts
                FROM moderation_log, unnest(flags) as flag
                WHERE created_at >= p_start_date AND created_at <= p_end_date
                GROUP BY flag
                ORDER BY COUNT(*) DESC
                LIMIT 10
            ) top
        ) as top_flags
    FROM moderation_results
    WHERE created_at >= p_start_date AND created_at <= p_end_date;
END;
$$;

-- Clean up old moderation logs (retention: 180 days)
CREATE OR REPLACE FUNCTION cleanup_old_moderation_logs()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM moderation_log
    WHERE created_at < NOW() - INTERVAL '180 days';

    GET DIAGNOSTICS deleted_count = ROW_COUNT;

    -- Also clean completed queue items older than 30 days
    DELETE FROM moderation_queue
    WHERE status = 'completed'
        AND completed_at < NOW() - INTERVAL '30 days';

    RETURN deleted_count;
END;
$$;

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_moderation_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

CREATE TRIGGER moderation_results_updated_at
    BEFORE UPDATE ON moderation_results
    FOR EACH ROW
    EXECUTE FUNCTION update_moderation_updated_at();

CREATE TRIGGER moderation_queue_updated_at
    BEFORE UPDATE ON moderation_queue
    FOR EACH ROW
    EXECUTE FUNCTION update_moderation_updated_at();

CREATE TRIGGER moderation_reports_updated_at
    BEFORE UPDATE ON moderation_reports
    FOR EACH ROW
    EXECUTE FUNCTION update_moderation_updated_at();

CREATE TRIGGER user_moderation_history_updated_at
    BEFORE UPDATE ON user_moderation_history
    FOR EACH ROW
    EXECUTE FUNCTION update_moderation_updated_at();

CREATE TRIGGER moderation_appeals_updated_at
    BEFORE UPDATE ON moderation_appeals
    FOR EACH ROW
    EXECUTE FUNCTION update_moderation_updated_at();

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE moderation_results IS 'Final moderation decisions for all content types';
COMMENT ON TABLE moderation_queue IS 'Queue for content requiring manual moderation review';
COMMENT ON TABLE moderation_reports IS 'User-submitted reports of policy violations';
COMMENT ON TABLE user_moderation_history IS 'User moderation history for trust scoring';
COMMENT ON TABLE moderation_log IS 'Audit log of all moderation activities';
COMMENT ON TABLE moderation_appeals IS 'Appeals submitted for moderation decisions';
COMMENT ON TABLE moderation_keywords IS 'Configurable keyword lists for content filtering';
