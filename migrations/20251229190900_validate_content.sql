-- ============================================================================
-- Content Validation RPC
-- Consolidates spam/profanity detection from Edge Functions to PostgreSQL
-- ============================================================================

-- Drop existing function if exists
DROP FUNCTION IF EXISTS public.validate_content(text, text);

/**
 * validate_content - Server-side content moderation
 *
 * Checks text for spam patterns, profanity, and suspicious content.
 * Returns validation result with error codes for client handling.
 *
 * @param p_text - The text content to validate
 * @param p_content_type - Type of content: 'title', 'description', 'comment', 'message'
 * @returns TABLE with is_valid, error_code, error_message, and details
 *
 * Usage:
 *   SELECT * FROM validate_content('Check out my crypto offer!!!', 'title');
 *   -- Returns: (false, 'SPAM_CRYPTO', 'Contains cryptocurrency-related content', ...)
 */
CREATE OR REPLACE FUNCTION public.validate_content(
  p_text text,
  p_content_type text DEFAULT 'listing'
)
RETURNS TABLE(
  is_valid boolean,
  error_code text,
  error_message text,
  details jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lower_text text;
  v_letters_only text;
  v_upper_count int;
  v_letter_count int;
  v_upper_ratio numeric;
BEGIN
  -- Handle null or empty text
  IF p_text IS NULL OR trim(p_text) = '' THEN
    RETURN QUERY SELECT
      true::boolean,
      NULL::text,
      NULL::text,
      NULL::jsonb;
    RETURN;
  END IF;

  v_lower_text := lower(p_text);

  -- =========================================================================
  -- 1. Spam Pattern Detection
  -- =========================================================================

  -- Multiple URLs (spam indicator)
  IF (SELECT count(*) FROM regexp_matches(p_text, 'https?://[^\s]+', 'gi')) >= 2 THEN
    RETURN QUERY SELECT
      false::boolean,
      'SPAM_MULTIPLE_URLS'::text,
      'Contains multiple URLs which is not allowed'::text,
      jsonb_build_object('pattern', 'multiple_urls', 'content_type', p_content_type);
    RETURN;
  END IF;

  -- External links (not supabase.co)
  IF p_text ~* 'https?://(?!.*supabase\.co)' THEN
    RETURN QUERY SELECT
      false::boolean,
      'SPAM_EXTERNAL_LINK'::text,
      'External links are not allowed'::text,
      jsonb_build_object('pattern', 'external_link', 'content_type', p_content_type);
    RETURN;
  END IF;

  -- Cryptocurrency spam
  IF v_lower_text ~* '\m(crypto|bitcoin|ethereum|nft|airdrop|blockchain|defi)\M' THEN
    RETURN QUERY SELECT
      false::boolean,
      'SPAM_CRYPTO'::text,
      'Cryptocurrency-related content is not allowed'::text,
      jsonb_build_object('pattern', 'crypto', 'content_type', p_content_type);
    RETURN;
  END IF;

  -- Common spam phrases
  IF v_lower_text ~* '\m(click here|limited time|act now|free money|earn \$|make \$\d+|get rich|work from home)\M' THEN
    RETURN QUERY SELECT
      false::boolean,
      'SPAM_PHRASE'::text,
      'Contains spam-like phrases'::text,
      jsonb_build_object('pattern', 'spam_phrase', 'content_type', p_content_type);
    RETURN;
  END IF;

  -- Excessive punctuation (!!!, ???, etc.)
  IF p_text ~ '[!?]{3,}' THEN
    RETURN QUERY SELECT
      false::boolean,
      'SPAM_PUNCTUATION'::text,
      'Excessive punctuation is not allowed'::text,
      jsonb_build_object('pattern', 'excessive_punctuation', 'content_type', p_content_type);
    RETURN;
  END IF;

  -- Multiple phone numbers (often spam)
  IF (SELECT count(*) FROM regexp_matches(p_text, '\d{3}[-.]?\d{3}[-.]?\d{4}', 'g')) >= 2 THEN
    RETURN QUERY SELECT
      false::boolean,
      'SPAM_PHONE_NUMBERS'::text,
      'Multiple phone numbers detected'::text,
      jsonb_build_object('pattern', 'multiple_phones', 'content_type', p_content_type);
    RETURN;
  END IF;

  -- =========================================================================
  -- 2. ALL CAPS Detection (more than 50% uppercase = spam indicator)
  -- =========================================================================

  v_letters_only := regexp_replace(p_text, '[^a-zA-Z]', '', 'g');
  v_letter_count := length(v_letters_only);

  IF v_letter_count > 10 THEN
    v_upper_count := length(regexp_replace(p_text, '[^A-Z]', '', 'g'));
    v_upper_ratio := v_upper_count::numeric / v_letter_count::numeric;

    IF v_upper_ratio > 0.5 THEN
      RETURN QUERY SELECT
        false::boolean,
        'SPAM_ALL_CAPS'::text,
        'Excessive capitalization is not allowed'::text,
        jsonb_build_object('pattern', 'all_caps', 'upper_ratio', round(v_upper_ratio, 2), 'content_type', p_content_type);
      RETURN;
    END IF;
  END IF;

  -- =========================================================================
  -- 3. Profanity Detection
  -- =========================================================================

  -- Basic profanity patterns (extend as needed)
  IF v_lower_text ~* '\m(spam|scam|fake|fraud)\M' THEN
    RETURN QUERY SELECT
      false::boolean,
      'PROFANITY_DETECTED'::text,
      'Contains inappropriate content'::text,
      jsonb_build_object('pattern', 'profanity', 'content_type', p_content_type);
    RETURN;
  END IF;

  -- =========================================================================
  -- 4. Content Type Specific Validations
  -- =========================================================================

  -- Title-specific checks
  IF p_content_type = 'title' THEN
    -- Title too short
    IF length(trim(p_text)) < 3 THEN
      RETURN QUERY SELECT
        false::boolean,
        'TITLE_TOO_SHORT'::text,
        'Title must be at least 3 characters'::text,
        jsonb_build_object('min_length', 3, 'actual_length', length(trim(p_text)));
      RETURN;
    END IF;

    -- Title too long
    IF length(p_text) > 100 THEN
      RETURN QUERY SELECT
        false::boolean,
        'TITLE_TOO_LONG'::text,
        'Title must be 100 characters or less'::text,
        jsonb_build_object('max_length', 100, 'actual_length', length(p_text));
      RETURN;
    END IF;
  END IF;

  -- Description-specific checks
  IF p_content_type = 'description' THEN
    -- Description too long
    IF length(p_text) > 2000 THEN
      RETURN QUERY SELECT
        false::boolean,
        'DESCRIPTION_TOO_LONG'::text,
        'Description must be 2000 characters or less'::text,
        jsonb_build_object('max_length', 2000, 'actual_length', length(p_text));
      RETURN;
    END IF;
  END IF;

  -- =========================================================================
  -- 5. All checks passed - content is valid
  -- =========================================================================

  RETURN QUERY SELECT
    true::boolean,
    NULL::text,
    NULL::text,
    jsonb_build_object('content_type', p_content_type, 'length', length(p_text));
  RETURN;

END;
$$;

-- Grant execute permission to authenticated users and service role
GRANT EXECUTE ON FUNCTION public.validate_content(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.validate_content(text, text) TO service_role;

-- Add comment
COMMENT ON FUNCTION public.validate_content IS 'Server-side content moderation - checks for spam, profanity, and content policy violations';

-- ============================================================================
-- Convenience wrapper for validating multiple fields at once
-- ============================================================================

DROP FUNCTION IF EXISTS public.validate_listing_content(text, text);

/**
 * validate_listing_content - Validates both title and description in one call
 *
 * @param p_title - Listing title
 * @param p_description - Listing description (optional)
 * @returns JSONB with validation results for both fields
 *
 * Usage:
 *   SELECT validate_listing_content('Fresh Apples', 'Organic apples from my garden');
 *   -- Returns: {"valid": true, "errors": []}
 */
CREATE OR REPLACE FUNCTION public.validate_listing_content(
  p_title text,
  p_description text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_errors jsonb := '[]'::jsonb;
  v_title_result record;
  v_desc_result record;
BEGIN
  -- Validate title
  SELECT * INTO v_title_result FROM validate_content(p_title, 'title');

  IF NOT v_title_result.is_valid THEN
    v_errors := v_errors || jsonb_build_array(jsonb_build_object(
      'field', 'title',
      'code', v_title_result.error_code,
      'message', v_title_result.error_message
    ));
  END IF;

  -- Validate description if provided
  IF p_description IS NOT NULL AND trim(p_description) != '' THEN
    SELECT * INTO v_desc_result FROM validate_content(p_description, 'description');

    IF NOT v_desc_result.is_valid THEN
      v_errors := v_errors || jsonb_build_array(jsonb_build_object(
        'field', 'description',
        'code', v_desc_result.error_code,
        'message', v_desc_result.error_message
      ));
    END IF;
  END IF;

  -- Return result
  RETURN jsonb_build_object(
    'valid', jsonb_array_length(v_errors) = 0,
    'errors', v_errors
  );
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION public.validate_listing_content(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.validate_listing_content(text, text) TO service_role;

COMMENT ON FUNCTION public.validate_listing_content IS 'Convenience wrapper to validate listing title and description in one call';
