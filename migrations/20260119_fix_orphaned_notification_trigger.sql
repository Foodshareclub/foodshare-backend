-- Fix: Drop orphaned triggers calling non-existent should_send_email_notification function
-- The function was deleted but the trigger(s) were not dropped, causing errors on chat operations

-- Drop any trigger that might be calling should_send_email_notification on room_participants
DROP TRIGGER IF EXISTS trg_notify_on_message ON room_participants;
DROP TRIGGER IF EXISTS trg_send_email_notification ON room_participants;
DROP TRIGGER IF EXISTS trg_message_email_notification ON room_participants;

-- Drop the function if it exists (cleanup for any variant signatures)
DROP FUNCTION IF EXISTS should_send_email_notification(uuid, unknown);
DROP FUNCTION IF EXISTS should_send_email_notification(uuid, text);
DROP FUNCTION IF EXISTS should_send_email_notification(uuid, uuid);
DROP FUNCTION IF EXISTS should_send_email_notification();
