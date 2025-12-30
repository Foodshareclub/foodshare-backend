-- ============================================================================
-- Feature Flags & A/B Testing Infrastructure
-- Extends existing feature_flags table, adds experiments and version checking
-- ============================================================================

-- Don't drop existing feature_flags table - extend it instead
-- Existing table has: id, flag_key, display_name, description, enabled,
-- rollout_percentage, target_segments, expires_at, created_at, updated_at,
-- created_by, metadata

-- Add new columns to existing feature_flags table if they don't exist
DO $$
BEGIN
  -- Add target_platforms if not exists
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'feature_flags' AND column_name = 'target_platforms') THEN
    ALTER TABLE public.feature_flags ADD COLUMN target_platforms text[] DEFAULT '{}';
  END IF;

  -- Add min_app_version if not exists
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'feature_flags' AND column_name = 'min_app_version') THEN
    ALTER TABLE public.feature_flags ADD COLUMN min_app_version jsonb DEFAULT '{}';
  END IF;

  -- Add config if not exists
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'feature_flags' AND column_name = 'config') THEN
    ALTER TABLE public.feature_flags ADD COLUMN config jsonb DEFAULT '{}';
  END IF;

  -- Add enabled_at if not exists
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'feature_flags' AND column_name = 'enabled_at') THEN
    ALTER TABLE public.feature_flags ADD COLUMN enabled_at timestamptz;
  END IF;

  -- Add disabled_at if not exists
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'feature_flags' AND column_name = 'disabled_at') THEN
    ALTER TABLE public.feature_flags ADD COLUMN disabled_at timestamptz;
  END IF;
END $$;

-- Drop other objects to recreate cleanly
DROP TABLE IF EXISTS public.experiment_assignments CASCADE;
DROP TABLE IF EXISTS public.experiments CASCADE;
DROP TABLE IF EXISTS public.feature_flag_overrides CASCADE;
DROP TABLE IF EXISTS public.app_version_requirements CASCADE;
DROP FUNCTION IF EXISTS public.get_user_feature_flags(uuid, text, text);
DROP FUNCTION IF EXISTS public.get_experiment_variant(uuid, text);
DROP FUNCTION IF EXISTS public.check_client_compatibility(text, text);

-- ============================================================================
-- feature_flag_overrides - Per-user flag overrides
-- ============================================================================

CREATE TABLE public.feature_flag_overrides (
  user_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
  flag_key text NOT NULL,  -- References feature_flags.flag_key
  enabled boolean NOT NULL,
  reason text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  expires_at timestamptz,
  PRIMARY KEY (user_id, flag_key)
);

CREATE INDEX idx_flag_overrides_user ON public.feature_flag_overrides(user_id);
CREATE INDEX idx_flag_overrides_expires ON public.feature_flag_overrides(expires_at) WHERE expires_at IS NOT NULL;

COMMENT ON TABLE public.feature_flag_overrides IS 'Per-user feature flag overrides';

-- ============================================================================
-- experiments - A/B test experiment definitions
-- ============================================================================

CREATE TABLE public.experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text UNIQUE NOT NULL,
  name text NOT NULL,
  description text,

  -- Status
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'running', 'paused', 'completed', 'cancelled')),

  -- Variants with weights (must sum to 100)
  variants jsonb NOT NULL DEFAULT '[{"id": "control", "weight": 50}, {"id": "treatment", "weight": 50}]',

  -- Targeting (same as feature flags)
  target_platforms text[] DEFAULT '{}',
  user_segments text[] DEFAULT '{}',
  sample_percentage integer DEFAULT 100 CHECK (sample_percentage >= 0 AND sample_percentage <= 100),

  -- Metrics and goals
  primary_metric text,
  secondary_metrics text[] DEFAULT '{}',
  hypothesis text,

  -- Timeline
  start_date timestamptz,
  end_date timestamptz,

  -- Results
  results jsonb,
  winner_variant text,

  -- Timestamps
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_experiments_key ON public.experiments(key);
CREATE INDEX idx_experiments_status ON public.experiments(status) WHERE status = 'running';

COMMENT ON TABLE public.experiments IS 'A/B test experiment definitions';

-- ============================================================================
-- experiment_assignments - User variant assignments
-- ============================================================================

CREATE TABLE public.experiment_assignments (
  user_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
  experiment_key text REFERENCES experiments(key) ON DELETE CASCADE,
  variant_id text NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, experiment_key)
);

CREATE INDEX idx_experiment_assignments_user ON public.experiment_assignments(user_id);
CREATE INDEX idx_experiment_assignments_variant ON public.experiment_assignments(experiment_key, variant_id);

COMMENT ON TABLE public.experiment_assignments IS 'User experiment variant assignments';

-- ============================================================================
-- app_version_requirements - Minimum supported app versions
-- ============================================================================

CREATE TABLE public.app_version_requirements (
  platform text PRIMARY KEY CHECK (platform IN ('ios', 'android', 'web')),
  min_version text NOT NULL,
  recommended_version text NOT NULL,
  force_update_message text,
  soft_update_message text,
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

-- Insert default version requirements
INSERT INTO app_version_requirements (platform, min_version, recommended_version, force_update_message, soft_update_message)
VALUES
  ('ios', '1.0.0', '1.0.0', 'Please update FoodShare to continue using the app.', 'A new version of FoodShare is available.'),
  ('android', '1.0.0', '1.0.0', 'Please update FoodShare to continue using the app.', 'A new version of FoodShare is available.'),
  ('web', '1.0.0', '1.0.0', NULL, NULL)
ON CONFLICT (platform) DO NOTHING;

COMMENT ON TABLE public.app_version_requirements IS 'Minimum and recommended app versions per platform';

-- ============================================================================
-- get_user_feature_flags - Returns all flags for a user
-- Works with existing feature_flags table structure (flag_key, target_segments)
-- ============================================================================

/**
 * get_user_feature_flags - Returns feature flags for a user
 *
 * Features:
 * - Deterministic rollout using user ID hash
 * - Platform and version filtering
 * - User segment targeting
 * - Per-user overrides
 *
 * @param p_user_id - The user's ID
 * @param p_platform - The client platform ('ios', 'android', 'web')
 * @param p_app_version - The client app version
 *
 * @returns JSONB with all flags and their states
 */
CREATE OR REPLACE FUNCTION public.get_user_feature_flags(
  p_user_id uuid,
  p_platform text DEFAULT 'unknown',
  p_app_version text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_flags jsonb := '{}'::jsonb;
  v_flag record;
  v_override record;
  v_is_enabled boolean;
  v_user_hash integer;
  v_user_segments text[];
BEGIN
  -- Get deterministic hash for rollout (0-99)
  v_user_hash := abs(hashtext(p_user_id::text)) % 100;

  -- Get user segments (could be extended with actual segment logic)
  -- For now, just check if user is "new" (created in last 30 days)
  SELECT ARRAY_AGG(segment)
  INTO v_user_segments
  FROM (
    SELECT 'new_user' AS segment
    FROM profiles
    WHERE id = p_user_id
      AND created_time > NOW() - INTERVAL '30 days'
    UNION ALL
    SELECT 'all' AS segment
  ) segments;

  -- Process each flag (using existing flag_key column)
  FOR v_flag IN
    SELECT
      flag_key,
      display_name,
      enabled,
      rollout_percentage,
      target_segments,
      target_platforms,
      min_app_version,
      config,
      metadata
    FROM feature_flags
    WHERE (expires_at IS NULL OR expires_at > NOW())
    ORDER BY flag_key
  LOOP
    -- Check for override first
    SELECT * INTO v_override
    FROM feature_flag_overrides
    WHERE user_id = p_user_id
      AND flag_key = v_flag.flag_key
      AND (expires_at IS NULL OR expires_at > NOW());

    IF v_override IS NOT NULL THEN
      v_is_enabled := v_override.enabled;
    ELSE
      -- Check if flag is enabled
      v_is_enabled := v_flag.enabled;

      -- Check rollout percentage
      IF v_is_enabled AND v_flag.rollout_percentage < 100 THEN
        v_is_enabled := v_user_hash < v_flag.rollout_percentage;
      END IF;

      -- Check platform targeting
      IF v_is_enabled AND v_flag.target_platforms IS NOT NULL AND array_length(v_flag.target_platforms, 1) > 0 THEN
        v_is_enabled := p_platform = ANY(v_flag.target_platforms);
      END IF;

      -- Check version requirements
      IF v_is_enabled AND p_app_version IS NOT NULL AND v_flag.min_app_version ? p_platform THEN
        v_is_enabled := p_app_version >= (v_flag.min_app_version->>p_platform);
      END IF;

      -- Check user segments (using target_segments from existing table)
      IF v_is_enabled AND v_flag.target_segments IS NOT NULL AND array_length(v_flag.target_segments, 1) > 0 THEN
        v_is_enabled := v_flag.target_segments && v_user_segments;
      END IF;
    END IF;

    -- Add to result
    v_flags := v_flags || jsonb_build_object(
      v_flag.flag_key,
      jsonb_build_object(
        'enabled', v_is_enabled,
        'config', CASE WHEN v_is_enabled THEN COALESCE(v_flag.config, '{}'::jsonb) ELSE '{}'::jsonb END
      )
    );
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'flags', v_flags,
    'context', jsonb_build_object(
      'platform', p_platform,
      'appVersion', p_app_version,
      'userHash', v_user_hash
    ),
    'meta', jsonb_build_object(
      'timestamp', NOW(),
      'refreshAfter', 300,
      'cacheTTL', 60
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_user_feature_flags(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_feature_flags(uuid, text, text) TO service_role;

COMMENT ON FUNCTION public.get_user_feature_flags IS 'Returns feature flags with targeting and rollout logic';

-- ============================================================================
-- get_experiment_variant - Returns/assigns experiment variant
-- ============================================================================

/**
 * get_experiment_variant - Gets or assigns a user's experiment variant
 *
 * Uses deterministic hashing for consistent variant assignment.
 * Persists assignment for consistent experience.
 *
 * @param p_user_id - The user's ID
 * @param p_experiment_key - The experiment key
 *
 * @returns JSONB with variant assignment
 */
CREATE OR REPLACE FUNCTION public.get_experiment_variant(
  p_user_id uuid,
  p_experiment_key text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_experiment record;
  v_assignment record;
  v_user_hash integer;
  v_cumulative_weight integer := 0;
  v_variant jsonb;
  v_variant_id text;
BEGIN
  -- Get experiment
  SELECT * INTO v_experiment
  FROM experiments
  WHERE key = p_experiment_key;

  IF v_experiment IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'EXPERIMENT_NOT_FOUND'
    );
  END IF;

  -- Check if experiment is running
  IF v_experiment.status != 'running' THEN
    RETURN jsonb_build_object(
      'success', true,
      'experimentKey', p_experiment_key,
      'variant', NULL,
      'reason', 'experiment_not_running',
      'status', v_experiment.status
    );
  END IF;

  -- Check for existing assignment
  SELECT * INTO v_assignment
  FROM experiment_assignments
  WHERE user_id = p_user_id
    AND experiment_key = p_experiment_key;

  IF v_assignment IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'experimentKey', p_experiment_key,
      'variant', v_assignment.variant_id,
      'assignedAt', v_assignment.assigned_at,
      'isNewAssignment', false
    );
  END IF;

  -- Check sampling (not all users may be in experiment)
  v_user_hash := abs(hashtext(p_user_id::text || 'sample')) % 100;
  IF v_user_hash >= v_experiment.sample_percentage THEN
    RETURN jsonb_build_object(
      'success', true,
      'experimentKey', p_experiment_key,
      'variant', NULL,
      'reason', 'not_sampled'
    );
  END IF;

  -- Assign variant based on hash
  v_user_hash := abs(hashtext(p_user_id::text || p_experiment_key)) % 100;

  FOR v_variant IN SELECT * FROM jsonb_array_elements(v_experiment.variants)
  LOOP
    v_cumulative_weight := v_cumulative_weight + (v_variant->>'weight')::integer;
    IF v_user_hash < v_cumulative_weight THEN
      v_variant_id := v_variant->>'id';
      EXIT;
    END IF;
  END LOOP;

  -- Fallback to control if no variant matched
  IF v_variant_id IS NULL THEN
    v_variant_id := 'control';
  END IF;

  -- Persist assignment
  INSERT INTO experiment_assignments (user_id, experiment_key, variant_id)
  VALUES (p_user_id, p_experiment_key, v_variant_id)
  ON CONFLICT (user_id, experiment_key) DO NOTHING;

  RETURN jsonb_build_object(
    'success', true,
    'experimentKey', p_experiment_key,
    'variant', v_variant_id,
    'assignedAt', NOW(),
    'isNewAssignment', true
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_experiment_variant(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_experiment_variant(uuid, text) TO service_role;

COMMENT ON FUNCTION public.get_experiment_variant IS 'Gets or assigns experiment variant for a user';

-- ============================================================================
-- check_client_compatibility - Checks app version compatibility
-- ============================================================================

/**
 * check_client_compatibility - Checks if client version is supported
 *
 * @param p_platform - The client platform
 * @param p_version - The client version
 *
 * @returns JSONB with compatibility info
 */
CREATE OR REPLACE FUNCTION public.check_client_compatibility(
  p_platform text,
  p_version text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req record;
  v_is_supported boolean;
  v_needs_update boolean;
BEGIN
  SELECT * INTO v_req
  FROM app_version_requirements
  WHERE platform = p_platform;

  IF v_req IS NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'supported', true,
      'needsUpdate', false,
      'forceUpdate', false
    );
  END IF;

  -- Compare versions (simple string comparison works for semver)
  v_is_supported := p_version >= v_req.min_version;
  v_needs_update := p_version < v_req.recommended_version;

  RETURN jsonb_build_object(
    'success', true,
    'supported', v_is_supported,
    'needsUpdate', v_needs_update,
    'forceUpdate', NOT v_is_supported,
    'currentVersion', p_version,
    'minVersion', v_req.min_version,
    'recommendedVersion', v_req.recommended_version,
    'message', CASE
      WHEN NOT v_is_supported THEN v_req.force_update_message
      WHEN v_needs_update THEN v_req.soft_update_message
      ELSE NULL
    END,
    'meta', jsonb_build_object('timestamp', NOW())
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_client_compatibility(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_client_compatibility(text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.check_client_compatibility(text, text) TO service_role;

COMMENT ON FUNCTION public.check_client_compatibility IS 'Checks if client version is supported';
