-- Fix View and Like Counters
-- Ensures post_like_counter stays in sync with post_likes table
-- and backfills any existing counters that may be NULL or out of sync

-- ============================================================================
-- 1. Create trigger function to sync post_like_counter
-- ============================================================================

CREATE OR REPLACE FUNCTION sync_post_like_counter()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- Increment counter on new like
        UPDATE posts
        SET post_like_counter = COALESCE(post_like_counter, 0) + 1
        WHERE id = NEW.post_id;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        -- Decrement counter on unlike (never go below 0)
        UPDATE posts
        SET post_like_counter = GREATEST(COALESCE(post_like_counter, 0) - 1, 0)
        WHERE id = OLD.post_id;
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$;

-- ============================================================================
-- 2. Create trigger on post_likes table
-- ============================================================================

-- Drop existing trigger if it exists (idempotent)
DROP TRIGGER IF EXISTS trg_sync_post_like_counter ON post_likes;

-- Create the trigger
CREATE TRIGGER trg_sync_post_like_counter
    AFTER INSERT OR DELETE ON post_likes
    FOR EACH ROW
    EXECUTE FUNCTION sync_post_like_counter();

-- ============================================================================
-- 3. Backfill existing post_like_counter values
-- ============================================================================

-- Update all posts with accurate like counts from post_likes table
UPDATE posts p
SET post_like_counter = COALESCE(
    (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id),
    0
)
WHERE post_like_counter IS NULL
   OR post_like_counter != COALESCE(
       (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id),
       0
   );

-- ============================================================================
-- 4. Add comment for documentation
-- ============================================================================

COMMENT ON TRIGGER trg_sync_post_like_counter ON post_likes IS
    'Keeps posts.post_like_counter in sync with actual like count. Created 2026-01-31.';

COMMENT ON FUNCTION sync_post_like_counter() IS
    'Trigger function to increment/decrement post_like_counter on like/unlike actions.';
