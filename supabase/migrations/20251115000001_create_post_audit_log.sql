-- Migration: Create post_audit_log table for admin action tracking
-- Description: Tracks all admin actions on posts (approve, reject, flag) for audit purposes
-- Date: 2025-11-15

-- Create post_audit_log table
CREATE TABLE IF NOT EXISTS public.post_audit_log (
  id BIGSERIAL PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  admin_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  action VARCHAR(20) NOT NULL CHECK (action IN ('approved', 'rejected', 'flagged', 'unflagged', 'status_changed', 'edited')),
  previous_status VARCHAR(20),
  new_status VARCHAR(20),
  reason TEXT,
  admin_notes TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() AT TIME ZONE 'utc'),

  -- Constraints
  CONSTRAINT check_valid_status_values CHECK (
    previous_status IS NULL OR previous_status IN ('pending', 'approved', 'rejected', 'flagged')
  ),
  CONSTRAINT check_new_status_values CHECK (
    new_status IS NULL OR new_status IN ('pending', 'approved', 'rejected', 'flagged')
  )
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_post_audit_log_post_id ON public.post_audit_log(post_id);
CREATE INDEX IF NOT EXISTS idx_post_audit_log_admin_id ON public.post_audit_log(admin_id);
CREATE INDEX IF NOT EXISTS idx_post_audit_log_action ON public.post_audit_log(action);
CREATE INDEX IF NOT EXISTS idx_post_audit_log_created_at ON public.post_audit_log(created_at DESC);

-- Create composite index for common queries (get audit history for a post)
CREATE INDEX IF NOT EXISTS idx_post_audit_log_post_created ON public.post_audit_log(post_id, created_at DESC);

-- Add comments for documentation
COMMENT ON TABLE public.post_audit_log IS 'Audit trail of all admin actions performed on posts';
COMMENT ON COLUMN public.post_audit_log.action IS 'Type of action: approved, rejected, flagged, unflagged, status_changed, edited';
COMMENT ON COLUMN public.post_audit_log.previous_status IS 'Post status before the action';
COMMENT ON COLUMN public.post_audit_log.new_status IS 'Post status after the action';
COMMENT ON COLUMN public.post_audit_log.reason IS 'Reason provided by admin (visible to post owner for rejections)';
COMMENT ON COLUMN public.post_audit_log.admin_notes IS 'Internal admin notes (not visible to post owner)';
COMMENT ON COLUMN public.post_audit_log.metadata IS 'Additional metadata in JSON format (e.g., changed fields for edits)';

-- Enable RLS
ALTER TABLE public.post_audit_log ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Admins can view all audit logs
CREATE POLICY "Admins can view all audit logs"
ON public.post_audit_log
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.admin
    WHERE admin.user_id = auth.uid()
    AND admin.is_admin = true
  )
);

-- RLS Policy: Admins can insert audit logs (done automatically by triggers or API)
CREATE POLICY "Admins can insert audit logs"
ON public.post_audit_log
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.admin
    WHERE admin.user_id = auth.uid()
    AND admin.is_admin = true
  )
  AND admin_id = auth.uid()
);

-- RLS Policy: Post owners can view audit logs for their own posts (transparency)
CREATE POLICY "Post owners can view audit logs for their posts"
ON public.post_audit_log
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.posts
    WHERE posts.id = post_audit_log.post_id
    AND posts.profile_id = auth.uid()
  )
);

-- Create function to automatically log status changes
CREATE OR REPLACE FUNCTION public.log_post_status_change()
RETURNS TRIGGER AS $$
BEGIN
  -- Only log if status actually changed
  IF (TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status) THEN
    -- Determine who made the change (from approved_by, rejected_by, or flagged_by)
    INSERT INTO public.post_audit_log (
      post_id,
      admin_id,
      action,
      previous_status,
      new_status,
      reason,
      admin_notes
    ) VALUES (
      NEW.id,
      COALESCE(NEW.approved_by, NEW.rejected_by, NEW.flagged_by, auth.uid()),
      CASE
        WHEN NEW.status = 'approved' THEN 'approved'
        WHEN NEW.status = 'rejected' THEN 'rejected'
        WHEN NEW.status = 'flagged' THEN 'flagged'
        ELSE 'status_changed'
      END,
      OLD.status,
      NEW.status,
      COALESCE(NEW.rejection_reason, NEW.flagged_reason),
      NEW.admin_notes
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger to automatically log status changes
DROP TRIGGER IF EXISTS trigger_log_post_status_change ON public.posts;
CREATE TRIGGER trigger_log_post_status_change
  AFTER UPDATE ON public.posts
  FOR EACH ROW
  EXECUTE FUNCTION public.log_post_status_change();

-- Grant necessary permissions
GRANT SELECT ON public.post_audit_log TO authenticated;
GRANT INSERT ON public.post_audit_log TO authenticated;
GRANT USAGE ON SEQUENCE public.post_audit_log_id_seq TO authenticated;
