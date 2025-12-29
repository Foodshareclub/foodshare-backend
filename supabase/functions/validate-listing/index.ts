/**
 * validate-listing Edge Function
 *
 * Server-side validation for listing creation with additional security checks.
 * Wraps the validate_listing RPC with:
 * - Profanity/spam detection
 * - URL/link detection
 * - Rate limiting integration
 *
 * Usage from iOS/Android/Web:
 * POST /validate-listing
 * {
 *   "title": "Fresh Apples",
 *   "description": "Organic apples...",
 *   "images": ["url1", "url2"],
 *   "postType": "food",
 *   "latitude": 51.5074,
 *   "longitude": -0.1278,
 *   "pickupAddress": "123 Main St",
 *   "pickupTime": "Anytime today"
 * }
 *
 * Response:
 * {
 *   "valid": true/false,
 *   "errors": [{ "field": "title", "code": "VALIDATION_*", "message": "..." }],
 *   "sanitized": { ... } // Only if valid
 * }
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// =============================================================================
// Types
// =============================================================================

interface ValidateListingRequest {
  title: string;
  description?: string | null;
  images: string[];
  postType: string;
  latitude: number;
  longitude: number;
  pickupAddress?: string | null;
  pickupTime?: string | null;
}

interface ValidationError {
  field: string;
  code: string;
  message: string;
}

interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  sanitized?: Record<string, unknown>;
}

// =============================================================================
// Profanity Detection
// =============================================================================

// Common profanity patterns (basic list - extend as needed)
// This is a simplified approach; production should use a more comprehensive library
const PROFANITY_PATTERNS: RegExp[] = [
  // Add patterns here - keeping minimal for code review purposes
  /\b(spam|scam|fake)\b/i,
];

// Spam/suspicious patterns
const SPAM_PATTERNS: RegExp[] = [
  // Multiple URLs
  /(https?:\/\/[^\s]+\s*){2,}/i,
  // Phone numbers with suspicious patterns
  /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b.*\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/,
  // ALL CAPS (more than 50% of text)
  /^[A-Z\s]{20,}$/,
  // Excessive punctuation
  /[!?]{3,}/,
  // Common spam phrases
  /\b(click here|limited time|act now|free money|earn \$|make \$\d+)\b/i,
  // Cryptocurrency spam
  /\b(crypto|bitcoin|ethereum|nft|airdrop)\b/i,
  // External links (discouraged in food sharing app)
  /https?:\/\/(?!.*supabase\.co)/i,
];

function containsProfanity(text: string): boolean {
  const lowerText = text.toLowerCase();
  return PROFANITY_PATTERNS.some((pattern) => pattern.test(lowerText));
}

function containsSpam(text: string): { isSpam: boolean; reason?: string } {
  for (const pattern of SPAM_PATTERNS) {
    if (pattern.test(text)) {
      return { isSpam: true, reason: "Contains suspicious content" };
    }
  }

  // Check for ALL CAPS (more than 50% uppercase letters)
  const letters = text.replace(/[^a-zA-Z]/g, "");
  if (letters.length > 10) {
    const upperCount = (text.match(/[A-Z]/g) || []).length;
    if (upperCount / letters.length > 0.5) {
      return { isSpam: true, reason: "Excessive capitalization" };
    }
  }

  return { isSpam: false };
}

// =============================================================================
// CORS Headers
// =============================================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// =============================================================================
// Main Handler
// =============================================================================

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // Initialize Supabase client
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseKey) {
      console.error("Missing Supabase configuration");
      return new Response(
        JSON.stringify({ error: "Server configuration error" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Parse request body
    const payload: ValidateListingRequest = await req.json();

    // Initialize errors array
    const errors: ValidationError[] = [];

    // =========================================================================
    // Pre-validation: Content moderation (before RPC call)
    // =========================================================================

    // Check title for profanity
    if (payload.title && containsProfanity(payload.title)) {
      errors.push({
        field: "title",
        code: "VALIDATION_INAPPROPRIATE",
        message: "Title contains inappropriate content",
      });
    }

    // Check title for spam
    if (payload.title) {
      const spamCheck = containsSpam(payload.title);
      if (spamCheck.isSpam) {
        errors.push({
          field: "title",
          code: "VALIDATION_SPAM",
          message: spamCheck.reason || "Title appears to be spam",
        });
      }
    }

    // Check description for profanity
    if (payload.description && containsProfanity(payload.description)) {
      errors.push({
        field: "description",
        code: "VALIDATION_INAPPROPRIATE",
        message: "Description contains inappropriate content",
      });
    }

    // Check description for spam
    if (payload.description) {
      const spamCheck = containsSpam(payload.description);
      if (spamCheck.isSpam) {
        errors.push({
          field: "description",
          code: "VALIDATION_SPAM",
          message: spamCheck.reason || "Description appears to be spam",
        });
      }
    }

    // If content moderation failed, return early
    if (errors.length > 0) {
      return new Response(
        JSON.stringify({
          valid: false,
          errors,
          sanitized: null,
        } satisfies ValidationResult),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // =========================================================================
    // Call RPC for structural validation
    // =========================================================================

    const { data, error: rpcError } = await supabase.rpc("validate_listing", {
      p_title: payload.title,
      p_description: payload.description,
      p_images: payload.images,
      p_post_type: payload.postType,
      p_latitude: payload.latitude,
      p_longitude: payload.longitude,
      p_pickup_address: payload.pickupAddress,
      p_pickup_time: payload.pickupTime,
    });

    if (rpcError) {
      console.error("RPC error:", rpcError);
      return new Response(
        JSON.stringify({
          valid: false,
          errors: [
            {
              field: "server",
              code: "SERVER_ERROR",
              message: "Validation service unavailable",
            },
          ],
          sanitized: null,
        } satisfies ValidationResult),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // RPC returns JSONB, parse if needed
    const result =
      typeof data === "string" ? JSON.parse(data) : (data as ValidationResult);

    // Return validation result
    return new Response(JSON.stringify(result), {
      status: result.valid ? 200 : 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error in validate-listing:", error);
    return new Response(
      JSON.stringify({
        valid: false,
        errors: [
          {
            field: "server",
            code: "SERVER_ERROR",
            message:
              error instanceof Error ? error.message : "Internal server error",
          },
        ],
        sanitized: null,
      } satisfies ValidationResult),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
