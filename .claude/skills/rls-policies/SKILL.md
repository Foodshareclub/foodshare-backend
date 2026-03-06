---
name: rls-policies
description: Row Level Security patterns for Foodshare backend. Use when creating or reviewing RLS policies, debugging access issues, or understanding security boundaries. Covers policy patterns, service role bypass, and testing.
---

<objective>
Ensure every table has correct RLS policies that enforce user data isolation while allowing necessary cross-user reads and admin operations.
</objective>

<essential_principles>
## Core Rules

1. **RLS on ALL tables** - No exceptions. Every table must have `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`
2. **Service role bypasses RLS** - Used only for admin operations in Edge Functions
3. **`auth.uid()`** - Returns the authenticated user's UUID from the JWT
4. **Deny by default** - If no policy matches, access is denied
5. **Soft deletes** - Policies should filter `deleted_at IS NULL` for reads

## Common Policy Patterns

### User owns their data
```sql
-- CRUD on own records
CREATE POLICY "Users manage own {resource}"
    ON public.{table} FOR ALL
    USING (auth.uid() = user_id);
```

### Public read, owner write
```sql
-- Anyone can read active records
CREATE POLICY "Public can read {resource}"
    ON public.{table} FOR SELECT
    USING (deleted_at IS NULL);

-- Only owner can modify
CREATE POLICY "Owner can modify {resource}"
    ON public.{table} FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "Owner can delete {resource}"
    ON public.{table} FOR DELETE
    USING (auth.uid() = user_id);
```

### Role-based access
```sql
-- Admin access via profiles.role
CREATE POLICY "Admins can manage {resource}"
    ON public.{table} FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role = 'admin'
        )
    );
```

### Relationship-based access
```sql
-- Chat participants can read messages
CREATE POLICY "Participants can read messages"
    ON public.messages FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.room_participants
            WHERE room_id = messages.room_id AND user_id = auth.uid()
        )
    );
```

## Service Role Usage

In Edge Functions, use service role client for admin operations:
```typescript
import { createClient } from "@supabase/supabase-js";

const adminClient = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
// This bypasses ALL RLS policies
```

**NEVER use service role in:**
- Client-side code (iOS, Android, Web)
- Edge Functions that handle user-facing requests without explicit admin checks
- Any code that could be reached by unauthenticated users

## Testing Policies

```sql
-- Test as a specific user
SET request.jwt.claims = '{"sub": "user-uuid-here", "role": "authenticated"}';
SET role = 'authenticated';

-- Try query
SELECT * FROM public.food_listings WHERE user_id = 'user-uuid-here';

-- Verify denied
SELECT * FROM public.food_listings WHERE user_id = 'other-user-uuid';
-- Should return empty

-- Reset
RESET role;
RESET request.jwt.claims;
```

## Debugging Access Issues

```sql
-- List all policies for a table
SELECT * FROM pg_policies WHERE tablename = '{table}';

-- Check if RLS is enabled
SELECT relname, relrowsecurity FROM pg_class WHERE relname = '{table}';

-- Check current user
SELECT auth.uid(), auth.role();
```
</essential_principles>

<success_criteria>
RLS is correct when:
- [ ] Every table has RLS enabled
- [ ] Policies cover SELECT, INSERT, UPDATE, DELETE as needed
- [ ] `auth.uid()` used for user isolation
- [ ] Soft deletes filtered in SELECT policies
- [ ] Service role used only for admin operations
- [ ] Policies tested with different user contexts
</success_criteria>
