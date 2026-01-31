-- Check if engagement RPC functions exist
SELECT 
    proname as function_name,
    pg_get_function_identity_arguments(oid) as arguments,
    prosecdef as security_definer
FROM pg_proc 
WHERE proname IN ('toggle_like', 'toggle_bookmark', 'get_batch_engagement_status', 'get_user_bookmarks')
ORDER BY proname;
