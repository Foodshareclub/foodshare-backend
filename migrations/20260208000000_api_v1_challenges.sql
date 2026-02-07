-- =============================================================================
-- Challenges API RPC Function
-- =============================================================================
-- Aggregated RPC function for /api-v1-challenges endpoint
-- Returns challenges data with user progress, stats, and leaderboard
-- =============================================================================

CREATE OR REPLACE FUNCTION get_challenges_data(
  p_user_id UUID,
  p_include_completed BOOLEAN DEFAULT TRUE,
  p_include_upcoming BOOLEAN DEFAULT TRUE,
  p_include_leaderboard BOOLEAN DEFAULT TRUE,
  p_leaderboard_limit INT DEFAULT 10,
  p_completed_limit INT DEFAULT 5
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
  v_active_challenges JSONB;
  v_completed_challenges JSONB;
  v_upcoming_challenges JSONB;
  v_user_stats JSONB;
  v_leaderboard JSONB;
  v_user_rank INT;
  v_total_participants INT;
BEGIN
  SET LOCAL statement_timeout = '5s';

  -- Get active challenges with user progress
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', c.id,
      'title', c.challenge_title,
      'description', c.challenge_description,
      'type', COALESCE(c.challenge_difficulty, 'daily'),
      'icon_url', c.challenge_image,
      'start_date', c.challenge_created_at,
      'end_date', c.challenge_updated_at,
      'reward_points', c.challenge_score,
      'badge_id', NULL,
      'badge_name', NULL,
      'badge_icon_url', NULL,
      'current_value', COALESCE(
        (SELECT COUNT(*)::int 
         FROM challenge_activities ca 
         WHERE ca.challenge_id = c.id 
           AND ca.user_accepted_challenge = p_user_id),
        0
      ),
      'target_value', COALESCE(c.challenged_people, 1),
      'completed_at', (
        SELECT ca.created_at 
        FROM challenge_activities ca 
        WHERE ca.challenge_id = c.id 
          AND ca.user_completed_challenge = p_user_id 
        LIMIT 1
      ),
      'claimed_at', NULL
    )
  ), '[]'::jsonb)
  INTO v_active_challenges
  FROM challenges c
  WHERE c.challenge_published = TRUE
    AND c.challenge_created_at <= NOW()
    AND (c.challenge_updated_at IS NULL OR c.challenge_updated_at >= NOW())
    AND EXISTS (
      SELECT 1 FROM challenge_activities ca 
      WHERE ca.challenge_id = c.id 
        AND ca.user_accepted_challenge = p_user_id
        AND ca.user_completed_challenge IS NULL
    );

  -- Get completed challenges (if requested)
  IF p_include_completed THEN
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'id', c.id,
        'title', c.challenge_title,
        'description', c.challenge_description,
        'type', COALESCE(c.challenge_difficulty, 'daily'),
        'icon_url', c.challenge_image,
        'reward_points', c.challenge_score,
        'badge_id', NULL,
        'badge_name', NULL,
        'completed_at', ca.created_at,
        'claimed_at', NULL
      )
    ), '[]'::jsonb)
    INTO v_completed_challenges
    FROM challenges c
    JOIN challenge_activities ca ON ca.challenge_id = c.id
    WHERE ca.user_completed_challenge = p_user_id
    ORDER BY ca.created_at DESC
    LIMIT p_completed_limit;
  ELSE
    v_completed_challenges := '[]'::jsonb;
  END IF;

  -- Get upcoming challenges (if requested)
  IF p_include_upcoming THEN
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'id', c.id,
        'title', c.challenge_title,
        'description', c.challenge_description,
        'type', COALESCE(c.challenge_difficulty, 'daily'),
        'icon_url', c.challenge_image,
        'start_date', c.challenge_created_at,
        'end_date', c.challenge_updated_at,
        'reward_points', c.challenge_score,
        'badge_id', NULL
      )
    ), '[]'::jsonb)
    INTO v_upcoming_challenges
    FROM challenges c
    WHERE c.challenge_published = TRUE
      AND c.challenge_created_at > NOW()
    ORDER BY c.challenge_created_at ASC
    LIMIT 5;
  ELSE
    v_upcoming_challenges := '[]'::jsonb;
  END IF;

  -- Get user stats
  SELECT jsonb_build_object(
    'total_completed', COUNT(*) FILTER (WHERE ca.user_completed_challenge = p_user_id),
    'current_streak', 0,
    'points_earned', COALESCE(SUM(c.challenge_score) FILTER (WHERE ca.user_completed_challenge = p_user_id), 0),
    'badges_earned', 0
  )
  INTO v_user_stats
  FROM challenge_activities ca
  JOIN challenges c ON c.id = ca.challenge_id
  WHERE ca.user_accepted_challenge = p_user_id OR ca.user_completed_challenge = p_user_id;

  -- Get leaderboard (if requested)
  IF p_include_leaderboard THEN
    WITH user_points AS (
      SELECT 
        ca.user_completed_challenge AS user_id,
        COUNT(*) AS challenges_completed,
        COALESCE(SUM(c.challenge_score), 0) AS points
      FROM challenge_activities ca
      JOIN challenges c ON c.id = ca.challenge_id
      WHERE ca.user_completed_challenge IS NOT NULL
      GROUP BY ca.user_completed_challenge
    ),
    ranked_users AS (
      SELECT 
        up.user_id,
        up.points,
        up.challenges_completed,
        ROW_NUMBER() OVER (ORDER BY up.points DESC, up.challenges_completed DESC) AS rank
      FROM user_points up
    )
    SELECT 
      COALESCE(jsonb_agg(
        jsonb_build_object(
          'user_id', ru.user_id,
          'display_name', p.display_name,
          'avatar_url', p.avatar_url,
          'points', ru.points,
          'challenges_completed', ru.challenges_completed,
          'is_verified', FALSE,
          'member_since', p.created_at
        )
        ORDER BY ru.rank
      ), '[]'::jsonb),
      (SELECT rank FROM ranked_users WHERE user_id = p_user_id),
      (SELECT COUNT(*)::int FROM ranked_users)
    INTO v_leaderboard, v_user_rank, v_total_participants
    FROM ranked_users ru
    JOIN profiles p ON p.id = ru.user_id
    WHERE ru.rank <= p_leaderboard_limit;
  ELSE
    v_leaderboard := '[]'::jsonb;
    v_user_rank := NULL;
    v_total_participants := 0;
  END IF;

  -- Build final result
  v_result := jsonb_build_object(
    'active_challenges', v_active_challenges,
    'completed_challenges', v_completed_challenges,
    'upcoming_challenges', v_upcoming_challenges,
    'user_stats', v_user_stats,
    'leaderboard', v_leaderboard,
    'user_rank', v_user_rank,
    'total_participants', v_total_participants
  );

  RETURN v_result;
END;
$$;

-- =============================================================================
-- Claim Challenge Reward Function
-- =============================================================================

CREATE OR REPLACE FUNCTION claim_challenge_reward(
  p_user_id UUID,
  p_challenge_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_challenge RECORD;
  v_activity RECORD;
  v_points_awarded INT;
  v_new_total_points INT;
BEGIN
  -- Get challenge details
  SELECT * INTO v_challenge
  FROM challenges
  WHERE id = p_challenge_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', FALSE,
      'error', 'Challenge not found'
    );
  END IF;

  -- Get user's activity for this challenge
  SELECT * INTO v_activity
  FROM challenge_activities
  WHERE challenge_id = p_challenge_id
    AND user_completed_challenge = p_user_id
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', FALSE,
      'error', 'Challenge not completed'
    );
  END IF;

  -- Award points (simplified - extend as needed)
  v_points_awarded := v_challenge.challenge_score;
  
  -- Calculate new total (would update user profile in real implementation)
  SELECT COALESCE(SUM(c.challenge_score), 0) + v_points_awarded
  INTO v_new_total_points
  FROM challenge_activities ca
  JOIN challenges c ON c.id = ca.challenge_id
  WHERE ca.user_completed_challenge = p_user_id;

  RETURN jsonb_build_object(
    'success', TRUE,
    'points_awarded', v_points_awarded,
    'new_total_points', v_new_total_points,
    'badge_id', NULL,
    'badge_name', NULL,
    'badge_icon_url', NULL
  );
END;
$$;

-- =============================================================================
-- Permissions
-- =============================================================================

GRANT EXECUTE ON FUNCTION get_challenges_data TO authenticated;
GRANT EXECUTE ON FUNCTION claim_challenge_reward TO authenticated;

COMMENT ON FUNCTION get_challenges_data IS 'Returns aggregated challenges data for /api-v1-challenges endpoint';
COMMENT ON FUNCTION claim_challenge_reward IS 'Claims reward for completed challenge';
