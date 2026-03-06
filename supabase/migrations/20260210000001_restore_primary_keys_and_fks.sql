-- Restore primary keys and foreign keys lost during PG 15→17 migration
-- The pg_dumpall + selective pg_restore strategy did not preserve all constraints

-- Primary keys (profiles and posts lost their PKs)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.profiles'::regclass AND contype = 'p') THEN
    ALTER TABLE public.profiles ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.posts'::regclass AND contype = 'p') THEN
    ALTER TABLE public.posts ADD CONSTRAINT posts_pkey PRIMARY KEY (id);
  END IF;
END $$;

-- Foreign keys referenced by PostgREST queries in web app
-- Using IF NOT EXISTS pattern to be idempotent

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forum_profile_id_profiles_fkey') THEN
    ALTER TABLE public.forum ADD CONSTRAINT forum_profile_id_profiles_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'comments_user_id_profiles_fkey') THEN
    ALTER TABLE public.comments ADD CONSTRAINT comments_user_id_profiles_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'post_reports_reporter_id_fkey') THEN
    ALTER TABLE public.reports ADD CONSTRAINT post_reports_reporter_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rooms_requester_fkey') THEN
    ALTER TABLE public.rooms ADD CONSTRAINT rooms_requester_fkey FOREIGN KEY (requester) REFERENCES public.profiles(id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rooms_sharer_fkey') THEN
    ALTER TABLE public.rooms ADD CONSTRAINT rooms_sharer_fkey FOREIGN KEY (sharer) REFERENCES public.profiles(id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'posts_profile_id_profiles_fkey') THEN
    ALTER TABLE public.posts ADD CONSTRAINT posts_profile_id_profiles_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id);
  END IF;
END $$;
