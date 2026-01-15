-- Add LLM translation secrets to Supabase Vault
-- Run this manually after migration is applied

-- Dedicated Translation Service Endpoint
SELECT vault.create_secret(
  'https://ollama.foodshare.club/api/translate',
  'LLM_TRANSLATION_ENDPOINT',
  'Dedicated translation service endpoint'
);

-- Translation Service API Key
SELECT vault.create_secret(
  'a0561ed547369f3d094f66d1bf5ce5974bf13cae4e6c481feabff1033b521b9b',
  'LLM_TRANSLATION_API_KEY',
  'API key for translation service'
);

-- Cloudflare Access Client ID
SELECT vault.create_secret(
  '546b88a3efd36b53f35cd8508ba25560.access',
  'CF_ACCESS_CLIENT_ID',
  'Cloudflare Access client ID'
);

-- Cloudflare Access Client Secret
SELECT vault.create_secret(
  'e483bb03a4d8916403693ed072a73b22343b901f11e79f383996fbe2dbe0192e',
  'CF_ACCESS_CLIENT_SECRET',
  'Cloudflare Access client secret'
);

COMMENT ON SCHEMA vault IS 'Supabase Vault stores translation service credentials and Cloudflare Access tokens';

-- IMPORTANT: Requires Cloudflare Tunnel route #5 to be activated:
-- - Subdomain: ollama
-- - Domain: foodshare.club
-- - Path: /api/translate
-- - Service: http://translate-service:8080
