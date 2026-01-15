-- Add LLM translation secrets to Supabase Vault
-- Run this manually after migration is applied

-- LLM Translation Endpoint (dedicated translation service)
SELECT vault.create_secret(
  'https://ollama.foodshare.club/api/translate',
  'LLM_TRANSLATION_ENDPOINT',
  'Self-hosted translation service endpoint'
);

-- LLM Translation API Key
SELECT vault.create_secret(
  'a0561ed547369f3d094f66d1bf5ce5974bf13cae4e6c481feabff1033b521b9b',
  'LLM_TRANSLATION_API_KEY',
  'API key for translation service'
);

COMMENT ON SCHEMA vault IS 'Supabase Vault stores LLM_TRANSLATION_ENDPOINT and LLM_TRANSLATION_API_KEY';
