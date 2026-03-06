-- ============================================================================
-- Fix missing RLS policies on self-hosted
-- 4 tables lost RLS + policies during CLI→docker migration
-- 6 additional policies missing from other tables
-- ============================================================================

-- address
CREATE POLICY "Enable read access for all users" ON public.address FOR SELECT USING (true);
ALTER TABLE public.address ENABLE ROW LEVEL SECURITY;

-- community_fridges
CREATE POLICY "Community fridges are viewable by everyone" ON public.community_fridges FOR SELECT USING (true);
ALTER TABLE public.community_fridges ENABLE ROW LEVEL SECURITY;

-- posts (critical — 4 policies)
CREATE POLICY posts_delete_policy ON public.posts FOR DELETE TO authenticated USING ((profile_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY posts_insert_policy ON public.posts FOR INSERT TO authenticated WITH CHECK ((profile_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY posts_select_policy ON public.posts FOR SELECT TO authenticated, anon USING (((is_active = true) OR (profile_id = ( SELECT auth.uid() AS uid))));
CREATE POLICY posts_update_policy ON public.posts FOR UPDATE TO authenticated USING ((profile_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((profile_id = ( SELECT auth.uid() AS uid)));
ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;

-- profiles (critical — 4 policies)
CREATE POLICY "Allow public read access to profiles" ON public.profiles FOR SELECT USING (true);
CREATE POLICY "Allow users to delete their own profiles" ON public.profiles FOR DELETE USING ((id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Allow users to insert their own profiles" ON public.profiles FOR INSERT WITH CHECK ((id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Allow users to update their own profiles" ON public.profiles FOR UPDATE USING ((id = ( SELECT auth.uid() AS uid)));
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- user_events partitions
ALTER TABLE public.user_events_2025_12 ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_events_2025_12_insert ON public.user_events_2025_12 FOR INSERT WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY user_events_2025_12_select ON public.user_events_2025_12 FOR SELECT USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Service role full access" ON public.user_events_2025_12 TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.user_events_2026_01 ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_events_2026_01_insert ON public.user_events_2026_01 FOR INSERT WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY user_events_2026_01_select ON public.user_events_2026_01 FOR SELECT USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Service role full access" ON public.user_events_2026_01 TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.user_events_2026_02 ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_events_2026_02_insert ON public.user_events_2026_02 FOR INSERT WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY user_events_2026_02_select ON public.user_events_2026_02 FOR SELECT USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Service role full access" ON public.user_events_2026_02 TO service_role USING (true) WITH CHECK (true);

-- email_provider_quota
CREATE POLICY "Admins can read quota data" ON public.email_provider_quota FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid)))));

-- email_queue
CREATE POLICY "Admins can view email queue" ON public.email_queue FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid)))));

-- forum_reports
CREATE POLICY "Moderators can update reports" ON public.forum_reports FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid)))));
CREATE POLICY "Users can view own reports or moderators all" ON public.forum_reports FOR SELECT USING (((reporter_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM public.profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))))));

-- post_activity_logs
CREATE POLICY post_activity_logs_select ON public.post_activity_logs FOR SELECT USING (((actor_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.posts p
  WHERE ((p.id = post_activity_logs.post_id) AND (p.profile_id = auth.uid())))) OR public.is_admin() OR (( SELECT (auth.jwt() ->> 'role'::text)) = 'service_role'::text)));

-- post_views
CREATE POLICY post_views_owner_access ON public.post_views FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.posts p
  WHERE ((p.id = post_views.post_id) AND (p.profile_id = ( SELECT auth.uid() AS uid))))));
