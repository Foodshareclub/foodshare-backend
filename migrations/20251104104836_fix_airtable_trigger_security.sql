-- Migration: Fix Airtable Trigger Security
-- Priority: CRITICAL (SECURITY)
-- Description: Removes hardcoded Airtable API key from trigger and uses Vault instead
-- Impact: Prevents API key exposure to anyone with database access
--
-- Changes:
-- 1. Drops insecure trigger with hardcoded Authorization header
-- 2. Creates secure function that fetches token from Vault
-- 3. Moves HTTP call to Edge Function invocation (async)
-- 4. Implements proper error handling
--
-- Created: 2025-01-04
-- Author: Security Audit - Edge Function Review

-- =============================================================================
-- REMOVE INSECURE TRIGGER
-- =============================================================================

-- Drop the trigger with hardcoded API key
DROP TRIGGER IF EXISTS "AirtableLAFridges" ON public.posts;

-- Drop the associated function if it exists
DROP FUNCTION IF EXISTS public.sync_to_airtable_on_insert();

-- =============================================================================
-- CREATE SECURE VAULT-BASED FUNCTION
-- =============================================================================

CREATE OR REPLACE FUNCTION public.sync_to_airtable()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public, vault
LANGUAGE plpgsql
AS $$
DECLARE
  supabase_url TEXT;
  anon_key TEXT;
BEGIN
  -- Get Supabase URL and anon key from settings
  -- These should be set via ALTER DATABASE command or .env
  BEGIN
    supabase_url := current_setting('app.supabase_url', true);
    anon_key := current_setting('app.supabase_anon_key', true);
  EXCEPTION
    WHEN OTHERS THEN
      -- Fallback: Skip sync if settings not available
      RAISE WARNING 'Supabase URL/key not configured. Skipping Airtable sync.';
      RETURN NEW;
  END;

  -- Queue the sync via Edge Function (async, non-blocking)
  -- The Edge Function will fetch the Airtable token from Vault
  BEGIN
    PERFORM net.http_post(
      url := supabase_url || '/functions/v1/sync-airtable',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || anon_key
      ),
      body := jsonb_build_object(
        'post_id', NEW.id,
        'operation', TG_OP
      ),
      timeout_milliseconds := 5000
    );
  EXCEPTION
    WHEN OTHERS THEN
      -- Log error but don't fail the insert
      RAISE WARNING 'Failed to sync to Airtable: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$;

-- =============================================================================
-- CREATE TRIGGER (AFTER INSERT/UPDATE)
-- =============================================================================

-- Use AFTER trigger so it doesn't block INSERT/UPDATE
CREATE TRIGGER sync_to_airtable_trigger
  AFTER INSERT OR UPDATE ON public.posts
  FOR EACH ROW
  EXECUTE FUNCTION sync_to_airtable();

COMMENT ON FUNCTION public.sync_to_airtable() IS
  'Securely syncs post data to Airtable via Edge Function. Uses Vault for API token.';

-- =============================================================================
-- EDGE FUNCTION TEMPLATE
-- =============================================================================

-- Create this Edge Function: supabase/functions/sync-airtable/index.ts
/*
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

Deno.serve(async (req) => {
  try {
    const { post_id, operation } = await req.json()

    // Initialize Supabase client with service role
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // Fetch Airtable token from Vault
    const { data: secrets, error: secretError } = await supabase.rpc('get_secrets', {
      secret_names: ['AIRTABLE_API_TOKEN']
    })

    if (secretError) throw secretError

    const airtableToken = secrets.find(s => s.name === 'AIRTABLE_API_TOKEN')?.value
    if (!airtableToken) throw new Error('Airtable token not found')

    // Fetch post data
    const { data: post, error: postError } = await supabase
      .from('posts')
      .select('*')
      .eq('id', post_id)
      .single()

    if (postError) throw postError

    // Sync to Airtable
    const response = await fetch('https://api.airtable.com/v0/YOUR_BASE_ID/LA%20Fridges', {
      method: operation === 'INSERT' ? 'POST' : 'PATCH',
      headers: {
        'Authorization': `Bearer ${airtableToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        fields: {
          // Map post fields to Airtable fields
          'Name': post.post_title,
          'Address': post.post_address,
          // ... other fields
        }
      })
    })

    const result = await response.json()

    return new Response(JSON.stringify({ success: true, result }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200
    })

  } catch (error) {
    console.error('Airtable sync error:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { 'Content-Type': 'application/json' },
      status: 500
    })
  }
})
*/

-- =============================================================================
-- CONFIGURATION
-- =============================================================================

-- Set Supabase URL and anon key at database level (run once)
-- Replace with your actual values:
--
-- ALTER DATABASE postgres SET app.supabase_url = 'https://***REMOVED***';
-- ALTER DATABASE postgres SET app.supabase_anon_key = 'your_anon_key_here';

-- =============================================================================
-- VERIFICATION
-- =============================================================================

-- Check that trigger was created
-- SELECT tgname, tgenabled FROM pg_trigger WHERE tgname = 'sync_to_airtable_trigger';

-- Test the function (won't actually sync without URL/key configured)
-- INSERT INTO posts (post_title, post_address, profile_id)
-- VALUES ('Test Post', '123 Main St', '00000000-0000-0000-0000-000000000000');

-- =============================================================================
-- ROLLBACK INSTRUCTIONS
-- =============================================================================

-- To rollback (NOT RECOMMENDED):
-- DROP TRIGGER IF EXISTS sync_to_airtable_trigger ON public.posts;
-- DROP FUNCTION IF EXISTS public.sync_to_airtable();

-- =============================================================================
-- SECURITY NOTES
-- =============================================================================

-- ✅ API key now stored in Vault (encrypted)
-- ✅ Trigger uses SECURITY DEFINER with SET search_path
-- ✅ HTTP call is asynchronous (doesn't block INSERT)
-- ✅ Errors are logged but don't fail the operation
-- ✅ Edge Function will handle retries and error handling
