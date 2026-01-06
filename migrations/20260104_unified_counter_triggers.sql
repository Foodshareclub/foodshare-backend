-- =============================================================================
-- Unified Counter Triggers
--
-- Automatically maintains count fields across related tables.
-- Ensures consistency for favorites, views, messages, reviews, etc.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Helper: Generic counter update function
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_counter(
    p_table_name TEXT,
    p_counter_column TEXT,
    p_id_column TEXT,
    p_id_value UUID,
    p_delta INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    EXECUTE format(
        'UPDATE %I SET %I = GREATEST(0, COALESCE(%I, 0) + $1), updated_at = NOW() WHERE %I = $2',
        p_table_name, p_counter_column, p_counter_column, p_id_column
    ) USING p_delta, p_id_value;
END;
$$;

-- -----------------------------------------------------------------------------
-- Favorites Counter
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trigger_update_favorites_count()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- Increment post favorites count
        UPDATE posts
        SET favorites_count = COALESCE(favorites_count, 0) + 1,
            updated_at = NOW()
        WHERE id = NEW.post_id;

        -- Increment user favorites given count
        UPDATE profiles
        SET favorites_given_count = COALESCE(favorites_given_count, 0) + 1
        WHERE id = NEW.user_id;

        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        -- Decrement post favorites count
        UPDATE posts
        SET favorites_count = GREATEST(0, COALESCE(favorites_count, 0) - 1),
            updated_at = NOW()
        WHERE id = OLD.post_id;

        -- Decrement user favorites given count
        UPDATE profiles
        SET favorites_given_count = GREATEST(0, COALESCE(favorites_given_count, 0) - 1)
        WHERE id = OLD.user_id;

        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_favorites_count ON favorites;
CREATE TRIGGER trg_favorites_count
    AFTER INSERT OR DELETE ON favorites
    FOR EACH ROW
    EXECUTE FUNCTION trigger_update_favorites_count();

-- -----------------------------------------------------------------------------
-- Views Counter (with rate limiting)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trigger_update_views_count()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_recent_view_exists BOOLEAN;
BEGIN
    -- Check if user viewed this post in the last hour (prevent spam)
    IF NEW.viewer_id IS NOT NULL THEN
        SELECT EXISTS (
            SELECT 1 FROM post_views
            WHERE post_id = NEW.post_id
            AND viewer_id = NEW.viewer_id
            AND viewed_at > NOW() - INTERVAL '1 hour'
            AND id != NEW.id
        ) INTO v_recent_view_exists;

        IF v_recent_view_exists THEN
            RETURN NEW; -- Don't increment for recent repeat views
        END IF;
    END IF;

    -- Increment view count
    UPDATE posts
    SET views_count = COALESCE(views_count, 0) + 1
    WHERE id = NEW.post_id;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_views_count ON post_views;
CREATE TRIGGER trg_views_count
    AFTER INSERT ON post_views
    FOR EACH ROW
    EXECUTE FUNCTION trigger_update_views_count();

-- -----------------------------------------------------------------------------
-- Messages Counter
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trigger_update_message_counts()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- Update chat room message count and last message
        UPDATE chat_rooms
        SET
            message_count = COALESCE(message_count, 0) + 1,
            last_message_at = NEW.created_at,
            last_message_preview = LEFT(NEW.content, 100),
            updated_at = NOW()
        WHERE id = NEW.room_id;

        -- Update unread count for recipient
        UPDATE chat_room_members
        SET unread_count = COALESCE(unread_count, 0) + 1
        WHERE room_id = NEW.room_id
        AND user_id != NEW.sender_id;

        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        -- Decrement message count
        UPDATE chat_rooms
        SET message_count = GREATEST(0, COALESCE(message_count, 0) - 1),
            updated_at = NOW()
        WHERE id = OLD.room_id;

        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_message_counts ON chat_messages;
CREATE TRIGGER trg_message_counts
    AFTER INSERT OR DELETE ON chat_messages
    FOR EACH ROW
    EXECUTE FUNCTION trigger_update_message_counts();

-- -----------------------------------------------------------------------------
-- Reviews Counter and Rating Average
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trigger_update_review_stats()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_target_user_id UUID;
    v_avg_rating NUMERIC;
    v_review_count INTEGER;
BEGIN
    -- Get target user
    v_target_user_id := COALESCE(NEW.reviewed_user_id, OLD.reviewed_user_id);

    -- Calculate new average and count
    SELECT
        COALESCE(AVG(rating), 0),
        COUNT(*)
    INTO v_avg_rating, v_review_count
    FROM reviews
    WHERE reviewed_user_id = v_target_user_id;

    -- Update profile
    UPDATE profiles
    SET
        rating_average = v_avg_rating,
        rating_count = v_review_count,
        updated_at = NOW()
    WHERE id = v_target_user_id;

    RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_review_stats ON reviews;
CREATE TRIGGER trg_review_stats
    AFTER INSERT OR UPDATE OR DELETE ON reviews
    FOR EACH ROW
    EXECUTE FUNCTION trigger_update_review_stats();

-- -----------------------------------------------------------------------------
-- Posts Counter (per user)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trigger_update_user_posts_count()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE profiles
        SET
            posts_count = COALESCE(posts_count, 0) + 1,
            active_posts_count = CASE
                WHEN NEW.is_active THEN COALESCE(active_posts_count, 0) + 1
                ELSE active_posts_count
            END
        WHERE id = NEW.profile_id;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE profiles
        SET
            posts_count = GREATEST(0, COALESCE(posts_count, 0) - 1),
            active_posts_count = CASE
                WHEN OLD.is_active THEN GREATEST(0, COALESCE(active_posts_count, 0) - 1)
                ELSE active_posts_count
            END
        WHERE id = OLD.profile_id;
        RETURN OLD;
    ELSIF TG_OP = 'UPDATE' THEN
        -- Handle is_active status change
        IF OLD.is_active != NEW.is_active THEN
            UPDATE profiles
            SET active_posts_count = CASE
                WHEN NEW.is_active THEN COALESCE(active_posts_count, 0) + 1
                ELSE GREATEST(0, COALESCE(active_posts_count, 0) - 1)
            END
            WHERE id = NEW.profile_id;
        END IF;
        RETURN NEW;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_user_posts_count ON posts;
CREATE TRIGGER trg_user_posts_count
    AFTER INSERT OR UPDATE OF is_active OR DELETE ON posts
    FOR EACH ROW
    EXECUTE FUNCTION trigger_update_user_posts_count();

-- -----------------------------------------------------------------------------
-- Forum Comments Counter
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trigger_update_forum_comments_count()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE forum_posts
        SET
            comments_count = COALESCE(comments_count, 0) + 1,
            last_activity_at = NOW(),
            updated_at = NOW()
        WHERE id = NEW.post_id;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE forum_posts
        SET
            comments_count = GREATEST(0, COALESCE(comments_count, 0) - 1),
            updated_at = NOW()
        WHERE id = OLD.post_id;
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_forum_comments_count ON forum_comments;
CREATE TRIGGER trg_forum_comments_count
    AFTER INSERT OR DELETE ON forum_comments
    FOR EACH ROW
    EXECUTE FUNCTION trigger_update_forum_comments_count();

-- -----------------------------------------------------------------------------
-- Forum Reactions Counter
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trigger_update_forum_reactions_count()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.target_type = 'post' THEN
            UPDATE forum_posts
            SET likes_count = COALESCE(likes_count, 0) + 1
            WHERE id = NEW.target_id;
        ELSIF NEW.target_type = 'comment' THEN
            UPDATE forum_comments
            SET likes_count = COALESCE(likes_count, 0) + 1
            WHERE id = NEW.target_id;
        END IF;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        IF OLD.target_type = 'post' THEN
            UPDATE forum_posts
            SET likes_count = GREATEST(0, COALESCE(likes_count, 0) - 1)
            WHERE id = OLD.target_id;
        ELSIF OLD.target_type = 'comment' THEN
            UPDATE forum_comments
            SET likes_count = GREATEST(0, COALESCE(likes_count, 0) - 1)
            WHERE id = OLD.target_id;
        END IF;
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_forum_reactions_count ON forum_reactions;
CREATE TRIGGER trg_forum_reactions_count
    AFTER INSERT OR DELETE ON forum_reactions
    FOR EACH ROW
    EXECUTE FUNCTION trigger_update_forum_reactions_count();

-- -----------------------------------------------------------------------------
-- Notifications Unread Counter
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trigger_update_unread_notifications()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF TG_OP = 'INSERT' AND NOT NEW.is_read THEN
        UPDATE profiles
        SET unread_notifications_count = COALESCE(unread_notifications_count, 0) + 1
        WHERE id = NEW.user_id;
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' AND OLD.is_read = FALSE AND NEW.is_read = TRUE THEN
        UPDATE profiles
        SET unread_notifications_count = GREATEST(0, COALESCE(unread_notifications_count, 0) - 1)
        WHERE id = NEW.user_id;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' AND NOT OLD.is_read THEN
        UPDATE profiles
        SET unread_notifications_count = GREATEST(0, COALESCE(unread_notifications_count, 0) - 1)
        WHERE id = OLD.user_id;
        RETURN OLD;
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_unread_notifications ON notifications;
CREATE TRIGGER trg_unread_notifications
    AFTER INSERT OR UPDATE OF is_read OR DELETE ON notifications
    FOR EACH ROW
    EXECUTE FUNCTION trigger_update_unread_notifications();

-- -----------------------------------------------------------------------------
-- Challenge Participants Counter
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trigger_update_challenge_participants()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE challenges
        SET participants_count = COALESCE(participants_count, 0) + 1
        WHERE id = NEW.challenge_id;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE challenges
        SET participants_count = GREATEST(0, COALESCE(participants_count, 0) - 1)
        WHERE id = OLD.challenge_id;
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_challenge_participants ON challenge_participants;
CREATE TRIGGER trg_challenge_participants
    AFTER INSERT OR DELETE ON challenge_participants
    FOR EACH ROW
    EXECUTE FUNCTION trigger_update_challenge_participants();

COMMENT ON FUNCTION update_counter IS 'Generic helper for updating counter columns';
COMMENT ON FUNCTION trigger_update_favorites_count IS 'Maintains favorites_count on posts and profiles';
COMMENT ON FUNCTION trigger_update_views_count IS 'Maintains views_count on posts with rate limiting';
COMMENT ON FUNCTION trigger_update_message_counts IS 'Maintains message counts and unread counts in chat rooms';
COMMENT ON FUNCTION trigger_update_review_stats IS 'Maintains rating_average and rating_count on profiles';
