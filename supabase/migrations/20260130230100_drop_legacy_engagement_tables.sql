-- ============================================================================
-- DROP LEGACY ENGAGEMENT TABLES
-- ============================================================================
-- Version: 1.0.0
-- Date: 2026-01-30
--
-- This migration removes the legacy engagement tables after successful
-- data migration to unified tables in 20260131000010_enterprise_unified_engagement.sql
--
-- Legacy tables being removed:
--   - comment_likes    → migrated to likes table (comment_id > 0)
--   - forum_likes      → migrated to likes table (forum_id > 0)
--   - forum_bookmarks  → migrated to bookmarks table (forum_id > 0)
--   - post_bookmarks   → migrated to bookmarks table (post_id > 0)
--
-- Benefits:
--   - Simplified schema with single source of truth
--   - Reduced maintenance overhead
--   - Eliminates data synchronization issues
--   - Cleaner codebase with unified APIs
-- ============================================================================

-- ============================================================================
-- PART 1: SAFETY VERIFICATION
-- ============================================================================

DO $$
DECLARE
    v_likes_count INTEGER;
    v_bookmarks_count INTEGER;
    v_legacy_comment_likes INTEGER := 0;
    v_legacy_forum_likes INTEGER := 0;
    v_legacy_forum_bookmarks INTEGER := 0;
    v_legacy_post_bookmarks INTEGER := 0;
BEGIN
    -- Count records in unified tables
    SELECT COUNT(*) INTO v_likes_count FROM likes;
    SELECT COUNT(*) INTO v_bookmarks_count FROM bookmarks;

    -- Count records in legacy tables (if they exist)
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'comment_likes' AND table_schema = 'public') THEN
        SELECT COUNT(*) INTO v_legacy_comment_likes FROM comment_likes;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'forum_likes' AND table_schema = 'public') THEN
        SELECT COUNT(*) INTO v_legacy_forum_likes FROM forum_likes;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'forum_bookmarks' AND table_schema = 'public') THEN
        SELECT COUNT(*) INTO v_legacy_forum_bookmarks FROM forum_bookmarks;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'post_bookmarks' AND table_schema = 'public') THEN
        SELECT COUNT(*) INTO v_legacy_post_bookmarks FROM post_bookmarks;
    END IF;

    -- Log migration statistics
    RAISE NOTICE '==========================================================';
    RAISE NOTICE 'UNIFIED TABLES STATUS:';
    RAISE NOTICE '  - likes table: % records', v_likes_count;
    RAISE NOTICE '  - bookmarks table: % records', v_bookmarks_count;
    RAISE NOTICE '';
    RAISE NOTICE 'LEGACY TABLES STATUS (to be dropped):';
    RAISE NOTICE '  - comment_likes: % records', v_legacy_comment_likes;
    RAISE NOTICE '  - forum_likes: % records', v_legacy_forum_likes;
    RAISE NOTICE '  - forum_bookmarks: % records', v_legacy_forum_bookmarks;
    RAISE NOTICE '  - post_bookmarks: % records', v_legacy_post_bookmarks;
    RAISE NOTICE '==========================================================';

    -- Safety check: Ensure unified tables have data if legacy tables had data
    IF (v_legacy_comment_likes + v_legacy_forum_likes + v_legacy_forum_bookmarks + v_legacy_post_bookmarks) > 0 THEN
        IF v_likes_count = 0 AND (v_legacy_comment_likes + v_legacy_forum_likes) > 0 THEN
            RAISE WARNING 'WARNING: Unified likes table is empty but legacy tables have data. Migration may not have completed successfully.';
        END IF;

        IF v_bookmarks_count = 0 AND (v_legacy_forum_bookmarks + v_legacy_post_bookmarks) > 0 THEN
            RAISE WARNING 'WARNING: Unified bookmarks table is empty but legacy tables have data. Migration may not have completed successfully.';
        END IF;
    END IF;

    RAISE NOTICE 'Safety checks completed. Proceeding with table drops...';
END $$;

-- ============================================================================
-- PART 2: DROP LEGACY TABLES
-- ============================================================================

-- Drop comment_likes table
-- (migrated to: likes table with comment_id > 0)
DROP TABLE IF EXISTS comment_likes CASCADE;

-- Drop forum_likes table
-- (migrated to: likes table with forum_id > 0)
DROP TABLE IF EXISTS forum_likes CASCADE;

-- Drop forum_bookmarks table
-- (migrated to: bookmarks table with forum_id > 0)
DROP TABLE IF EXISTS forum_bookmarks CASCADE;

-- Drop post_bookmarks table
-- (migrated to: bookmarks table with post_id > 0)
DROP TABLE IF EXISTS post_bookmarks CASCADE;

-- ============================================================================
-- PART 3: CLEANUP AND VERIFICATION
-- ============================================================================

DO $$
DECLARE
    v_remaining_tables TEXT[];
BEGIN
    -- Check for any remaining legacy tables
    SELECT ARRAY_AGG(table_name) INTO v_remaining_tables
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('comment_likes', 'forum_likes', 'forum_bookmarks', 'post_bookmarks');

    IF v_remaining_tables IS NULL THEN
        RAISE NOTICE '';
        RAISE NOTICE '==========================================================';
        RAISE NOTICE 'SUCCESS: All legacy engagement tables have been dropped.';
        RAISE NOTICE '==========================================================';
        RAISE NOTICE '';
        RAISE NOTICE 'The system now uses unified tables:';
        RAISE NOTICE '  - likes: All entity likes (posts, forum, challenges, comments)';
        RAISE NOTICE '  - bookmarks: All entity bookmarks (posts, forum)';
        RAISE NOTICE '';
        RAISE NOTICE 'Migration completed successfully on: %', NOW();
        RAISE NOTICE '==========================================================';
    ELSE
        RAISE WARNING 'WARNING: Some legacy tables still exist: %', v_remaining_tables;
    END IF;
END $$;

-- ============================================================================
-- PART 4: DOCUMENTATION
-- ============================================================================

COMMENT ON TABLE likes IS 'Unified likes table for all entity types (posts, forum, challenges, comments). Migrated from legacy tables: forum_likes, comment_likes. See migration 20260131000010 for data migration details.';

COMMENT ON TABLE bookmarks IS 'Unified bookmarks table for posts and forum. Migrated from legacy tables: forum_bookmarks, post_bookmarks. See migration 20260131000010 for data migration details.';

-- ============================================================================
-- END OF MIGRATION
-- ============================================================================
