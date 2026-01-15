-- Add LLM translation secrets to Supabase Vault
-- Run this manually after migration is applied

-- Ollama Chat API Endpoint (working)
SELECT vault.create_secret(
  'https://ollama.foodshare.club/api/chat',
  'LLM_TRANSLATION_ENDPOINT',
  'Ollama chat API endpoint for translations'
);

-- Ollama Model Name
SELECT vault.create_secret(
  'qwen2.5-coder:7b',
  'LLM_MODEL',
  'Ollama model for translation'
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

COMMENT ON SCHEMA vault IS 'Supabase Vault stores Ollama credentials and Cloudflare Access tokens';

-- Note: To use dedicated translation service in the future:
-- 1. Activate Cloudflare Tunnel route #5 (ollama.foodshare.club/api/translate)
-- 2. Update LLM_TRANSLATION_ENDPOINT to https://ollama.foodshare.club/api/translate
-- 3. Add LLM_TRANSLATION_API_KEY secret with value: a0561ed547369f3d094f66d1bf5ce5974bf13cae4e6c481feabff1033b521b9b
