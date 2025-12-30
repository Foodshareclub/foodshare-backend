-- ============================================================================
-- Cross-Platform Sync Infrastructure
-- Unified device tracking, conflict resolution, and API versioning for
-- Web/iOS/Android client compatibility
-- ============================================================================

-- ============================================================================
-- sync_devices - Tracks devices across platforms
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.sync_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  device_name text,
  app_version text,
  os_version text,
  push_token text,
  push_token_type text CHECK (push_token_type IN ('apns', 'fcm', 'vapid')),
  last_sync_at timestamptz DEFAULT NOW(),
  last_active_at timestamptz DEFAULT NOW(),
  sync_version bigint DEFAULT 0,
  capabilities jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW(),
  UNIQUE(user_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_sync_devices_user ON public.sync_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_devices_platform ON public.sync_devices(platform);
CREATE INDEX IF NOT EXISTS idx_sync_devices_push_token ON public.sync_devices(push_token) WHERE push_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sync_devices_active ON public.sync_devices(last_active_at DESC);

COMMENT ON TABLE public.sync_devices IS 'Tracks user devices across platforms for sync and push notifications';
COMMENT ON COLUMN public.sync_devices.capabilities IS 'Device-specific capabilities (e.g., biometrics, haptics, ProMotion)';

-- ============================================================================
-- Add target_platforms to notifications for platform-specific routing
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'notifications' AND column_name = 'target_platforms') THEN
    ALTER TABLE public.notifications ADD COLUMN target_platforms text[] DEFAULT ARRAY['ios', 'android', 'web'];
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_notifications_platforms ON public.notifications USING GIN(target_platforms);

-- ============================================================================
-- API Version Tracking
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.api_versions (
  version text PRIMARY KEY,
  released_at timestamptz DEFAULT NOW(),
  sunset_at timestamptz,
  deprecated_at timestamptz,
  changelog text,
  breaking_changes jsonb,
  min_client_versions jsonb DEFAULT '{"ios": null, "android": null, "web": null}'::jsonb,
  created_at timestamptz DEFAULT NOW()
);

INSERT INTO public.api_versions (version, changelog, min_client_versions) VALUES
  ('1.0.0', 'Initial API release', '{"ios": "3.0.0", "android": "1.0.0", "web": "1.0.0"}'::jsonb),
  ('2.0.0', 'Unified response format, platform-aware BFF', '{"ios": "3.1.0", "android": "1.1.0", "web": "2.0.0"}'::jsonb)
ON CONFLICT (version) DO NOTHING;

COMMENT ON TABLE public.api_versions IS 'Tracks API versions and their lifecycle';

-- ============================================================================
-- Client Version Telemetry
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.client_version_telemetry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform text NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  app_version text NOT NULL,
  api_version text,
  request_count bigint DEFAULT 1,
  first_seen_at timestamptz DEFAULT NOW(),
  last_seen_at timestamptz DEFAULT NOW(),
  UNIQUE(platform, app_version, api_version)
);

CREATE INDEX IF NOT EXISTS idx_client_telemetry_platform ON public.client_version_telemetry(platform, last_seen_at DESC);

COMMENT ON TABLE public.client_version_telemetry IS 'Tracks client version usage for deprecation planning';

-- ============================================================================
-- register_device - Register or update a device for sync/push
-- ============================================================================

/**
 * register_device - Register or update a device for sync and push notifications
 *
 * @param p_user_id - The user's ID
 * @param p_device_id - Unique device identifier
 * @param p_platform - Platform (ios, android, web)
 * @param p_device_name - Optional device name
 * @param p_app_version - App version string
 * @param p_os_version - OS version string
 * @param p_push_token - Push notification token
 * @param p_capabilities - Device capabilities JSONB
 *
 * @returns JSONB with registration result
 */
CREATE OR REPLACE FUNCTION public.register_device(
  p_user_id uuid,
  p_device_id text,
  p_platform text,
  p_device_name text DEFAULT NULL,
  p_app_version text DEFAULT NULL,
  p_os_version text DEFAULT NULL,
  p_push_token text DEFAULT NULL,
  p_capabilities jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_device_id uuid;
  v_push_token_type text;
  v_is_new boolean := false;
BEGIN
  -- Determine push token type from platform
  v_push_token_type := CASE p_platform
    WHEN 'ios' THEN 'apns'
    WHEN 'android' THEN 'fcm'
    WHEN 'web' THEN 'vapid'
    ELSE NULL
  END;

  -- Upsert device
  INSERT INTO sync_devices (
    user_id, device_id, platform, device_name, app_version,
    os_version, push_token, push_token_type, capabilities,
    last_active_at, updated_at
  ) VALUES (
    p_user_id, p_device_id, p_platform, p_device_name, p_app_version,
    p_os_version, p_push_token, v_push_token_type, p_capabilities,
    NOW(), NOW()
  )
  ON CONFLICT (user_id, device_id) DO UPDATE SET
    platform = EXCLUDED.platform,
    device_name = COALESCE(EXCLUDED.device_name, sync_devices.device_name),
    app_version = COALESCE(EXCLUDED.app_version, sync_devices.app_version),
    os_version = COALESCE(EXCLUDED.os_version, sync_devices.os_version),
    push_token = COALESCE(EXCLUDED.push_token, sync_devices.push_token),
    push_token_type = COALESCE(EXCLUDED.push_token_type, sync_devices.push_token_type),
    capabilities = EXCLUDED.capabilities || sync_devices.capabilities,
    last_active_at = NOW(),
    updated_at = NOW()
  RETURNING id, (xmax = 0) INTO v_device_id, v_is_new;

  -- Track client version telemetry
  INSERT INTO client_version_telemetry (platform, app_version, api_version, request_count, last_seen_at)
  VALUES (p_platform, COALESCE(p_app_version, 'unknown'), '2.0.0', 1, NOW())
  ON CONFLICT (platform, app_version, api_version) DO UPDATE SET
    request_count = client_version_telemetry.request_count + 1,
    last_seen_at = NOW();

  RETURN jsonb_build_object(
    'success', true,
    'deviceId', v_device_id,
    'isNewDevice', v_is_new,
    'platform', p_platform,
    'meta', jsonb_build_object('timestamp', NOW())
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.register_device(uuid, text, text, text, text, text, text, jsonb) TO authenticated;

COMMENT ON FUNCTION public.register_device IS 'Register or update a device for sync and push notifications';

-- ============================================================================
-- get_user_devices - Get all devices for a user
-- ============================================================================

/**
 * get_user_devices - Returns all registered devices for a user
 *
 * @param p_user_id - The user's ID
 *
 * @returns JSONB with device list
 */
CREATE OR REPLACE FUNCTION public.get_user_devices(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_devices jsonb;
BEGIN
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', d.id,
      'deviceId', d.device_id,
      'platform', d.platform,
      'deviceName', d.device_name,
      'appVersion', d.app_version,
      'osVersion', d.os_version,
      'lastSyncAt', d.last_sync_at,
      'lastActiveAt', d.last_active_at,
      'hasPushToken', d.push_token IS NOT NULL,
      'capabilities', d.capabilities
    ) ORDER BY d.last_active_at DESC
  ), '[]'::jsonb) INTO v_devices
  FROM sync_devices d
  WHERE d.user_id = p_user_id;

  RETURN jsonb_build_object(
    'success', true,
    'devices', v_devices,
    'count', jsonb_array_length(v_devices),
    'meta', jsonb_build_object('timestamp', NOW())
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_user_devices(uuid) TO authenticated;

COMMENT ON FUNCTION public.get_user_devices IS 'Returns all registered devices for a user';

-- ============================================================================
-- resolve_sync_conflict - Cross-platform conflict resolution
-- ============================================================================

/**
 * resolve_sync_conflict - Resolves conflicts between client and server data
 *
 * Strategies:
 * - 'server_wins': Server data takes precedence
 * - 'client_wins': Client data takes precedence
 * - 'merge': Merge both (field-level comparison)
 * - 'manual': Return both for manual resolution
 *
 * @param p_entity_type - Type of entity (e.g., 'post', 'profile')
 * @param p_entity_id - Entity UUID
 * @param p_client_version - Client's last known version
 * @param p_server_version - Current server version
 * @param p_client_data - Client's data
 * @param p_server_data - Server's current data
 * @param p_strategy - Resolution strategy (default: 'server_wins')
 *
 * @returns JSONB with resolved data
 */
CREATE OR REPLACE FUNCTION public.resolve_sync_conflict(
  p_entity_type text,
  p_entity_id uuid,
  p_client_version bigint,
  p_server_version bigint,
  p_client_data jsonb,
  p_server_data jsonb,
  p_strategy text DEFAULT 'server_wins'
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_resolved_data jsonb;
  v_has_conflict boolean;
  v_conflict_fields text[];
  v_key text;
BEGIN
  -- Check if there's actually a conflict
  v_has_conflict := p_client_version < p_server_version;

  IF NOT v_has_conflict THEN
    RETURN jsonb_build_object(
      'success', true,
      'hasConflict', false,
      'data', p_client_data,
      'meta', jsonb_build_object('timestamp', NOW())
    );
  END IF;

  -- Find conflicting fields
  v_conflict_fields := ARRAY[]::text[];
  FOR v_key IN SELECT jsonb_object_keys(p_client_data)
  LOOP
    IF p_client_data->v_key IS DISTINCT FROM p_server_data->v_key THEN
      v_conflict_fields := array_append(v_conflict_fields, v_key);
    END IF;
  END LOOP;

  -- Apply resolution strategy
  CASE p_strategy
    WHEN 'server_wins' THEN
      v_resolved_data := p_server_data;

    WHEN 'client_wins' THEN
      v_resolved_data := p_client_data;

    WHEN 'merge' THEN
      -- Merge: prefer newer timestamps for each field
      v_resolved_data := p_server_data;
      -- For fields where client has newer data, use client's
      IF p_client_data ? 'updated_at' AND p_server_data ? 'updated_at' THEN
        IF (p_client_data->>'updated_at')::timestamptz > (p_server_data->>'updated_at')::timestamptz THEN
          v_resolved_data := p_client_data;
        END IF;
      END IF;

    WHEN 'manual' THEN
      -- Return both for manual resolution
      RETURN jsonb_build_object(
        'success', true,
        'hasConflict', true,
        'requiresManualResolution', true,
        'clientData', p_client_data,
        'serverData', p_server_data,
        'conflictFields', to_jsonb(v_conflict_fields),
        'clientVersion', p_client_version,
        'serverVersion', p_server_version,
        'meta', jsonb_build_object('timestamp', NOW())
      );

    ELSE
      RAISE EXCEPTION 'Unknown conflict resolution strategy: %', p_strategy;
  END CASE;

  RETURN jsonb_build_object(
    'success', true,
    'hasConflict', true,
    'resolved', true,
    'strategy', p_strategy,
    'data', v_resolved_data,
    'conflictFields', to_jsonb(v_conflict_fields),
    'meta', jsonb_build_object('timestamp', NOW())
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_sync_conflict(text, uuid, bigint, bigint, jsonb, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_sync_conflict(text, uuid, bigint, bigint, jsonb, jsonb, text) TO service_role;

COMMENT ON FUNCTION public.resolve_sync_conflict IS 'Cross-platform conflict resolution with multiple strategies';

-- ============================================================================
-- check_client_compatibility - Checks if client version is compatible
-- ============================================================================

/**
 * check_client_compatibility - Checks if a client version is compatible with API
 *
 * @param p_platform - Client platform (ios, android, web)
 * @param p_app_version - Client app version
 * @param p_api_version - Requested API version
 *
 * @returns JSONB with compatibility status
 */
CREATE OR REPLACE FUNCTION public.check_client_compatibility(
  p_platform text,
  p_app_version text,
  p_api_version text DEFAULT '2.0.0'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_api_record record;
  v_min_version text;
  v_is_compatible boolean;
  v_is_deprecated boolean;
  v_sunset_warning text;
BEGIN
  -- Get API version info
  SELECT * INTO v_api_record
  FROM api_versions
  WHERE version = p_api_version;

  IF v_api_record IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'UNKNOWN_API_VERSION',
      'message', 'The requested API version is not recognized'
    );
  END IF;

  -- Get minimum client version for this platform
  v_min_version := v_api_record.min_client_versions->>p_platform;

  -- Compare versions (simple semver comparison)
  IF v_min_version IS NOT NULL THEN
    v_is_compatible := (
      string_to_array(p_app_version, '.')::int[] >=
      string_to_array(v_min_version, '.')::int[]
    );
  ELSE
    v_is_compatible := true;
  END IF;

  -- Check deprecation status
  v_is_deprecated := v_api_record.deprecated_at IS NOT NULL AND v_api_record.deprecated_at <= NOW();

  -- Build sunset warning
  IF v_api_record.sunset_at IS NOT NULL THEN
    v_sunset_warning := 'This API version will be sunset on ' || v_api_record.sunset_at::date::text;
  END IF;

  -- Track telemetry
  INSERT INTO client_version_telemetry (platform, app_version, api_version, request_count, last_seen_at)
  VALUES (p_platform, p_app_version, p_api_version, 1, NOW())
  ON CONFLICT (platform, app_version, api_version) DO UPDATE SET
    request_count = client_version_telemetry.request_count + 1,
    last_seen_at = NOW();

  RETURN jsonb_build_object(
    'success', true,
    'compatible', v_is_compatible,
    'deprecated', v_is_deprecated,
    'sunsetWarning', v_sunset_warning,
    'minVersion', v_min_version,
    'currentVersion', p_app_version,
    'updateRequired', NOT v_is_compatible,
    'meta', jsonb_build_object('timestamp', NOW())
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_client_compatibility(text, text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.check_client_compatibility(text, text, text) TO authenticated;

COMMENT ON FUNCTION public.check_client_compatibility IS 'Checks if client version is compatible with requested API version';

-- ============================================================================
-- get_platform_push_tokens - Get push tokens for a user by platform
-- ============================================================================

/**
 * get_platform_push_tokens - Get push tokens for all or specific platforms
 *
 * @param p_user_id - The user's ID
 * @param p_platforms - Array of platforms to include (default: all)
 *
 * @returns JSONB with tokens grouped by platform
 */
CREATE OR REPLACE FUNCTION public.get_platform_push_tokens(
  p_user_id uuid,
  p_platforms text[] DEFAULT ARRAY['ios', 'android', 'web']
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tokens jsonb;
BEGIN
  SELECT jsonb_object_agg(
    platform,
    tokens
  ) INTO v_tokens
  FROM (
    SELECT
      d.platform,
      jsonb_agg(
        jsonb_build_object(
          'token', d.push_token,
          'type', d.push_token_type,
          'deviceId', d.device_id
        )
      ) AS tokens
    FROM sync_devices d
    WHERE d.user_id = p_user_id
      AND d.push_token IS NOT NULL
      AND d.platform = ANY(p_platforms)
      AND d.last_active_at > NOW() - INTERVAL '30 days'
    GROUP BY d.platform
  ) t;

  RETURN jsonb_build_object(
    'success', true,
    'tokens', COALESCE(v_tokens, '{}'::jsonb),
    'meta', jsonb_build_object('timestamp', NOW())
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_platform_push_tokens(uuid, text[]) TO service_role;

COMMENT ON FUNCTION public.get_platform_push_tokens IS 'Get push tokens for a user grouped by platform';

-- ============================================================================
-- unregister_device - Remove a device registration
-- ============================================================================

/**
 * unregister_device - Remove a device from sync/push
 *
 * @param p_user_id - The user's ID
 * @param p_device_id - The device identifier to remove
 *
 * @returns JSONB with result
 */
CREATE OR REPLACE FUNCTION public.unregister_device(
  p_user_id uuid,
  p_device_id text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted boolean;
BEGIN
  DELETE FROM sync_devices
  WHERE user_id = p_user_id AND device_id = p_device_id
  RETURNING true INTO v_deleted;

  RETURN jsonb_build_object(
    'success', COALESCE(v_deleted, false),
    'deleted', COALESCE(v_deleted, false),
    'meta', jsonb_build_object('timestamp', NOW())
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.unregister_device(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.unregister_device IS 'Remove a device from sync and push notifications';

-- ============================================================================
-- cleanup_inactive_devices - Remove devices inactive for 90+ days
-- ============================================================================

/**
 * cleanup_inactive_devices - Removes devices inactive for extended period
 *
 * @param p_days - Number of days of inactivity (default: 90)
 *
 * @returns JSONB with cleanup stats
 */
CREATE OR REPLACE FUNCTION public.cleanup_inactive_devices(p_days integer DEFAULT 90)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted_count integer;
BEGIN
  WITH deleted AS (
    DELETE FROM sync_devices
    WHERE last_active_at < NOW() - (p_days || ' days')::interval
    RETURNING id
  )
  SELECT COUNT(*) INTO v_deleted_count FROM deleted;

  RETURN jsonb_build_object(
    'success', true,
    'deletedCount', v_deleted_count,
    'threshold', p_days || ' days',
    'meta', jsonb_build_object('timestamp', NOW())
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.cleanup_inactive_devices(integer) TO service_role;

COMMENT ON FUNCTION public.cleanup_inactive_devices IS 'Removes devices inactive for extended period';

-- ============================================================================
-- RLS Policies
-- ============================================================================

ALTER TABLE public.sync_devices ENABLE ROW LEVEL SECURITY;

-- Users can view and manage their own devices
CREATE POLICY "Users can view own devices" ON public.sync_devices
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own devices" ON public.sync_devices
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own devices" ON public.sync_devices
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own devices" ON public.sync_devices
  FOR DELETE USING (auth.uid() = user_id);

-- Service role has full access
CREATE POLICY "Service role full access to sync_devices" ON public.sync_devices
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- API versions are public read
ALTER TABLE public.api_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read api_versions" ON public.api_versions
  FOR SELECT USING (true);

-- Client telemetry is service_role only for reads
ALTER TABLE public.client_version_telemetry ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can manage client_telemetry" ON public.client_version_telemetry
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

CREATE POLICY "Anyone can insert client_telemetry" ON public.client_version_telemetry
  FOR INSERT WITH CHECK (true);

-- ============================================================================
-- Grants
-- ============================================================================

GRANT SELECT ON public.sync_devices TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.sync_devices TO authenticated;
GRANT ALL ON public.sync_devices TO service_role;

GRANT SELECT ON public.api_versions TO anon, authenticated;
GRANT ALL ON public.api_versions TO service_role;

GRANT INSERT ON public.client_version_telemetry TO anon, authenticated;
GRANT ALL ON public.client_version_telemetry TO service_role;
