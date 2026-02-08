-- Migration: Migrate community_fridges data into posts table
-- Purpose: Consolidate fridges into unified posts table with post_type='fridge'
-- Note: community_fridges table is NOT dropped (kept for rollback safety)

-- Step 1: Create system user to own fridge posts
INSERT INTO auth.users (id, instance_id, role, aud, email, encrypted_password, email_confirmed_at, created_at, updated_at, confirmation_token, raw_app_meta_data, raw_user_meta_data)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'system@foodshare.club',
  '',
  now(),
  now(),
  now(),
  '',
  '{"provider":"email","providers":["email"]}',
  '{"display_name":"FoodShare System"}'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, nickname, first_name, second_name, email, created_time, updated_at, is_active)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'FoodShare System',
  'FoodShare',
  'System',
  'system@foodshare.club',
  now(),
  now(),
  true
) ON CONFLICT (id) DO NOTHING;

-- Step 2: Migrate community_fridges → posts
INSERT INTO posts (
  post_name,
  post_description,
  post_address,
  location,
  available_hours,
  has_pantry,
  location_type,
  post_type,
  profile_id,
  is_active,
  images,
  fridge_id,
  created_at,
  updated_at,
  metadata,
  post_views,
  pickup_time,
  condition
)
SELECT
  cf.name,
  COALESCE(cf.description, '-'),
  COALESCE(cf.full_address, cf.street_address, '-'),
  cf.location,
  COALESCE(cf.available_hours, '-'),
  COALESCE(cf.has_pantry, false),
  COALESCE(cf.location_type, '-'),
  'fridge',
  '00000000-0000-0000-0000-000000000001',
  (cf.status = 'Active'),
  CASE WHEN cf.photo_url IS NOT NULL THEN ARRAY[cf.photo_url] ELSE '{}'::text[] END,
  cf.id::text,
  COALESCE(cf.created_at, now()),
  COALESCE(cf.updated_at, now()),
  jsonb_build_object(
    'status', cf.status,
    'city', cf.city,
    'state', cf.state,
    'zip_code', cf.zip_code,
    'street_address', cf.street_address,
    'reference_directions', cf.reference_directions,
    'host_company', cf.host_company,
    'company_type', cf.company_type,
    'point_person_name', cf.point_person_name,
    'point_person_email', cf.point_person_email,
    'languages', COALESCE(to_jsonb(cf.languages), '[]'::jsonb),
    'launch_date', cf.launch_date,
    'created_date', cf.created_date,
    'last_check_in', cf.last_check_in,
    'status_last_updated', cf.status_last_updated,
    'total_check_ins', COALESCE(cf.total_check_ins, 0),
    'age_years', cf.age_years,
    'latest_food_status', cf.latest_food_status,
    'latest_cleanliness_status', cf.latest_cleanliness_status,
    'check_in_link', cf.check_in_link,
    'slack_channel_id', cf.slack_channel_id,
    'slack_channel_link', cf.slack_channel_link,
    'qr_code_url', cf.qr_code_url,
    'original_fridge_id', cf.id::text
  ),
  0,
  '-',
  COALESCE(cf.latest_food_status, 'room for more')
FROM public.community_fridges cf;

-- Step 3: Verify migration
DO $$
DECLARE
  source_count INTEGER;
  migrated_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO source_count FROM public.community_fridges;
  SELECT COUNT(*) INTO migrated_count FROM public.posts WHERE post_type = 'fridge';

  IF migrated_count < source_count THEN
    RAISE EXCEPTION 'Migration verification failed: expected %, got %', source_count, migrated_count;
  END IF;

  RAISE NOTICE 'Migration successful: % fridges migrated to posts', migrated_count;
END $$;
