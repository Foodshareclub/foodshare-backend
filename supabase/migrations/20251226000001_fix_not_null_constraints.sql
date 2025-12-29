-- Migration: Fix NOT NULL Constraints (Corrects previous migration errors)
-- Date: 2025-12-26
-- Description: Fixes column name errors in 20251104104840_add_missing_not_null_constraints.sql
--
-- Issues Fixed:
--   1. post_title → post_name (column name was wrong)
--   2. location_UPDATE_queue → location_update_queue (case sensitivity)
--
-- These fixes ensure the NOT NULL constraints are applied to the correct columns.

BEGIN;

-- ============================================================================
-- FIX 1: posts.post_name NOT NULL constraint
-- ============================================================================
-- The previous migration tried to add NOT NULL to "post_title" which doesn't exist.
-- The actual column is "post_name".

-- Backfill NULL post_name values
UPDATE public.posts
SET post_name = '(No Title)'
WHERE post_name IS NULL OR post_name = '';

-- Add NOT NULL constraint to the correct column (post_name)
-- Use DO block to handle case where constraint already exists
DO $$
BEGIN
  ALTER TABLE public.posts ALTER COLUMN post_name SET NOT NULL;
  RAISE NOTICE '✅ Added NOT NULL constraint to posts.post_name';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'posts.post_name constraint already exists or error: %', SQLERRM;
END $$;

-- ============================================================================
-- FIX 2: location_update_queue.created_at (correct table name case)
-- ============================================================================
-- The previous migration used "location_UPDATE_queue" which is incorrect.
-- PostgreSQL is case-sensitive for unquoted identifiers.

-- Ensure the constraint exists on the correctly-named table
DO $$
BEGIN
  -- First backfill any NULLs
  UPDATE public.location_update_queue
  SET created_at = CURRENT_TIMESTAMP
  WHERE created_at IS NULL;

  -- Add NOT NULL constraint
  ALTER TABLE public.location_update_queue ALTER COLUMN created_at SET NOT NULL;
  RAISE NOTICE '✅ Added NOT NULL constraint to location_update_queue.created_at';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'location_update_queue.created_at constraint already exists or error: %', SQLERRM;
END $$;

-- ============================================================================
-- VERIFICATION
-- ============================================================================

DO $$
DECLARE
  post_name_nullable boolean;
  created_at_nullable boolean;
BEGIN
  -- Check posts.post_name
  SELECT is_nullable = 'YES' INTO post_name_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'posts'
    AND column_name = 'post_name';

  IF post_name_nullable = false THEN
    RAISE NOTICE '✅ posts.post_name is NOT NULL';
  ELSE
    RAISE WARNING '⚠️ posts.post_name is still nullable';
  END IF;

  -- Check location_update_queue.created_at
  SELECT is_nullable = 'YES' INTO created_at_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'location_update_queue'
    AND column_name = 'created_at';

  IF created_at_nullable = false THEN
    RAISE NOTICE '✅ location_update_queue.created_at is NOT NULL';
  ELSE
    RAISE WARNING '⚠️ location_update_queue.created_at is still nullable';
  END IF;
END $$;

COMMIT;
