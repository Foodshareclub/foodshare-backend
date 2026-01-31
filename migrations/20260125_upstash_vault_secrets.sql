-- ============================================================================
-- Upstash Secrets in Vault
-- Stores Upstash credentials for database-accessible secrets
-- ============================================================================

-- Insert or update Upstash secrets in vault
-- These are accessible via: SELECT * FROM vault.decrypted_secrets WHERE name = 'secret_name';

-- QStash secrets
INSERT INTO vault.secrets (name, secret, description)
VALUES
  ('qstash_url', 'https://qstash.upstash.io', 'Upstash QStash API URL'),
  ('qstash_token', 'eyJVc2VySUQiOiI3ZTgwNjNlMi05NmQ1LTQzNWYtYWM1Yi1lZTcwYzQ3YzAzZWQiLCJQYXNzd29yZCI6ImI2MDY1NzNmMzg0NjQ2NGVhNGEwNGI3NTRmMjQzNzk4In0=', 'Upstash QStash API Token'),
  ('qstash_current_signing_key', 'sig_7JhpcvrM18xXjGG1QbkrttUyVXRc', 'QStash current webhook signing key'),
  ('qstash_next_signing_key', 'sig_86wbVwkWB4Nd8JCsKWFaGDKCpCXo', 'QStash next webhook signing key (for rotation)')
ON CONFLICT (name) DO UPDATE SET
  secret = EXCLUDED.secret,
  description = EXCLUDED.description,
  updated_at = NOW();

-- Upstash Vector secrets
INSERT INTO vault.secrets (name, secret, description)
VALUES
  ('upstash_vector_rest_url', 'https://fluent-mollusk-23643-eu1-vector.upstash.io', 'Upstash Vector REST URL (foodshare-vector index)'),
  ('upstash_vector_rest_token', 'ABgFMGZsdWVudC1tb2xsdXNrLTIzNjQzLWV1MWFkbWluTTJaaFl6STNOV010WVdJMk9TMDBOVGxrTFdJMk5UY3RZekJoT0RWbE1HVTVaVFUx', 'Upstash Vector REST Token')
ON CONFLICT (name) DO UPDATE SET
  secret = EXCLUDED.secret,
  description = EXCLUDED.description,
  updated_at = NOW();

-- Upstash Search (Hybrid Vector) secrets
INSERT INTO vault.secrets (name, secret, description)
VALUES
  ('upstash_search_rest_url', 'https://large-beetle-72124-eu1-search.upstash.io', 'Upstash Search REST URL (foodshare-search hybrid index)'),
  ('upstash_search_rest_token', 'ABYFMGxhcmdlLWJlZXRsZS03MjEyNC1ldTFhZG1pbllUUTRPREppTVRVdE1HTmxOQzAwT1dVMkxUZ3dOVGN0WWpoaU0yTTRNVEUxWWpReQ==', 'Upstash Search REST Token')
ON CONFLICT (name) DO UPDATE SET
  secret = EXCLUDED.secret,
  description = EXCLUDED.description,
  updated_at = NOW();

-- Create helper function to retrieve secrets (if not exists)
CREATE OR REPLACE FUNCTION public.get_upstash_secret(secret_name text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  secret_value text;
BEGIN
  SELECT decrypted_secret INTO secret_value
  FROM vault.decrypted_secrets
  WHERE name = secret_name;

  RETURN secret_value;
END;
$$;

-- Grant execute to authenticated users (for Edge Functions via service role)
GRANT EXECUTE ON FUNCTION public.get_upstash_secret(text) TO service_role;

COMMENT ON FUNCTION public.get_upstash_secret IS 'Retrieves Upstash secrets from vault by name';
