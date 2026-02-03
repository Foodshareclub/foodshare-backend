-- Migration: Add free_premium_trial feature flag
-- Toggle this to true to unlock map and challenges for all users

-- Insert the free_premium_trial flag (disabled by default)
-- Toggle this to true in the Supabase dashboard to unlock map and challenges
INSERT INTO public.feature_flags (flag_key, enabled, description)
VALUES (
    'free_premium_trial',
    false,
    'Temporarily unlock map and challenges for all users without requiring premium subscription'
)
ON CONFLICT (flag_key) DO UPDATE SET
    description = EXCLUDED.description,
    updated_at = now();
