-- Drop the old search_radius_km constraint that enforces 100km limit
-- The new constraint (check_search_radius_km_range) allows up to 805km

-- Drop old constraint (may not exist on some environments)
ALTER TABLE profiles
DROP CONSTRAINT IF EXISTS profiles_search_radius_km_check;

-- Ensure new constraint exists with correct range (idempotent)
-- This allows 1-805 km (≈ 1-500 miles)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'check_search_radius_km_range'
        AND conrelid = 'profiles'::regclass
    ) THEN
        ALTER TABLE profiles
        ADD CONSTRAINT check_search_radius_km_range
        CHECK (search_radius_km IS NULL OR (search_radius_km >= 1 AND search_radius_km <= 805));
    END IF;
END $$;
