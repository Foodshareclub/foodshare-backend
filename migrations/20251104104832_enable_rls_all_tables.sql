-- Migration: Enable RLS on All Tables
-- Priority: CRITICAL
-- Description: Enables Row Level Security on all 23 tables to protect data from unauthorized access
-- Impact: This is a BREAKING CHANGE - API clients will need proper authentication
--
-- BEFORE applying this migration:
-- 1. Ensure all RLS policies are in place (next migration)
-- 2. Test with your iOS app to ensure authenticated requests work
-- 3. Verify service accounts have proper permissions
--
-- Created: 2025-01-04
-- Author: Database Security Audit

-- =============================================================================
-- USER DATA TABLES (CRITICAL)
-- =============================================================================

-- User profiles and authentication
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE profiles IS 'RLS enabled: Users can read all profiles, update only their own';

-- User addresses with geolocation
ALTER TABLE address ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE address IS 'RLS enabled: Users can only access their own address data';

-- Admin users
ALTER TABLE admin ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE admin IS 'RLS enabled: Only admins can access this table';

-- =============================================================================
-- CONTENT TABLES
-- =============================================================================

-- Food sharing posts
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE posts IS 'RLS enabled: All can read active posts, only owners can modify';

-- Forum posts
ALTER TABLE forum ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE forum IS 'RLS enabled: All can read published forums, only owners can modify';

-- Challenges
ALTER TABLE challenges ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE challenges IS 'RLS enabled: All can read published challenges, only owners can modify';

-- =============================================================================
-- SOCIAL INTERACTION TABLES
-- =============================================================================

-- Likes on posts/forums/challenges
ALTER TABLE likes ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE likes IS 'RLS enabled: All can read likes, only owners can create/delete';

-- Reviews/ratings
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE reviews IS 'RLS enabled: All can read reviews, only owners can modify';

-- Comments on forum posts
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE comments IS 'RLS enabled: All can read comments, only owners can modify';

-- View tracking
ALTER TABLE views ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE views IS 'RLS enabled: Users can only create view records';

-- Challenge activities
ALTER TABLE challenge_activities ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE challenge_activities IS 'RLS enabled: Users can only access their own challenge activities';

-- =============================================================================
-- MESSAGING TABLES (HIGHLY SENSITIVE)
-- =============================================================================

-- Chat rooms
ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE rooms IS 'RLS enabled: Only participants can access room data';

-- Chat messages
ALTER TABLE room_participants ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE room_participants IS 'RLS enabled: Only room participants can read/write messages';

-- =============================================================================
-- NOTIFICATION & FEEDBACK TABLES
-- =============================================================================

-- Push notifications
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE notifications IS 'RLS enabled: Users can only access their own notifications';

-- User reports
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE reports IS 'RLS enabled: Users can create reports, only admins can read';

-- Feedback submissions
ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE feedback IS 'RLS enabled: Users can create feedback, only admins can read';

-- Miscellaneous handlers
ALTER TABLE handlers ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE handlers IS 'RLS enabled: Users can only access their own handlers';

-- =============================================================================
-- SYSTEM/ANALYTICS TABLES
-- =============================================================================

-- Telegram community analytics
ALTER TABLE telegram_user_activity ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE telegram_user_activity IS 'RLS enabled: Public read, service role write';

-- Background job queue for location updates
ALTER TABLE location_update_queue ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE location_update_queue IS 'RLS enabled: Service role only access';

-- Suggestion forms
ALTER TABLE forms ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE forms IS 'RLS enabled: Authenticated users can read/write';

-- =============================================================================
-- REFERENCE DATA TABLES (READ-ONLY)
-- =============================================================================

-- Countries reference data
ALTER TABLE countries ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE countries IS 'RLS enabled: Public read access, no write access';

-- Languages reference data
ALTER TABLE languages ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE languages IS 'RLS enabled: Public read access, no write access';

-- Legal documents
ALTER TABLE legal ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE legal IS 'RLS enabled: Public read access, admin write access';

-- =============================================================================
-- VERIFICATION QUERY
-- =============================================================================

-- Run this to verify RLS is enabled on all tables:
-- SELECT
--   schemaname,
--   tablename,
--   rowsecurity as rls_enabled
-- FROM pg_tables
-- WHERE schemaname = 'public'
-- ORDER BY tablename;

-- =============================================================================
-- ROLLBACK INSTRUCTIONS
-- =============================================================================

-- If you need to rollback (NOT RECOMMENDED - security risk):
--
-- ALTER TABLE profiles DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE address DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE posts DISABLE ROW LEVEL SECURITY;
-- -- (repeat for all tables)
--
-- WARNING: Disabling RLS exposes all data to public API access!
