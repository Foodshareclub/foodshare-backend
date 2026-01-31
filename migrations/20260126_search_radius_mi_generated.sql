-- Add search_radius_mi as a generated column (auto-calculated from km)
-- Formula: km * 0.621371 = miles
-- This allows iOS/API to read miles directly while keeping km as source of truth

-- Add generated column that auto-calculates miles from km
ALTER TABLE profiles
ADD COLUMN search_radius_mi DOUBLE PRECISION
GENERATED ALWAYS AS (search_radius_km * 0.621371) STORED;

-- Add constraint to enforce valid range (1-805 km = 1-500 mi)
ALTER TABLE profiles
ADD CONSTRAINT check_search_radius_km_range
CHECK (search_radius_km IS NULL OR (search_radius_km >= 1 AND search_radius_km <= 805));

-- Create index for queries filtering by miles
-- Using CONCURRENTLY to avoid blocking production queries
CREATE INDEX CONCURRENTLY idx_profiles_search_radius_mi
ON profiles (search_radius_mi)
WHERE search_radius_mi IS NOT NULL;

-- Add comment for documentation
COMMENT ON COLUMN profiles.search_radius_mi IS
'Auto-generated from search_radius_km * 0.621371. Read-only - writes go to search_radius_km.';
