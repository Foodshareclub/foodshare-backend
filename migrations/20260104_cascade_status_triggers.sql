-- =============================================================================
-- Cascade Status Triggers
--
-- Handles status changes that cascade to related entities.
-- Ensures data consistency when parent entities change state.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Post Expiration Cascade
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trigger_cascade_post_expiration()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- When a post expires or is deactivated
    IF NEW.is_active = FALSE AND OLD.is_active = TRUE THEN
        -- Cancel pending arrangements
        UPDATE arrangements
        SET
            status = 'cancelled',
            cancelled_at = NOW(),
            cancellation_reason = 'post_expired',
            updated_at = NOW()
        WHERE post_id = NEW.id
        AND status IN ('pending', 'confirmed');

        -- Notify users with pending arrangements
        INSERT INTO notifications (user_id, type, title, body, data)
        SELECT
            CASE WHEN a.giver_id = NEW.profile_id THEN a.receiver_id ELSE a.giver_id END,
            'listing_expired',
            'Listing No Longer Available',
            'The listing "' || LEFT(NEW.post_name, 50) || '" is no longer available.',
            jsonb_build_object(
                'post_id', NEW.id,
                'arrangement_id', a.id
            )
        FROM arrangements a
        WHERE a.post_id = NEW.id
        AND a.status = 'cancelled'
        AND a.cancelled_at = NOW();
    END IF;

    -- When a post is reactivated
    IF NEW.is_active = TRUE AND OLD.is_active = FALSE THEN
        -- Clear expiration if it was the reason for deactivation
        IF NEW.expires_at IS NOT NULL AND NEW.expires_at < NOW() THEN
            NEW.expires_at := NULL;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cascade_post_expiration ON posts;
CREATE TRIGGER trg_cascade_post_expiration
    AFTER UPDATE OF is_active ON posts
    FOR EACH ROW
    EXECUTE FUNCTION trigger_cascade_post_expiration();

-- -----------------------------------------------------------------------------
-- User Deactivation Cascade
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trigger_cascade_user_deactivation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- When a user is deactivated
    IF NEW.is_active = FALSE AND OLD.is_active = TRUE THEN
        -- Deactivate all user's posts
        UPDATE posts
        SET
            is_active = FALSE,
            deactivation_reason = 'user_deactivated',
            updated_at = NOW()
        WHERE profile_id = NEW.id
        AND is_active = TRUE;

        -- Cancel pending arrangements
        UPDATE arrangements
        SET
            status = 'cancelled',
            cancelled_at = NOW(),
            cancellation_reason = 'user_deactivated',
            updated_at = NOW()
        WHERE (giver_id = NEW.id OR receiver_id = NEW.id)
        AND status IN ('pending', 'confirmed');

        -- Archive chat room memberships
        UPDATE chat_room_members
        SET
            is_active = FALSE,
            left_at = NOW()
        WHERE user_id = NEW.id
        AND is_active = TRUE;
    END IF;

    -- When a user is reactivated
    IF NEW.is_active = TRUE AND OLD.is_active = FALSE THEN
        -- Optionally reactivate posts (or leave them for user to manually reactivate)
        -- UPDATE posts SET is_active = TRUE WHERE profile_id = NEW.id AND deactivation_reason = 'user_deactivated';

        -- Reactivate chat room memberships
        UPDATE chat_room_members
        SET
            is_active = TRUE,
            left_at = NULL
        WHERE user_id = NEW.id
        AND is_active = FALSE;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cascade_user_deactivation ON profiles;
CREATE TRIGGER trg_cascade_user_deactivation
    AFTER UPDATE OF is_active ON profiles
    FOR EACH ROW
    EXECUTE FUNCTION trigger_cascade_user_deactivation();

-- -----------------------------------------------------------------------------
-- User Deletion Cascade (Soft Delete)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trigger_cascade_user_deletion()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- When a user is soft-deleted
    IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
        -- Anonymize posts (keep for history but remove personal info)
        UPDATE posts
        SET
            is_active = FALSE,
            author_name = 'Deleted User',
            author_avatar = NULL,
            updated_at = NOW()
        WHERE profile_id = NEW.id;

        -- Anonymize chat messages (keep content but remove sender reference)
        UPDATE chat_messages
        SET
            sender_name = 'Deleted User'
        WHERE sender_id = NEW.id;

        -- Anonymize reviews
        UPDATE reviews
        SET
            reviewer_name = 'Deleted User',
            reviewer_avatar = NULL
        WHERE reviewer_id = NEW.id;

        -- Remove from chat rooms
        UPDATE chat_room_members
        SET
            is_active = FALSE,
            left_at = NOW()
        WHERE user_id = NEW.id;

        -- Cancel pending arrangements
        UPDATE arrangements
        SET
            status = 'cancelled',
            cancelled_at = NOW(),
            cancellation_reason = 'user_deleted'
        WHERE (giver_id = NEW.id OR receiver_id = NEW.id)
        AND status IN ('pending', 'confirmed');
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cascade_user_deletion ON profiles;
CREATE TRIGGER trg_cascade_user_deletion
    AFTER UPDATE OF deleted_at ON profiles
    FOR EACH ROW
    EXECUTE FUNCTION trigger_cascade_user_deletion();

-- -----------------------------------------------------------------------------
-- Arrangement Status Cascade
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trigger_cascade_arrangement_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- When arrangement is confirmed
    IF NEW.status = 'confirmed' AND OLD.status = 'pending' THEN
        -- Notify both parties
        INSERT INTO notifications (user_id, type, title, body, data)
        VALUES
        (
            NEW.giver_id,
            'arrangement_confirmed',
            'Arrangement Confirmed',
            'Your arrangement has been confirmed!',
            jsonb_build_object('arrangement_id', NEW.id, 'post_id', NEW.post_id)
        ),
        (
            NEW.receiver_id,
            'arrangement_confirmed',
            'Arrangement Confirmed',
            'Your arrangement has been confirmed!',
            jsonb_build_object('arrangement_id', NEW.id, 'post_id', NEW.post_id)
        );
    END IF;

    -- When arrangement is completed
    IF NEW.status = 'completed' AND OLD.status != 'completed' THEN
        -- Update post quantity if applicable
        IF NEW.quantity IS NOT NULL THEN
            UPDATE posts
            SET
                quantity = GREATEST(0, COALESCE(quantity, 0) - NEW.quantity),
                is_active = CASE
                    WHEN GREATEST(0, COALESCE(quantity, 0) - NEW.quantity) = 0 THEN FALSE
                    ELSE is_active
                END,
                updated_at = NOW()
            WHERE id = NEW.post_id;
        END IF;

        -- Prompt for review after delay (handled by scheduled job)
        INSERT INTO scheduled_jobs (job_type, execute_at, payload)
        VALUES (
            'prompt_review',
            NOW() + INTERVAL '1 day',
            jsonb_build_object(
                'arrangement_id', NEW.id,
                'giver_id', NEW.giver_id,
                'receiver_id', NEW.receiver_id
            )
        );
    END IF;

    -- When arrangement is cancelled
    IF NEW.status = 'cancelled' AND OLD.status NOT IN ('cancelled', 'completed') THEN
        -- Notify the other party
        INSERT INTO notifications (user_id, type, title, body, data)
        SELECT
            CASE
                WHEN NEW.cancelled_by = NEW.giver_id THEN NEW.receiver_id
                ELSE NEW.giver_id
            END,
            'arrangement_cancelled',
            'Arrangement Cancelled',
            'An arrangement has been cancelled.',
            jsonb_build_object(
                'arrangement_id', NEW.id,
                'post_id', NEW.post_id,
                'reason', NEW.cancellation_reason
            );
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cascade_arrangement_status ON arrangements;
CREATE TRIGGER trg_cascade_arrangement_status
    AFTER UPDATE OF status ON arrangements
    FOR EACH ROW
    EXECUTE FUNCTION trigger_cascade_arrangement_status();

-- -----------------------------------------------------------------------------
-- Challenge Completion Cascade
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trigger_cascade_challenge_completion()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_challenge RECORD;
BEGIN
    -- When a participant completes a challenge
    IF NEW.completed_at IS NOT NULL AND OLD.completed_at IS NULL THEN
        -- Get challenge info
        SELECT * INTO v_challenge
        FROM challenges
        WHERE id = NEW.challenge_id;

        -- Award points
        UPDATE profiles
        SET
            points = COALESCE(points, 0) + COALESCE(v_challenge.reward_points, 0),
            challenges_completed = COALESCE(challenges_completed, 0) + 1,
            updated_at = NOW()
        WHERE id = NEW.user_id;

        -- Award badge if applicable
        IF v_challenge.badge_id IS NOT NULL THEN
            INSERT INTO user_badges (user_id, badge_id, earned_at)
            VALUES (NEW.user_id, v_challenge.badge_id, NOW())
            ON CONFLICT (user_id, badge_id) DO NOTHING;
        END IF;

        -- Create notification
        INSERT INTO notifications (user_id, type, title, body, data)
        VALUES (
            NEW.user_id,
            'challenge_complete',
            'Challenge Completed!',
            'You completed "' || v_challenge.title || '" and earned ' || v_challenge.reward_points || ' points!',
            jsonb_build_object(
                'challenge_id', NEW.challenge_id,
                'points', v_challenge.reward_points,
                'badge_id', v_challenge.badge_id
            )
        );
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cascade_challenge_completion ON challenge_participants;
CREATE TRIGGER trg_cascade_challenge_completion
    AFTER UPDATE OF completed_at ON challenge_participants
    FOR EACH ROW
    EXECUTE FUNCTION trigger_cascade_challenge_completion();

-- -----------------------------------------------------------------------------
-- Report Resolution Cascade
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trigger_cascade_report_resolution()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- When a report is resolved with action
    IF NEW.status = 'resolved' AND OLD.status != 'resolved' THEN
        CASE NEW.action_taken
            WHEN 'remove_content' THEN
                -- Remove the reported content
                IF NEW.target_type = 'post' THEN
                    UPDATE posts SET is_active = FALSE, moderation_status = 'removed'
                    WHERE id = NEW.target_id;
                ELSIF NEW.target_type = 'forum_post' THEN
                    UPDATE forum_posts SET is_active = FALSE, moderation_status = 'removed'
                    WHERE id = NEW.target_id;
                ELSIF NEW.target_type = 'forum_comment' THEN
                    UPDATE forum_comments SET is_active = FALSE, moderation_status = 'removed'
                    WHERE id = NEW.target_id;
                END IF;

            WHEN 'warn_user' THEN
                -- Issue warning to user
                UPDATE profiles
                SET warning_count = COALESCE(warning_count, 0) + 1
                WHERE id = NEW.reported_user_id;

                INSERT INTO notifications (user_id, type, title, body, data)
                VALUES (
                    NEW.reported_user_id,
                    'moderation_warning',
                    'Content Policy Warning',
                    'Your content has been flagged for policy violation.',
                    jsonb_build_object('report_id', NEW.id)
                );

            WHEN 'suspend_user' THEN
                -- Suspend the user
                UPDATE profiles
                SET
                    is_suspended = TRUE,
                    suspended_until = NOW() + INTERVAL '7 days',
                    suspension_reason = NEW.moderator_notes
                WHERE id = NEW.reported_user_id;

            WHEN 'ban_user' THEN
                -- Ban the user
                UPDATE profiles
                SET
                    is_active = FALSE,
                    is_banned = TRUE,
                    banned_at = NOW(),
                    ban_reason = NEW.moderator_notes
                WHERE id = NEW.reported_user_id;
        END CASE;

        -- Notify reporter
        INSERT INTO notifications (user_id, type, title, body, data)
        VALUES (
            NEW.reporter_id,
            'report_resolved',
            'Report Reviewed',
            'Your report has been reviewed and action has been taken.',
            jsonb_build_object('report_id', NEW.id, 'action', NEW.action_taken)
        );
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cascade_report_resolution ON reports;
CREATE TRIGGER trg_cascade_report_resolution
    AFTER UPDATE OF status ON reports
    FOR EACH ROW
    EXECUTE FUNCTION trigger_cascade_report_resolution();

COMMENT ON FUNCTION trigger_cascade_post_expiration IS 'Cascades post expiration to related arrangements';
COMMENT ON FUNCTION trigger_cascade_user_deactivation IS 'Cascades user deactivation to posts and arrangements';
COMMENT ON FUNCTION trigger_cascade_arrangement_status IS 'Handles side effects of arrangement status changes';
COMMENT ON FUNCTION trigger_cascade_challenge_completion IS 'Awards points and badges on challenge completion';
