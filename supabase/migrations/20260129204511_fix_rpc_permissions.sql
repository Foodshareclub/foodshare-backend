-- Fix RPC function permissions for engagement functions
-- Grant execute permissions to authenticated and anon users

-- Grant permissions for toggle_like
GRANT EXECUTE ON FUNCTION toggle_like(INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION toggle_like(INTEGER) TO anon;

-- Grant permissions for toggle_bookmark  
GRANT EXECUTE ON FUNCTION toggle_bookmark(INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION toggle_bookmark(INTEGER) TO anon;

-- Grant permissions for get_batch_engagement_status
GRANT EXECUTE ON FUNCTION get_batch_engagement_status(INTEGER[]) TO authenticated;
GRANT EXECUTE ON FUNCTION get_batch_engagement_status(INTEGER[]) TO anon;

-- Grant permissions for get_user_bookmarks
GRANT EXECUTE ON FUNCTION get_user_bookmarks(INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION get_user_bookmarks(INTEGER) TO anon;