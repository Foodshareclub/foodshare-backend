---
name: database-migration
description: PostgreSQL migration workflow for Foodshare backend. Use when creating tables, adding columns, creating indexes, or modifying RLS policies. Covers CREATE INDEX CONCURRENTLY, RLS, testing, and deployment.
disable-model-invocation: true
---

<objective>
Create safe, production-ready PostgreSQL migrations with proper RLS policies, concurrent indexes, and tested deployment workflows.
</objective>

<essential_principles>
## Critical Rules

1. **CREATE INDEX CONCURRENTLY** - Always. Never block production queries with regular CREATE INDEX
2. **RLS on ALL tables** - No exceptions. Every new table must have RLS enabled and policies defined
3. **Changes affect ALL platforms** - Web, iOS, and Android all share this database
4. **Wrap in transactions** - Use BEGIN/COMMIT for multi-statement migrations
5. **Soft deletes** - Use `deleted_at TIMESTAMPTZ` column (not hard deletes) for posts, profiles, forum, challenges, rooms, comments

## Migration File Naming

```
supabase/migrations/YYYYMMDDHHMMSS_description.sql
```

Example: `20260210120000_add_favorites_table.sql`

## Migration Template

```sql
-- supabase/migrations/YYYYMMDDHHMMSS_add_{feature}.sql
BEGIN;

-- Create table
CREATE TABLE IF NOT EXISTS public.{table_name} (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    -- feature columns
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ  -- soft delete
);

-- Indexes (CONCURRENTLY requires separate transaction, so use IF NOT EXISTS)
CREATE INDEX IF NOT EXISTS idx_{table}_user_id ON public.{table_name}(user_id);
CREATE INDEX IF NOT EXISTS idx_{table}_created_at ON public.{table_name}(created_at DESC);

-- Enable RLS
ALTER TABLE public.{table_name} ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can read own {feature}"
    ON public.{table_name} FOR SELECT
    USING (auth.uid() = user_id AND deleted_at IS NULL);

CREATE POLICY "Users can create own {feature}"
    ON public.{table_name} FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own {feature}"
    ON public.{table_name} FOR UPDATE
    USING (auth.uid() = user_id AND deleted_at IS NULL);

CREATE POLICY "Users can soft-delete own {feature}"
    ON public.{table_name} FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (deleted_at IS NOT NULL);

-- Updated_at trigger
CREATE TRIGGER set_{table}_updated_at
    BEFORE UPDATE ON public.{table_name}
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMIT;
```

## Deployment

```bash
# Local: Push migration
cd supabase && npx supabase db push

# Production: SSH and apply
ssh organic@vps.foodshare.club
cd /home/organic/dev/foodshare-backend
git pull
docker exec supabase-db psql -U postgres -f /path/to/migration.sql
```

## Verification

```bash
# Check migration applied
docker exec supabase-db psql -U postgres -c "\dt public.{table_name}"

# Check RLS enabled
docker exec supabase-db psql -U postgres -c "SELECT relname, relrowsecurity FROM pg_class WHERE relname = '{table_name}';"

# Check policies
docker exec supabase-db psql -U postgres -c "SELECT * FROM pg_policies WHERE tablename = '{table_name}';"
```
</essential_principles>

<success_criteria>
Migration is correct when:
- [ ] File follows YYYYMMDDHHMMSS naming convention
- [ ] Indexes created with CONCURRENTLY or IF NOT EXISTS
- [ ] RLS enabled on new tables
- [ ] Appropriate RLS policies created
- [ ] Soft delete column included where applicable
- [ ] Wrapped in transaction
- [ ] Tested locally before production deployment
</success_criteria>
