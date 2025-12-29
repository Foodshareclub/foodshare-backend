-- ============================================================================
-- CREATE FEATURE FLAGS TABLE
-- Enterprise feature flag management with percentage rollouts and targeting
-- ============================================================================

-- Create feature_flags table
CREATE TABLE IF NOT EXISTS public.feature_flags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    flag_key TEXT UNIQUE NOT NULL,
    enabled BOOLEAN DEFAULT false NOT NULL,
    rollout_percentage INTEGER DEFAULT 100 CHECK (rollout_percentage >= 0 AND rollout_percentage <= 100),
    target_segments TEXT[] DEFAULT '{}',
    expires_at TIMESTAMPTZ,
    description TEXT,
    category TEXT DEFAULT 'core',
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Add comments
COMMENT ON TABLE public.feature_flags IS 'Enterprise feature flags for controlled rollouts';
COMMENT ON COLUMN public.feature_flags.flag_key IS 'Unique identifier matching FeatureFlag enum rawValue';
COMMENT ON COLUMN public.feature_flags.enabled IS 'Whether the flag is enabled (subject to rollout percentage)';
COMMENT ON COLUMN public.feature_flags.rollout_percentage IS 'Percentage of users (0-100) who should see this flag enabled';
COMMENT ON COLUMN public.feature_flags.target_segments IS 'Array of user segment names this flag applies to';
COMMENT ON COLUMN public.feature_flags.expires_at IS 'Optional expiration date after which flag returns to default';

-- Enable RLS
ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;

-- Everyone can read feature flags (they're public configuration)
CREATE POLICY "Anyone can read feature flags"
    ON public.feature_flags
    FOR SELECT
    USING (true);

-- Only service role can modify feature flags (admin operations)
CREATE POLICY "Service role can manage feature flags"
    ON public.feature_flags
    FOR ALL
    USING (auth.role() = 'service_role');

-- Create updated_at trigger
CREATE OR REPLACE FUNCTION public.update_feature_flags_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER feature_flags_updated_at
    BEFORE UPDATE ON public.feature_flags
    FOR EACH ROW
    EXECUTE FUNCTION public.update_feature_flags_updated_at();

-- Create index for fast lookups
CREATE INDEX IF NOT EXISTS idx_feature_flags_key ON public.feature_flags(flag_key);
CREATE INDEX IF NOT EXISTS idx_feature_flags_enabled ON public.feature_flags(enabled) WHERE enabled = true;

-- Insert default feature flags
INSERT INTO public.feature_flags (flag_key, enabled, rollout_percentage, category, description) VALUES
    ('new_feed_algorithm', false, 50, 'core', 'New personalized feed algorithm'),
    ('realtime_messaging', true, 100, 'core', 'Real-time message delivery'),
    ('ai_categories', false, 25, 'core', 'AI-powered food categorization'),
    ('advanced_search', true, 100, 'core', 'Enhanced search with filters'),
    ('new_onboarding', false, 30, 'uiux', 'Streamlined onboarding flow'),
    ('liquid_glass_v2', false, 10, 'uiux', 'Enhanced glass morphism design'),
    ('bottom_sheet_nav', false, 20, 'uiux', 'Bottom sheet navigation style'),
    ('rich_haptics', true, 100, 'uiux', 'Haptic feedback for interactions'),
    ('challenges', true, 100, 'social', 'Community food sharing challenges'),
    ('achievements', true, 100, 'social', 'Badges and achievements'),
    ('streaks', false, 50, 'social', 'Consecutive sharing streaks'),
    ('social_sharing', false, 75, 'social', 'Share to external platforms'),
    ('premium_subscription', false, 100, 'premium', 'Premium subscription tier'),
    ('priority_listing', false, 100, 'premium', 'Boost listing visibility'),
    ('user_analytics', false, 100, 'premium', 'User analytics dashboard'),
    ('ar_food_scanner', false, 5, 'experimental', 'AR food scanning'),
    ('voice_listings', false, 5, 'experimental', 'Voice-based listing creation'),
    ('ml_recommendations', false, 15, 'experimental', 'ML-powered recommendations'),
    ('developer_tools', false, 100, 'debug', 'Developer debug menu'),
    ('network_logging', false, 100, 'debug', 'Network request logging'),
    ('performance_overlay', false, 100, 'debug', 'FPS and memory overlay')
ON CONFLICT (flag_key) DO NOTHING;

-- Grant access
GRANT SELECT ON public.feature_flags TO anon, authenticated;
