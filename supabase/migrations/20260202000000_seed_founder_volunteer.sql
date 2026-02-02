-- ============================================================================
-- Migration: Seed Founder as First Volunteer
-- Date: 2026-02-02
-- Description: Creates a volunteer post for the founder/first admin user.
--              All values are fetched dynamically from the database.
--              The founder will appear as a featured volunteer on /volunteers.
-- ============================================================================

-- Insert founder's volunteer post only if one doesn't already exist
-- Uses CTE to dynamically fetch founder's profile data
INSERT INTO posts (
  profile_id,
  post_name,
  post_description,
  post_type,
  images,
  available_hours,
  post_address,
  post_stripped_address,
  transportation,
  is_active,
  created_at
)
SELECT
  founder.profile_id,
  -- Build name/title: "First Last - FoodShare Founder" or "Nickname - FoodShare Founder"
  LEFT(
    COALESCE(
      NULLIF(TRIM(CONCAT_WS(' ', founder.first_name, founder.second_name)), '') || ' - FoodShare Founder',
      COALESCE(founder.nickname, 'FoodShare') || ' - FoodShare Founder'
    ),
    100  -- Truncate to post_name max length
  ) AS post_name,
  -- Description
  'Building FoodShare to reduce food waste and strengthen communities. ' ||
  'Passionate about technology for social good. ' ||
  'Join us in making a difference!' AS post_description,
  'volunteer' AS post_type,
  -- Use founder's avatar as the volunteer image, or empty array
  CASE
    WHEN founder.avatar_url IS NOT NULL AND founder.avatar_url != ''
    THEN ARRAY[founder.avatar_url]
    ELSE ARRAY[]::text[]
  END AS images,
  -- Availability
  'Flexible' AS available_hours,
  -- Default address (profiles table doesn't have address)
  'Sacramento, CA' AS post_address,
  'Sacramento' AS post_stripped_address,
  'both' AS transportation,
  true AS is_active,  -- Already approved (founder)
  NOW() - INTERVAL '1 year'  -- Backdate to appear first (oldest volunteer)
FROM (
  -- Get the first admin/superadmin user's profile
  SELECT
    p.id AS profile_id,
    p.first_name,
    p.second_name,
    p.nickname,
    p.avatar_url
  FROM profiles p
  INNER JOIN user_roles ur ON ur.profile_id = p.id
  INNER JOIN roles r ON r.id = ur.role_id
  WHERE r.name IN ('admin', 'superadmin')
  ORDER BY p.created_time ASC
  LIMIT 1
) AS founder
WHERE NOT EXISTS (
  -- Only insert if no volunteer post exists for this founder
  SELECT 1
  FROM posts
  WHERE profile_id = founder.profile_id
    AND post_type = 'volunteer'
);
