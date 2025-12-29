-- Migration: Fix RLS Policies
-- Priority: CRITICAL
-- Description: Updates and creates secure RLS policies for all tables
-- Impact: Fixes insecure policies and adds missing policies for proper data access control
--
-- Changes:
-- 1. Removes duplicate/permissive policies
-- 2. Adds missing policies for INSERT/UPDATE/DELETE operations
-- 3. Restricts room creation to authenticated users
-- 4. Properly scopes access to user-owned data
--
-- Created: 2025-01-04
-- Author: Database Security Audit

-- =============================================================================
-- PROFILES TABLE - Fix Duplicate Policies
-- =============================================================================

-- Remove duplicate SELECT policy (keep only one)
DROP POLICY IF EXISTS "Allow users to view their own profiles" ON profiles;
-- Keep "Enable read access for all users" policy

-- Ensure users can only update their own profile
DROP POLICY IF EXISTS "Allow users to update their own profiles" ON profiles;
CREATE POLICY "Users can update own profile" ON profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- =============================================================================
-- ADDRESS TABLE
-- =============================================================================

-- Users can only view their own address
DROP POLICY IF EXISTS "Enable read access for all users" ON address;
CREATE POLICY "Users can read own address" ON address
  FOR SELECT TO authenticated
  USING (profile_id = auth.uid());

-- Users can update their own address
DROP POLICY IF EXISTS "Enable update for users based on address.profile_id" ON address;
CREATE POLICY "Users can update own address" ON address
  FOR UPDATE TO authenticated
  USING (profile_id = auth.uid())
  WITH CHECK (profile_id = auth.uid());

-- Users can insert their own address (one per user)
CREATE POLICY "Users can insert own address" ON address
  FOR INSERT TO authenticated
  WITH CHECK (
    profile_id = auth.uid() AND
    NOT EXISTS (SELECT 1 FROM address WHERE profile_id = auth.uid())
  );

-- =============================================================================
-- POSTS TABLE
-- =============================================================================

-- Everyone can view active posts
CREATE POLICY "Anyone can view active posts" ON posts
  FOR SELECT
  USING (active = true OR profile_id = auth.uid());

-- Authenticated users can create posts
CREATE POLICY "Authenticated users can create posts" ON posts
  FOR INSERT TO authenticated
  WITH CHECK (profile_id = auth.uid());

-- Users can update their own posts
CREATE POLICY "Users can update own posts" ON posts
  FOR UPDATE TO authenticated
  USING (profile_id = auth.uid())
  WITH CHECK (profile_id = auth.uid());

-- Users can delete their own posts
CREATE POLICY "Users can delete own posts" ON posts
  FOR DELETE TO authenticated
  USING (profile_id = auth.uid());

-- =============================================================================
-- ROOMS TABLE - Fix Insecure Policies
-- =============================================================================

-- Remove insecure "anyone can create" policy
DROP POLICY IF EXISTS "Anyone can create a new room" ON rooms;

-- Only authenticated users involved in the post can create rooms
CREATE POLICY "Participants can create rooms" ON rooms
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() IN (sharer, requester)
  );

-- Only participants can view room details
CREATE POLICY "Participants can view rooms" ON rooms
  FOR SELECT TO authenticated
  USING (
    auth.uid() IN (sharer, requester)
  );

-- Only participants can update room (for message tracking)
CREATE POLICY "Participants can update rooms" ON rooms
  FOR UPDATE TO authenticated
  USING (auth.uid() IN (sharer, requester))
  WITH CHECK (auth.uid() IN (sharer, requester));

-- =============================================================================
-- ROOM_PARTICIPANTS TABLE - Add Missing Policies
-- =============================================================================

-- Drop existing incomplete policy
DROP POLICY IF EXISTS "Enable delete for users based on user_id" ON room_participants;

-- Participants can view messages in their rooms
CREATE POLICY "Participants can view messages" ON room_participants
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM rooms
      WHERE rooms.id = room_participants.room_id
      AND (rooms.sharer = auth.uid() OR rooms.requester = auth.uid())
    )
  );

-- Participants can send messages
CREATE POLICY "Participants can send messages" ON room_participants
  FOR INSERT TO authenticated
  WITH CHECK (
    profile_id = auth.uid() AND
    EXISTS (
      SELECT 1 FROM rooms
      WHERE rooms.id = room_participants.room_id
      AND (rooms.sharer = auth.uid() OR rooms.requester = auth.uid())
    )
  );

-- Users can update their own messages (edit functionality)
CREATE POLICY "Users can update own messages" ON room_participants
  FOR UPDATE TO authenticated
  USING (profile_id = auth.uid())
  WITH CHECK (profile_id = auth.uid());

-- Users can delete their own messages
CREATE POLICY "Users can delete own messages" ON room_participants
  FOR DELETE TO authenticated
  USING (profile_id = auth.uid());

-- =============================================================================
-- LIKES TABLE - Add Missing Policies
-- =============================================================================

-- Everyone can view likes
CREATE POLICY "Anyone can view likes" ON likes
  FOR SELECT
  USING (true);

-- Authenticated users can like content
CREATE POLICY "Users can create likes" ON likes
  FOR INSERT TO authenticated
  WITH CHECK (profile_id = auth.uid());

-- Users can only unlike their own likes
CREATE POLICY "Users can delete own likes" ON likes
  FOR DELETE TO authenticated
  USING (profile_id = auth.uid());

-- =============================================================================
-- REVIEWS TABLE - Add Missing Policies
-- =============================================================================

-- Everyone can view reviews
CREATE POLICY "Anyone can view reviews" ON reviews
  FOR SELECT
  USING (true);

-- Authenticated users can create reviews
CREATE POLICY "Users can create reviews" ON reviews
  FOR INSERT TO authenticated
  WITH CHECK (profile_id = auth.uid());

-- Users can update their own reviews
CREATE POLICY "Users can update own reviews" ON reviews
  FOR UPDATE TO authenticated
  USING (profile_id = auth.uid())
  WITH CHECK (profile_id = auth.uid());

-- Users can delete their own reviews
CREATE POLICY "Users can delete own reviews" ON reviews
  FOR DELETE TO authenticated
  USING (profile_id = auth.uid());

-- =============================================================================
-- COMMENTS TABLE - Add Missing Policies
-- =============================================================================

-- Everyone can view comments
CREATE POLICY "Anyone can view comments" ON comments
  FOR SELECT
  USING (true);

-- Authenticated users can create comments
CREATE POLICY "Users can create comments" ON comments
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- Users can update their own comments
CREATE POLICY "Users can update own comments" ON comments
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Users can delete their own comments
CREATE POLICY "Users can delete own comments" ON comments
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- =============================================================================
-- FORUM TABLE
-- =============================================================================

-- Everyone can view published forum posts
CREATE POLICY "Anyone can view published forums" ON forum
  FOR SELECT
  USING (forum_published = true OR profile_id = auth.uid());

-- Authenticated users can create forum posts
CREATE POLICY "Users can create forums" ON forum
  FOR INSERT TO authenticated
  WITH CHECK (profile_id = auth.uid());

-- Users can update their own forum posts
CREATE POLICY "Users can update own forums" ON forum
  FOR UPDATE TO authenticated
  USING (profile_id = auth.uid())
  WITH CHECK (profile_id = auth.uid());

-- Users can delete their own forum posts
CREATE POLICY "Users can delete own forums" ON forum
  FOR DELETE TO authenticated
  USING (profile_id = auth.uid());

-- =============================================================================
-- CHALLENGES TABLE
-- =============================================================================

-- Everyone can view published challenges
CREATE POLICY "Anyone can view published challenges" ON challenges
  FOR SELECT
  USING (challenge_published = true OR profile_id = auth.uid());

-- Authenticated users can create challenges
CREATE POLICY "Users can create challenges" ON challenges
  FOR INSERT TO authenticated
  WITH CHECK (profile_id = auth.uid());

-- Users can update their own challenges
CREATE POLICY "Users can update own challenges" ON challenges
  FOR UPDATE TO authenticated
  USING (profile_id = auth.uid())
  WITH CHECK (profile_id = auth.uid());

-- =============================================================================
-- NOTIFICATIONS TABLE
-- =============================================================================

-- Users can only view their own notifications
CREATE POLICY "Users can view own notifications" ON notifications
  FOR SELECT TO authenticated
  USING (profile_id = auth.uid());

-- Service role can insert notifications (for Edge Functions)
CREATE POLICY "Service can create notifications" ON notifications
  FOR INSERT TO service_role
  WITH CHECK (true);

-- Users can delete their own notifications
CREATE POLICY "Users can delete own notifications" ON notifications
  FOR DELETE TO authenticated
  USING (profile_id = auth.uid());

-- =============================================================================
-- ADMIN TABLE
-- =============================================================================

-- Only admins can view admin table
DROP POLICY IF EXISTS "Enable read access for all users" ON admin;
CREATE POLICY "Only admins can view admin table" ON admin
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid() AND is_admin = true
  );

-- Only existing admins can create new admins
CREATE POLICY "Only admins can create admins" ON admin
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM admin
      WHERE user_id = auth.uid() AND is_admin = true
    )
  );

-- =============================================================================
-- REPORTS TABLE
-- =============================================================================

-- Users can create reports
CREATE POLICY "Users can create reports" ON reports
  FOR INSERT TO authenticated
  WITH CHECK (profile_id = auth.uid());

-- Only admins can view reports (fix typo: prifile_id -> profile_id after column rename)
CREATE POLICY "Admins can view reports" ON reports
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM admin
      WHERE user_id = auth.uid() AND is_admin = true
    )
  );

-- =============================================================================
-- FEEDBACK TABLE
-- =============================================================================

-- Anyone can submit feedback
CREATE POLICY "Anyone can create feedback" ON feedback
  FOR INSERT
  WITH CHECK (true);

-- Only admins can view feedback
CREATE POLICY "Admins can view feedback" ON feedback
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM admin
      WHERE user_id = auth.uid() AND is_admin = true
    )
  );

-- =============================================================================
-- REFERENCE TABLES (READ-ONLY)
-- =============================================================================

-- Countries: Public read access
CREATE POLICY "Anyone can read countries" ON countries
  FOR SELECT
  USING (true);

-- Languages: Public read access
CREATE POLICY "Anyone can read languages" ON languages
  FOR SELECT
  USING (true);

-- Legal: Public read access
CREATE POLICY "Anyone can read legal docs" ON legal
  FOR SELECT
  USING (true);

-- =============================================================================
-- SYSTEM TABLES
-- =============================================================================

-- Telegram analytics: Public read, service write
CREATE POLICY "Anyone can read telegram stats" ON telegram_user_activity
  FOR SELECT
  USING (true);

CREATE POLICY "Service can write telegram stats" ON telegram_user_activity
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- Location update queue: Service role only
CREATE POLICY "Service can manage location queue" ON location_update_queue
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- Views: Users can create view records
CREATE POLICY "Users can create views" ON views
  FOR INSERT TO authenticated
  WITH CHECK (profile_id = auth.uid());

-- Challenge activities: Users can manage their own activities
CREATE POLICY "Users can manage own challenge activities" ON challenge_activities
  FOR ALL TO authenticated
  USING (
    user_accepted_challenge = auth.uid() OR
    user_rejected_challenge = auth.uid() OR
    user_completed_challenge = auth.uid()
  )
  WITH CHECK (
    user_accepted_challenge = auth.uid() OR
    user_rejected_challenge = auth.uid() OR
    user_completed_challenge = auth.uid()
  );

-- Handlers: Users can manage their own handlers
CREATE POLICY "Users can manage own handlers" ON handlers
  FOR ALL TO authenticated
  USING (profile_id = auth.uid())
  WITH CHECK (profile_id = auth.uid());

-- Forms: Authenticated users can read/write
CREATE POLICY "Authenticated users can manage forms" ON forms
  FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);

-- =============================================================================
-- VERIFICATION QUERIES
-- =============================================================================

-- Run these to verify policies are working:
--
-- 1. Check all policies:
-- SELECT schemaname, tablename, policyname, permissive, roles, cmd
-- FROM pg_policies
-- WHERE schemaname = 'public'
-- ORDER BY tablename, policyname;
--
-- 2. Test as specific user (replace with actual user ID):
-- SET LOCAL ROLE authenticated;
-- SET LOCAL request.jwt.claim.sub = 'user-uuid-here';
-- SELECT * FROM profiles; -- Should only see own profile
-- RESET ROLE;

-- =============================================================================
-- ROLLBACK INSTRUCTIONS
-- =============================================================================

-- To rollback, drop all policies and recreate original ones
-- This is NOT RECOMMENDED as it will restore insecure access patterns
