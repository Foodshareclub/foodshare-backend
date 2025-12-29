-- Add RPC function to fetch individual secrets from Vault
-- This enables iOS app to securely fetch credentials for service initialization
-- Used by: UpstashRedisClientImpl.fromVault()

-- Create function to get a single secret by name
CREATE OR REPLACE FUNCTION get_secret(secret_name text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  secret_value text;
BEGIN
  -- Fetch the decrypted secret from vault
  SELECT decrypted_secret INTO secret_value
  FROM vault.decrypted_secrets
  WHERE name = secret_name;
  
  -- Return the secret value (or NULL if not found)
  RETURN secret_value;
END;
$$;

-- Add comment explaining the function
COMMENT ON FUNCTION get_secret(text) IS 
'Fetches a single decrypted secret from Supabase Vault by name. 
Used for secure credential retrieval in iOS app for service initialization.
Example: SELECT get_secret(''UPSTASH_REDIS_URL'')';

-- Grant execute permission to authenticated users
-- Note: This is safe because vault.decrypted_secrets already has RLS
GRANT EXECUTE ON FUNCTION get_secret(text) TO authenticated;

-- Revoke from anon users for extra security
REVOKE EXECUTE ON FUNCTION get_secret(text) FROM anon;
