-- Migration: Add admin approval workflow fields to posts table
-- Description: Adds status, approval, and flagging fields to enable admin CRM functionality
-- Date: 2025-11-15

-- Add status column with enum constraint
ALTER TABLE public.posts
ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'approved'
CHECK (status IN ('pending', 'approved', 'rejected', 'flagged'));

-- Add approval tracking fields
ALTER TABLE public.posts
ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS rejected_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- Add flagging fields
ALTER TABLE public.posts
ADD COLUMN IF NOT EXISTS flagged_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS flagged_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS flagged_reason TEXT;

-- Add admin notes field
ALTER TABLE public.posts
ADD COLUMN IF NOT EXISTS admin_notes TEXT;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_posts_status ON public.posts(status);
CREATE INDEX IF NOT EXISTS idx_posts_approved_by ON public.posts(approved_by);
CREATE INDEX IF NOT EXISTS idx_posts_flagged_at ON public.posts(flagged_at) WHERE flagged_at IS NOT NULL;

-- Backfill existing posts: set them all to 'approved' status so they remain visible
-- This ensures existing listings continue to show in the feed
UPDATE public.posts
SET status = 'approved'
WHERE status IS NULL OR status = 'pending';

-- Add comment for documentation
COMMENT ON COLUMN public.posts.status IS 'Approval status: pending (awaiting review), approved (visible to public), rejected (hidden), flagged (needs attention)';
COMMENT ON COLUMN public.posts.approved_by IS 'Admin user who approved this post';
COMMENT ON COLUMN public.posts.approved_at IS 'Timestamp when post was approved';
COMMENT ON COLUMN public.posts.rejected_by IS 'Admin user who rejected this post';
COMMENT ON COLUMN public.posts.rejected_at IS 'Timestamp when post was rejected';
COMMENT ON COLUMN public.posts.rejection_reason IS 'Reason for rejection (shown to post owner)';
COMMENT ON COLUMN public.posts.flagged_by IS 'Admin user who flagged this post for review';
COMMENT ON COLUMN public.posts.flagged_at IS 'Timestamp when post was flagged';
COMMENT ON COLUMN public.posts.flagged_reason IS 'Reason for flagging (internal admin use)';
COMMENT ON COLUMN public.posts.admin_notes IS 'Internal admin notes (not visible to post owner)';
