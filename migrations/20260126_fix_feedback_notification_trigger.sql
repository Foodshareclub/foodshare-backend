-- Fix: Replace broken feedback notification trigger with working version
-- Error was: "function should_send_email_notification(uuid, unknown) does not exist"

-- Drop the broken trigger and function first
DROP TRIGGER IF EXISTS trigger_notify_new_feedback ON feedback;
DROP FUNCTION IF EXISTS notify_new_feedback();

-- Cleanup orphaned function variants
DROP FUNCTION IF EXISTS should_send_email_notification(uuid, unknown);
DROP FUNCTION IF EXISTS should_send_email_notification(uuid, text);
DROP FUNCTION IF EXISTS should_send_email_notification(uuid, uuid);
DROP FUNCTION IF EXISTS should_send_email_notification(uuid);
DROP FUNCTION IF EXISTS should_send_email_notification();

-- Create working feedback notification function
CREATE OR REPLACE FUNCTION public.notify_new_feedback()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  -- Queue email to support
  PERFORM public.queue_email(
    NULL::uuid,
    'support@foodshare.club',
    'feedback',
    'feedback-alert',
    jsonb_build_object(
      'feedback_id', NEW.id,
      'feedback_type', NEW.feedback_type,
      'subject', NEW.subject,
      'submitter_name', NEW.name,
      'submitter_email', NEW.email,
      'message', NEW.message,
      'message_preview', LEFT(NEW.message, 200),
      'created_at', NEW.created_at
    )
  );

  RETURN NEW;
END;
$$;

-- Create the trigger
CREATE TRIGGER trigger_notify_new_feedback
  AFTER INSERT ON public.feedback
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_new_feedback();
