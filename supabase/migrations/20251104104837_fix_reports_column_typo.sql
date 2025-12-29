-- Migration: Fix Reports Column Typo
-- Priority: CRITICAL
-- Description: Fixes typo in reports table: prifile_id -> profile_id
-- Impact: Corrects column name and updates foreign key constraint
--
-- Created: 2025-01-04
-- Author: Schema Review

BEGIN;

-- =============================================================================
-- RENAME COLUMN
-- =============================================================================

ALTER TABLE public.reports
  RENAME COLUMN prifile_id TO profile_id;

-- =============================================================================
-- UPDATE FOREIGN KEY CONSTRAINT
-- =============================================================================

-- Drop old constraint (if it exists)
ALTER TABLE public.reports
  DROP CONSTRAINT IF EXISTS reports_prifile_id_fkey;

-- Add corrected foreign key constraint
ALTER TABLE public.reports
  ADD CONSTRAINT reports_profile_id_fkey
  FOREIGN KEY (profile_id)
  REFERENCES public.profiles(id)
  ON DELETE CASCADE;

-- =============================================================================
-- UPDATE RLS POLICIES
-- =============================================================================

-- The RLS policy in 20251104104833_fix_rls_policies.sql already references
-- profile_id correctly, so this migration makes the schema match

-- =============================================================================
-- VERIFICATION
-- =============================================================================

-- Verify column was renamed
-- SELECT column_name, data_type
-- FROM information_schema.columns
-- WHERE table_name = 'reports' AND column_name = 'profile_id';

-- Verify foreign key exists
-- SELECT constraint_name, table_name, column_name
-- FROM information_schema.key_column_usage
-- WHERE table_name = 'reports' AND column_name = 'profile_id';

COMMIT;

-- =============================================================================
-- ROLLBACK INSTRUCTIONS
-- =============================================================================

-- To rollback (NOT RECOMMENDED):
-- BEGIN;
-- ALTER TABLE public.reports RENAME COLUMN profile_id TO prifile_id;
-- ALTER TABLE public.reports DROP CONSTRAINT reports_profile_id_fkey;
-- ALTER TABLE public.reports ADD CONSTRAINT reports_prifile_id_fkey
--   FOREIGN KEY (prifile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
-- COMMIT;
