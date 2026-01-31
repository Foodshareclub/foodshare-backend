-- Migration: Add Blocking Filter to RPC Functions
-- Purpose: Filter blocked users from all content queries (Apple App Review requirement)
-- Date: 2026-01-28
-- Status: TODO - Must be deployed before iOS app goes live

-- NOTE: This migration adds blocking filters to existing RPC functions
-- The iOS app already passes excludeBlockedUsers parameter but it's not yet implemented
-- This must be deployed to production before the app is approved

-- Example implementation for get_nearby_posts:
-- Add WHERE clause: AND NOT is_blocked_by_user(p_user_id, posts.user_id)
-- Where p_user_id is the authenticated user making the request

-- TODO: Update the following RPC functions to filter blocked users:
-- 1. get_nearby_posts - Add blocking filter
-- 2. search_posts - Add blocking filter  
-- 3. get_user_posts - Add blocking filter
-- 4. get_feed_posts - Add blocking filter
-- 5. Any other content retrieval functions

-- The is_blocked_by_user(UUID, UUID) function is already available
-- It checks bidirectional blocking (if A blocked B OR B blocked A)

COMMENT ON SCHEMA public IS 'Blocking filters must be added to all RPC functions before iOS app approval';
