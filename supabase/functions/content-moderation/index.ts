/**
 * Unified Content Moderation Edge Function
 *
 * Provides content moderation for text and images across all content types:
 * - Listings (title, description, images)
 * - Messages
 * - Reviews
 * - Forum posts and comments
 * - User profiles
 *
 * Endpoints:
 * - POST /moderate/text - Analyze text content
 * - POST /moderate/image - Analyze image content
 * - POST /moderate/content - Full content moderation (text + images)
 * - POST /moderate/report - Report content for review
 * - GET /moderate/status/:id - Check moderation status
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { analyzeText, quickCheck, sanitizeText, TextAnalysisResult } from "./text-analyzer.ts";
import { analyzeImage, quickImageCheck, ImageAnalysisResult } from "./image-analyzer.ts";
import {
  makeDecision,
  getPolicy,
  requiresHumanReview,
  getDecisionMessage,
  ContentType,
  ModerationResult,
  UserHistoryContext,
} from "./decision-engine.ts";

// CORS headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Request types
interface TextModerationRequest {
  text: string;
  contentType: ContentType;
  userId?: string;
  quick?: boolean;
}

interface ImageModerationRequest {
  imageUrl?: string;
  imageBase64?: string;
  contentType: ContentType;
  userId?: string;
  quick?: boolean;
}

interface ContentModerationRequest {
  contentType: ContentType;
  contentId?: string;
  userId?: string;
  title?: string;
  description?: string;
  content?: string;
  imageUrls?: string[];
  imagesBase64?: string[];
}

interface ReportRequest {
  contentType: ContentType;
  contentId: string;
  reporterId: string;
  reason: string;
  details?: string;
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/content-moderation/, "");

  try {
    // Initialize Supabase client
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Route handling
    if (req.method === "POST" && path === "/moderate/text") {
      return await handleTextModeration(req, supabase);
    }

    if (req.method === "POST" && path === "/moderate/image") {
      return await handleImageModeration(req, supabase);
    }

    if (req.method === "POST" && path === "/moderate/content") {
      return await handleContentModeration(req, supabase);
    }

    if (req.method === "POST" && path === "/moderate/report") {
      return await handleReport(req, supabase);
    }

    if (req.method === "GET" && path.startsWith("/moderate/status/")) {
      const id = path.replace("/moderate/status/", "");
      return await handleStatusCheck(id, supabase);
    }

    // Health check
    if (req.method === "GET" && path === "/health") {
      return new Response(
        JSON.stringify({ status: "healthy", timestamp: new Date().toISOString() }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: "Not found" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Content moderation error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error", message: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

/**
 * Handle text moderation request
 */
async function handleTextModeration(
  req: Request,
  supabase: ReturnType<typeof createClient>
): Promise<Response> {
  const body: TextModerationRequest = await req.json();
  const { text, contentType, userId, quick } = body;

  if (!text || !contentType) {
    return new Response(
      JSON.stringify({ error: "Missing required fields: text, contentType" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Quick check for fast response
  if (quick) {
    const result = quickCheck(text);
    return new Response(
      JSON.stringify({
        isClean: result.clean,
        severity: result.severity,
        quick: true,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Full analysis
  const textAnalysis = analyzeText(text);

  // Get user history if available
  let userHistory: UserHistoryContext | null = null;
  if (userId) {
    userHistory = await getUserHistory(supabase, userId);
  }

  // Make decision
  const decision = makeDecision(contentType, textAnalysis, null, userHistory);

  // Log moderation
  await logModeration(supabase, {
    contentType,
    userId,
    decision: decision.decision,
    severity: decision.details.overallSeverity,
    textFlags: textAnalysis.flags.map((f) => f.type),
  });

  return new Response(
    JSON.stringify({
      analysis: textAnalysis,
      decision: decision.decision,
      actions: decision.actions,
      message: getDecisionMessage(decision),
      sanitizedText: textAnalysis.sanitizedText,
      requiresReview: requiresHumanReview(decision),
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

/**
 * Handle image moderation request
 */
async function handleImageModeration(
  req: Request,
  supabase: ReturnType<typeof createClient>
): Promise<Response> {
  const body: ImageModerationRequest = await req.json();
  const { imageUrl, imageBase64, contentType, userId, quick } = body;

  if ((!imageUrl && !imageBase64) || !contentType) {
    return new Response(
      JSON.stringify({ error: "Missing required fields: imageUrl or imageBase64, contentType" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Get image data
  let imageData: Uint8Array;
  let mimeType: string;

  if (imageBase64) {
    const parts = imageBase64.split(",");
    const base64Data = parts.length > 1 ? parts[1] : parts[0];
    mimeType = parts.length > 1 ? parts[0].split(":")[1].split(";")[0] : "image/jpeg";
    imageData = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0));
  } else if (imageUrl) {
    const response = await fetch(imageUrl);
    mimeType = response.headers.get("content-type") || "image/jpeg";
    imageData = new Uint8Array(await response.arrayBuffer());
  } else {
    return new Response(
      JSON.stringify({ error: "No image provided" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Quick check
  if (quick) {
    const result = await quickImageCheck(imageData, mimeType);
    return new Response(
      JSON.stringify({
        acceptable: result.acceptable,
        reason: result.reason,
        quick: true,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Full analysis
  const imageAnalysis = await analyzeImage(imageData, mimeType);

  // Get user history
  let userHistory: UserHistoryContext | null = null;
  if (userId) {
    userHistory = await getUserHistory(supabase, userId);
  }

  // Make decision
  const decision = makeDecision(contentType, null, [imageAnalysis], userHistory);

  // Log moderation
  await logModeration(supabase, {
    contentType,
    userId,
    decision: decision.decision,
    severity: decision.details.overallSeverity,
    imageFlags: imageAnalysis.flags.map((f) => f.type),
  });

  return new Response(
    JSON.stringify({
      analysis: imageAnalysis,
      decision: decision.decision,
      actions: decision.actions,
      message: getDecisionMessage(decision),
      requiresReview: requiresHumanReview(decision),
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

/**
 * Handle full content moderation (text + images)
 */
async function handleContentModeration(
  req: Request,
  supabase: ReturnType<typeof createClient>
): Promise<Response> {
  const body: ContentModerationRequest = await req.json();
  const {
    contentType,
    contentId,
    userId,
    title,
    description,
    content,
    imageUrls,
    imagesBase64,
  } = body;

  if (!contentType) {
    return new Response(
      JSON.stringify({ error: "Missing required field: contentType" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Combine text fields
  const textFields = [title, description, content].filter(Boolean);
  const combinedText = textFields.join("\n\n");

  // Analyze text
  let textAnalysis: TextAnalysisResult | null = null;
  if (combinedText.length > 0) {
    textAnalysis = analyzeText(combinedText);
  }

  // Analyze images
  const imageAnalyses: ImageAnalysisResult[] = [];

  if (imageUrls && imageUrls.length > 0) {
    for (const url of imageUrls) {
      try {
        const response = await fetch(url);
        const mimeType = response.headers.get("content-type") || "image/jpeg";
        const imageData = new Uint8Array(await response.arrayBuffer());
        const analysis = await analyzeImage(imageData, mimeType);
        imageAnalyses.push(analysis);
      } catch (error) {
        console.error("Failed to analyze image:", url, error);
      }
    }
  }

  if (imagesBase64 && imagesBase64.length > 0) {
    for (const base64 of imagesBase64) {
      try {
        const parts = base64.split(",");
        const base64Data = parts.length > 1 ? parts[1] : parts[0];
        const mimeType = parts.length > 1 ? parts[0].split(":")[1].split(";")[0] : "image/jpeg";
        const imageData = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0));
        const analysis = await analyzeImage(imageData, mimeType);
        imageAnalyses.push(analysis);
      } catch (error) {
        console.error("Failed to analyze base64 image:", error);
      }
    }
  }

  // Get user history
  let userHistory: UserHistoryContext | null = null;
  if (userId) {
    userHistory = await getUserHistory(supabase, userId);
  }

  // Make decision
  const decision = makeDecision(
    contentType,
    textAnalysis,
    imageAnalyses.length > 0 ? imageAnalyses : null,
    userHistory
  );

  // Store moderation result if content ID provided
  if (contentId) {
    await storeModerationResult(supabase, contentId, contentType, decision);
  }

  // Log moderation
  await logModeration(supabase, {
    contentType,
    contentId,
    userId,
    decision: decision.decision,
    severity: decision.details.overallSeverity,
    textFlags: textAnalysis?.flags.map((f) => f.type),
    imageFlags: imageAnalyses.flatMap((a) => a.flags.map((f) => f.type)),
  });

  // Update user history if violation found
  if (userId && decision.details.overallSeverity !== "none") {
    await updateUserHistory(supabase, userId, decision.details.overallSeverity);
  }

  return new Response(
    JSON.stringify({
      decision: decision.decision,
      actions: decision.actions,
      reason: decision.reason,
      message: getDecisionMessage(decision),
      requiresReview: requiresHumanReview(decision),
      details: {
        textAnalysis: textAnalysis ? {
          isClean: textAnalysis.isClean,
          severity: textAnalysis.severity,
          flagCount: textAnalysis.flags.length,
          sanitizedAvailable: textAnalysis.sanitizedText !== null,
        } : null,
        imageAnalyses: imageAnalyses.map((a) => ({
          isAcceptable: a.isAcceptable,
          category: a.category,
          flagCount: a.flags.length,
        })),
        overallSeverity: decision.details.overallSeverity,
      },
      sanitizedContent: decision.details.sanitizedContent,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

/**
 * Handle content report
 */
async function handleReport(
  req: Request,
  supabase: ReturnType<typeof createClient>
): Promise<Response> {
  const body: ReportRequest = await req.json();
  const { contentType, contentId, reporterId, reason, details } = body;

  if (!contentType || !contentId || !reporterId || !reason) {
    return new Response(
      JSON.stringify({ error: "Missing required fields" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Store report
  const { data, error } = await supabase
    .from("moderation_reports")
    .insert({
      content_type: contentType,
      content_id: contentId,
      reporter_id: reporterId,
      reason,
      details,
      status: "pending",
    })
    .select("id")
    .single();

  if (error) {
    console.error("Failed to store report:", error);
    return new Response(
      JSON.stringify({ error: "Failed to submit report" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Add to moderation queue
  await supabase.from("moderation_queue").insert({
    content_type: contentType,
    content_id: contentId,
    reason: "user_report",
    priority: getPriorityForReason(reason),
    metadata: { report_id: data.id },
  });

  return new Response(
    JSON.stringify({
      success: true,
      reportId: data.id,
      message: "Thank you for your report. We will review it shortly.",
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

/**
 * Check moderation status
 */
async function handleStatusCheck(
  contentId: string,
  supabase: ReturnType<typeof createClient>
): Promise<Response> {
  const { data, error } = await supabase
    .from("moderation_results")
    .select("*")
    .eq("content_id", contentId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (error || !data) {
    return new Response(
      JSON.stringify({ status: "not_found" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({
      contentId,
      decision: data.decision,
      status: data.status,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

// Helper functions

async function getUserHistory(
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<UserHistoryContext | null> {
  const { data, error } = await supabase
    .from("user_moderation_history")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (error || !data) {
    // Check if new user
    const { data: profile } = await supabase
      .from("profiles")
      .select("created_at")
      .eq("id", userId)
      .single();

    const isNewUser = profile
      ? new Date().getTime() - new Date(profile.created_at).getTime() < 7 * 24 * 60 * 60 * 1000
      : true;

    return {
      userId,
      previousViolations: 0,
      lastViolationAt: null,
      trustScore: isNewUser ? 0.5 : 0.8,
      isNewUser,
    };
  }

  return {
    userId,
    previousViolations: data.violation_count,
    lastViolationAt: data.last_violation_at,
    trustScore: data.trust_score,
    isNewUser: false,
  };
}

async function updateUserHistory(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  severity: string
): Promise<void> {
  const trustPenalty: Record<string, number> = {
    low: 0.02,
    medium: 0.05,
    high: 0.1,
    critical: 0.2,
  };

  await supabase.rpc("update_user_moderation_history", {
    p_user_id: userId,
    p_trust_penalty: trustPenalty[severity] || 0.05,
  });
}

async function storeModerationResult(
  supabase: ReturnType<typeof createClient>,
  contentId: string,
  contentType: string,
  decision: ModerationResult
): Promise<void> {
  await supabase.from("moderation_results").upsert({
    content_id: contentId,
    content_type: contentType,
    decision: decision.decision,
    actions: decision.actions,
    severity: decision.details.overallSeverity,
    confidence: decision.details.confidence,
    status: requiresHumanReview(decision) ? "pending_review" : "completed",
    metadata: {
      rulesTriggered: decision.metadata.rulesTrigered,
      processingTimeMs: decision.metadata.processingTimeMs,
    },
  });
}

async function logModeration(
  supabase: ReturnType<typeof createClient>,
  data: {
    contentType: string;
    contentId?: string;
    userId?: string;
    decision: string;
    severity: string;
    textFlags?: string[];
    imageFlags?: string[];
  }
): Promise<void> {
  try {
    await supabase.from("moderation_log").insert({
      content_type: data.contentType,
      content_id: data.contentId,
      user_id: data.userId,
      decision: data.decision,
      severity: data.severity,
      flags: [...(data.textFlags || []), ...(data.imageFlags || [])],
    });
  } catch (error) {
    console.error("Failed to log moderation:", error);
  }
}

function getPriorityForReason(reason: string): number {
  const priorities: Record<string, number> = {
    hate_speech: 10,
    harassment: 9,
    violence: 9,
    nsfw: 8,
    fraud: 7,
    spam: 5,
    inappropriate: 4,
    other: 3,
  };
  return priorities[reason.toLowerCase()] || 3;
}
