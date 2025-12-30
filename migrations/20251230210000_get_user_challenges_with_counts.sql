-- Migration: Create get_user_challenges_with_counts RPC function
-- This function returns user's challenges with joined/completed counts
-- Used by iOS app's ChallengesViewModel

CREATE OR REPLACE FUNCTION get_user_challenges_with_counts(p_user_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    result json;
BEGIN
    SELECT json_build_object(
        'challenges', COALESCE((
            SELECT json_agg(
                json_build_object(
                    'challenge', json_build_object(
                        'id', c.id,
                        'profile_id', c.profile_id,
                        'challenge_title', c.challenge_title,
                        'challenge_description', c.challenge_description,
                        'challenge_difficulty', c.challenge_difficulty,
                        'challenge_action', c.challenge_action,
                        'challenge_score', c.challenge_score,
                        'challenged_people', c.challenged_people,
                        'challenge_image', c.challenge_image,
                        'challenge_views', c.challenge_views,
                        'challenge_published', c.challenge_published,
                        'challenge_likes_counter', c.challenge_likes_counter,
                        'challenge_created_at', c.challenge_created_at,
                        'challenge_updated_at', c.challenge_updated_at
                    ),
                    'activity', json_build_object(
                        'id', ca.id,
                        'challenge_id', ca.challenge_id,
                        'profile_id', p_user_id,
                        'progress', 0,
                        'accepted_at', CASE WHEN ca.user_accepted_challenge = p_user_id THEN ca.created_at ELSE NULL END,
                        'completed_at', CASE WHEN ca.user_completed_challenge = p_user_id THEN ca.created_at ELSE NULL END,
                        'rejected_at', CASE WHEN ca.user_rejected_challenge = p_user_id THEN ca.created_at ELSE NULL END,
                        'created_at', ca.created_at
                    ),
                    'has_accepted', ca.user_accepted_challenge = p_user_id,
                    'has_completed', ca.user_completed_challenge = p_user_id
                )
            )
            FROM challenge_activities ca
            JOIN challenges c ON c.id = ca.challenge_id
            WHERE ca.user_accepted_challenge = p_user_id
               OR ca.user_completed_challenge = p_user_id
        ), '[]'::json),
        'joined_count', (
            SELECT COUNT(*)::int
            FROM challenge_activities
            WHERE user_accepted_challenge = p_user_id
        ),
        'completed_count', (
            SELECT COUNT(*)::int
            FROM challenge_activities
            WHERE user_completed_challenge = p_user_id
        )
    ) INTO result;
    
    RETURN result;
END;
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION get_user_challenges_with_counts(uuid) TO authenticated;

COMMENT ON FUNCTION get_user_challenges_with_counts IS 'Returns user challenges with joined/completed counts for iOS app';
