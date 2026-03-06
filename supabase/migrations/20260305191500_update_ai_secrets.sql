-- Drop the deprecated get_openai_api_key function
-- The project now uses public.get_vault_secret('GROQ_API_KEY') or get_vault_secret('ZAI_API_KEY') instead
DROP FUNCTION IF EXISTS public.get_openai_api_key();
