-- Add LLM translation secrets to Supabase Vault
-- Run this manually after migration is applied

-- Production Translation Service Endpoint (LIVE ✅)
SELECT vault.create_secret(
  'https://translate.foodshare.club/api/translate',
  'LLM_TRANSLATION_ENDPOINT',
  'Production translation service endpoint'
);

-- Translation Service API Key
SELECT vault.create_secret(
  'a0561ed547369f3d094f66d1bf5ce5974bf13cae4e6c481feabff1033b521b9b',
  'LLM_TRANSLATION_API_KEY',
  'API key for translation service'
);

COMMENT ON SCHEMA vault IS 'Supabase Vault stores translation service credentials';

-- Production endpoint is live at: https://translate.foodshare.club/api/translate
-- Supported languages (21): en, es, fr, de, pt, cs, ru, uk, it, pl, nl, sv, zh, hi, ja, ko, vi, id, th, ar, tr
-- No Cloudflare Access required (public endpoint with API key auth)
