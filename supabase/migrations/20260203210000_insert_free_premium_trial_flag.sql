-- Migration: Insert free_premium_trial feature flag
-- This is a data migration to insert the feature flag into the existing table

INSERT INTO public.feature_flags (flag_key, display_name, enabled, description)
VALUES (
    'free_premium_trial',
    'Free Premium Trial',
    false,
    'Temporarily unlock map and challenges for all users without requiring premium subscription'
)
ON CONFLICT (flag_key) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    updated_at = now();
