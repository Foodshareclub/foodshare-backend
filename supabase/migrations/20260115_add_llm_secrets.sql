-- Add LLM translation secrets to Supabase Vault
-- Run this manually after migration is applied

-- LLM Translation Endpoint
SELECT vault.create_secret(
  'https://ollama.foodshare.club/v1/chat/completions',
  'LLM_TRANSLATION_ENDPOINT',
  'Self-hosted LLM translation endpoint (Ollama)'
);

-- LLM Model Name
SELECT vault.create_secret(
  'qwen2.5-coder:7b',
  'LLM_TRANSLATION_MODEL',
  'LLM model name for translation'
);

-- Note: No API key needed for Ollama
COMMENT ON SCHEMA vault IS 'Supabase Vault stores LLM_TRANSLATION_ENDPOINT and LLM_TRANSLATION_MODEL';
