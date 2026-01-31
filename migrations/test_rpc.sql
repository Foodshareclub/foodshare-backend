-- Test if RPC functions exist and work
SELECT 'Testing toggle_like function...' as test;

-- This should return an error about authentication, not "function does not exist"
SELECT toggle_like(999999);
