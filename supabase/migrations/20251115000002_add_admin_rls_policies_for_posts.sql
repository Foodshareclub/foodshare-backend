-- Migration: Add Admin RLS Policies for Posts
-- Description: Allows admins to view, edit, and manage all posts regardless of ownership
-- Date: 2025-11-15

-- =============================================================================
-- HELPER FUNCTION: Check if user is admin
-- =============================================================================

-- Create a helper function to check admin status (reusable across policies)
CREATE OR REPLACE FUNCTION public.is_admin(user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.admin
    WHERE admin.user_id = user_id
    AND admin.is_admin = true
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION public.is_admin(UUID) TO authenticated;

-- Add comment
COMMENT ON FUNCTION public.is_admin IS 'Check if a user has admin privileges';

-- =============================================================================
-- POSTS TABLE - Admin Policies
-- =============================================================================

-- Admin Policy: Admins can view ALL posts (including pending, rejected, flagged)
CREATE POLICY "Admins can view all posts"
ON public.posts
FOR SELECT
TO authenticated
USING (
  public.is_admin(auth.uid())
);

-- Admin Policy: Admins can update ANY post (for approval/rejection/flagging)
CREATE POLICY "Admins can update all posts"
ON public.posts
FOR UPDATE
TO authenticated
USING (
  public.is_admin(auth.uid())
)
WITH CHECK (
  public.is_admin(auth.uid())
);

-- Admin Policy: Admins can delete ANY post (for content moderation)
CREATE POLICY "Admins can delete all posts"
ON public.posts
FOR DELETE
TO authenticated
USING (
  public.is_admin(auth.uid())
);

-- =============================================================================
-- UPDATE EXISTING SELECT POLICY - Include approved posts
-- =============================================================================

-- Drop the existing "Anyone can view active posts" policy
DROP POLICY IF EXISTS "Anyone can view active posts" ON public.posts;

-- Recreate with status-aware logic
-- Public users can see: active posts with status 'approved'
-- Post owners can see: their own posts regardless of status
-- Admins can see: all posts (handled by separate policy above)
CREATE POLICY "Anyone can view approved active posts"
ON public.posts
FOR SELECT
USING (
  -- Public: Can view active AND approved posts
  (active = true AND status = 'approved')
  OR
  -- Owner: Can view own posts regardless of status
  (profile_id = auth.uid())
);

-- =============================================================================
-- PREVENT NON-ADMINS FROM BYPASSING APPROVAL WORKFLOW
-- =============================================================================

-- Add constraint function to prevent users from setting their own posts to 'approved'
CREATE OR REPLACE FUNCTION public.prevent_self_approval()
RETURNS TRIGGER AS $$
BEGIN
  -- If user is trying to create or update a post with 'approved' status
  IF (TG_OP = 'INSERT' OR TG_OP = 'UPDATE') THEN
    -- Check if user is NOT an admin
    IF NOT public.is_admin(auth.uid()) THEN
      -- Force status to 'pending' for non-admins
      IF NEW.status = 'approved' AND (OLD IS NULL OR OLD.status != 'approved') THEN
        NEW.status := 'pending';
      END IF;

      -- Prevent non-admins from setting approval fields
      NEW.approved_by := NULL;
      NEW.approved_at := NULL;
      NEW.rejected_by := NULL;
      NEW.rejected_at := NULL;
      NEW.flagged_by := NULL;
      NEW.flagged_at := NULL;
      NEW.admin_notes := NULL;
    ELSE
      -- Admin is making the change - set appropriate fields
      IF NEW.status = 'approved' AND (OLD IS NULL OR OLD.status != 'approved') THEN
        NEW.approved_by := auth.uid();
        NEW.approved_at := NOW();
      ELSIF NEW.status = 'rejected' AND (OLD IS NULL OR OLD.status != 'rejected') THEN
        NEW.rejected_by := auth.uid();
        NEW.rejected_at := NOW();
      ELSIF NEW.status = 'flagged' AND (OLD IS NULL OR OLD.status != 'flagged') THEN
        NEW.flagged_by := auth.uid();
        NEW.flagged_at := NOW();
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger to enforce approval workflow
DROP TRIGGER IF EXISTS trigger_prevent_self_approval ON public.posts;
CREATE TRIGGER trigger_prevent_self_approval
  BEFORE INSERT OR UPDATE ON public.posts
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_self_approval();

-- Add comment
COMMENT ON FUNCTION public.prevent_self_approval IS 'Prevents non-admin users from bypassing the approval workflow by setting their own posts to approved status';

-- =============================================================================
-- ADMIN TABLE - Ensure policies exist
-- =============================================================================

-- Ensure RLS is enabled on admin table
ALTER TABLE public.admin ENABLE ROW LEVEL SECURITY;

-- Admins can view all admin records (for admin management UI)
DROP POLICY IF EXISTS "Admins can view all admin records" ON public.admin;
CREATE POLICY "Admins can view all admin records"
ON public.admin
FOR SELECT
TO authenticated
USING (
  public.is_admin(auth.uid())
);

-- Only super admins can insert new admins (optional: restrict further if needed)
DROP POLICY IF EXISTS "Admins can insert admin records" ON public.admin;
CREATE POLICY "Admins can insert admin records"
ON public.admin
FOR INSERT
TO authenticated
WITH CHECK (
  public.is_admin(auth.uid())
);

-- Admins can view their own admin status (for UI checks)
DROP POLICY IF EXISTS "Users can view own admin status" ON public.admin;
CREATE POLICY "Users can view own admin status"
ON public.admin
FOR SELECT
TO authenticated
USING (
  user_id = auth.uid()
);

-- =============================================================================
-- GRANTS AND PERMISSIONS
-- =============================================================================

-- Grant necessary permissions to authenticated users
GRANT SELECT ON public.admin TO authenticated;
GRANT INSERT ON public.admin TO authenticated;

-- =============================================================================
-- INDEXES FOR PERFORMANCE
-- =============================================================================

-- Create index on admin.is_admin for faster lookups
CREATE INDEX IF NOT EXISTS idx_admin_is_admin ON public.admin(is_admin) WHERE is_admin = true;

-- =============================================================================
-- TESTING QUERIES (commented out - for reference)
-- =============================================================================

-- Test if admin check works:
-- SELECT public.is_admin(auth.uid());

-- Test viewing posts as regular user (should only see approved):
-- SELECT * FROM posts WHERE active = true;

-- Test viewing posts as admin (should see all):
-- SELECT * FROM posts; -- (requires admin account)

-- =============================================================================
-- MIGRATION COMPLETE
-- =============================================================================

-- Add migration note
COMMENT ON FUNCTION public.is_admin IS 'Helper function to check if user is admin. Used by RLS policies to grant admin privileges.';
