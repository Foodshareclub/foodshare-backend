-- =============================================================================
-- Denormalization Triggers
--
-- Maintains denormalized fields for query optimization.
-- Keeps frequently-accessed related data in parent tables.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Post Author Denormalization
-- -----------------------------------------------------------------------------
-- Keep author info in posts for faster feed queries
CREATE OR REPLACE FUNCTION trigger_denorm_post_author()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
        -- Update posts with new author info
        UPDATE posts
        SET
            author_name = NEW.display_name,
            author_avatar = NEW.avatar_url,
            author_rating = NEW.rating_average,
            author_verified = NEW.is_verified
        WHERE profile_id = NEW.id;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_denorm_post_author ON profiles;
CREATE TRIGGER trg_denorm_post_author
    AFTER UPDATE OF display_name, avatar_url, rating_average, is_verified ON profiles
    FOR EACH ROW
    EXECUTE FUNCTION trigger_denorm_post_author();

-- -----------------------------------------------------------------------------
-- Chat Room Last Message Denormalization
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trigger_denorm_chat_last_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE chat_rooms
        SET
            last_message_content = LEFT(NEW.content, 100),
            last_message_sender_id = NEW.sender_id,
            last_message_at = NEW.created_at,
            updated_at = NOW()
        WHERE id = NEW.room_id;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_denorm_chat_last_message ON chat_messages;
CREATE TRIGGER trg_denorm_chat_last_message
    AFTER INSERT ON chat_messages
    FOR EACH ROW
    EXECUTE FUNCTION trigger_denorm_chat_last_message();

-- -----------------------------------------------------------------------------
-- Post Location City Denormalization
-- -----------------------------------------------------------------------------
-- Copy city from profile to post for location-based queries
CREATE OR REPLACE FUNCTION trigger_denorm_post_location()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_city TEXT;
BEGIN
    -- Get city from profile if not set on post
    IF NEW.city IS NULL AND NEW.profile_id IS NOT NULL THEN
        SELECT city INTO v_city
        FROM profiles
        WHERE id = NEW.profile_id;

        NEW.city := v_city;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_denorm_post_location ON posts;
CREATE TRIGGER trg_denorm_post_location
    BEFORE INSERT OR UPDATE ON posts
    FOR EACH ROW
    WHEN (NEW.city IS NULL)
    EXECUTE FUNCTION trigger_denorm_post_location();

-- -----------------------------------------------------------------------------
-- Category Counts Denormalization
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trigger_denorm_category_counts()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE categories
        SET
            posts_count = COALESCE(posts_count, 0) + 1,
            active_posts_count = CASE
                WHEN NEW.is_active THEN COALESCE(active_posts_count, 0) + 1
                ELSE active_posts_count
            END
        WHERE id = NEW.category_id;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE categories
        SET
            posts_count = GREATEST(0, COALESCE(posts_count, 0) - 1),
            active_posts_count = CASE
                WHEN OLD.is_active THEN GREATEST(0, COALESCE(active_posts_count, 0) - 1)
                ELSE active_posts_count
            END
        WHERE id = OLD.category_id;
        RETURN OLD;
    ELSIF TG_OP = 'UPDATE' THEN
        -- Handle category change
        IF OLD.category_id IS DISTINCT FROM NEW.category_id THEN
            -- Decrement old category
            IF OLD.category_id IS NOT NULL THEN
                UPDATE categories
                SET
                    posts_count = GREATEST(0, COALESCE(posts_count, 0) - 1),
                    active_posts_count = CASE
                        WHEN OLD.is_active THEN GREATEST(0, COALESCE(active_posts_count, 0) - 1)
                        ELSE active_posts_count
                    END
                WHERE id = OLD.category_id;
            END IF;

            -- Increment new category
            IF NEW.category_id IS NOT NULL THEN
                UPDATE categories
                SET
                    posts_count = COALESCE(posts_count, 0) + 1,
                    active_posts_count = CASE
                        WHEN NEW.is_active THEN COALESCE(active_posts_count, 0) + 1
                        ELSE active_posts_count
                    END
                WHERE id = NEW.category_id;
            END IF;
        -- Handle is_active change within same category
        ELSIF OLD.is_active IS DISTINCT FROM NEW.is_active THEN
            UPDATE categories
            SET active_posts_count = CASE
                WHEN NEW.is_active THEN COALESCE(active_posts_count, 0) + 1
                ELSE GREATEST(0, COALESCE(active_posts_count, 0) - 1)
            END
            WHERE id = NEW.category_id;
        END IF;
        RETURN NEW;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_denorm_category_counts ON posts;
CREATE TRIGGER trg_denorm_category_counts
    AFTER INSERT OR UPDATE OF category_id, is_active OR DELETE ON posts
    FOR EACH ROW
    EXECUTE FUNCTION trigger_denorm_category_counts();

-- -----------------------------------------------------------------------------
-- Forum Post Author Denormalization
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trigger_denorm_forum_author()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
        -- Update forum posts
        UPDATE forum_posts
        SET
            author_name = NEW.display_name,
            author_avatar = NEW.avatar_url,
            author_verified = NEW.is_verified
        WHERE author_id = NEW.id;

        -- Update forum comments
        UPDATE forum_comments
        SET
            author_name = NEW.display_name,
            author_avatar = NEW.avatar_url
        WHERE author_id = NEW.id;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_denorm_forum_author ON profiles;
CREATE TRIGGER trg_denorm_forum_author
    AFTER UPDATE OF display_name, avatar_url, is_verified ON profiles
    FOR EACH ROW
    EXECUTE FUNCTION trigger_denorm_forum_author();

-- -----------------------------------------------------------------------------
-- Challenge Completion Stats Denormalization
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trigger_denorm_challenge_stats()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_completion_count INTEGER;
    v_completion_rate NUMERIC;
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL THEN
        -- Count completions
        SELECT COUNT(*)
        INTO v_completion_count
        FROM challenge_participants
        WHERE challenge_id = NEW.challenge_id
        AND completed_at IS NOT NULL;

        -- Calculate completion rate
        SELECT
            CASE WHEN participants_count > 0
                THEN (v_completion_count::NUMERIC / participants_count * 100)
                ELSE 0
            END
        INTO v_completion_rate
        FROM challenges
        WHERE id = NEW.challenge_id;

        -- Update challenge
        UPDATE challenges
        SET
            completions_count = v_completion_count,
            completion_rate = v_completion_rate
        WHERE id = NEW.challenge_id;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_denorm_challenge_stats ON challenge_participants;
CREATE TRIGGER trg_denorm_challenge_stats
    AFTER UPDATE OF completed_at ON challenge_participants
    FOR EACH ROW
    EXECUTE FUNCTION trigger_denorm_challenge_stats();

-- -----------------------------------------------------------------------------
-- User Impact Stats Denormalization
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trigger_denorm_user_impact()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_food_saved_kg NUMERIC;
    v_meals_provided INTEGER;
BEGIN
    -- Only for completed arrangements
    IF NEW.status = 'completed' AND (OLD.status IS NULL OR OLD.status != 'completed') THEN
        -- Estimate food saved (assume average 0.5kg per item)
        v_food_saved_kg := COALESCE(NEW.quantity, 1) * 0.5;
        v_meals_provided := GREATEST(1, COALESCE(NEW.quantity, 1) / 2);

        -- Update giver profile
        UPDATE profiles
        SET
            food_saved_kg = COALESCE(food_saved_kg, 0) + v_food_saved_kg,
            meals_provided = COALESCE(meals_provided, 0) + v_meals_provided,
            shares_completed = COALESCE(shares_completed, 0) + 1,
            impact_score = COALESCE(impact_score, 0) + (v_meals_provided * 10)
        WHERE id = NEW.giver_id;

        -- Update receiver profile
        UPDATE profiles
        SET
            receives_completed = COALESCE(receives_completed, 0) + 1
        WHERE id = NEW.receiver_id;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_denorm_user_impact ON arrangements;
CREATE TRIGGER trg_denorm_user_impact
    AFTER INSERT OR UPDATE OF status ON arrangements
    FOR EACH ROW
    EXECUTE FUNCTION trigger_denorm_user_impact();

-- -----------------------------------------------------------------------------
-- Refresh Denormalized Data (Batch)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION refresh_denormalized_author_data()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_updated_count INTEGER := 0;
BEGIN
    -- Update posts with current author info
    UPDATE posts p
    SET
        author_name = pr.display_name,
        author_avatar = pr.avatar_url,
        author_rating = pr.rating_average,
        author_verified = pr.is_verified
    FROM profiles pr
    WHERE p.profile_id = pr.id
    AND (
        p.author_name IS DISTINCT FROM pr.display_name
        OR p.author_avatar IS DISTINCT FROM pr.avatar_url
        OR p.author_rating IS DISTINCT FROM pr.rating_average
        OR p.author_verified IS DISTINCT FROM pr.is_verified
    );

    GET DIAGNOSTICS v_updated_count = ROW_COUNT;

    RETURN v_updated_count;
END;
$$;

COMMENT ON FUNCTION trigger_denorm_post_author IS 'Keeps author info denormalized in posts table';
COMMENT ON FUNCTION trigger_denorm_chat_last_message IS 'Maintains last message preview in chat_rooms';
COMMENT ON FUNCTION trigger_denorm_category_counts IS 'Maintains post counts per category';
COMMENT ON FUNCTION refresh_denormalized_author_data IS 'Batch refresh for denormalized author data';
