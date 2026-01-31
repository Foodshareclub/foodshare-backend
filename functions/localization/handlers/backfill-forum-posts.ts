/**
 * Backfill Forum Post Translations Handler
 *
 * Translates forum posts via batch translation endpoint.
 * Supports two modes:
 * - "full": Offset-based pagination for one-time bulk operations
 * - "incremental": Recent forum posts only (for cron jobs)
 *
 * Usage:
 * POST /localization/backfill-forum-posts
 * {
 *   "limit": 100,              // optional, default 100
 *   "offset": 0,               // optional, for pagination (full mode)
 *   "dryRun": false,           // optional, if true just counts forum posts
 *   "mode": "full",            // "full" or "incremental"
 *   "hoursBack": 24            // for incremental mode, how far back to look
 * }
 *
 * Response:
 * {
 *   "success": true,
 *   "forumPostsProcessed": 50,
 *   "totalTranslations": 500,  // 50 posts * 2 fields * 5 locales
 *   "estimatedTimeMinutes": 8,
 *   "mode": "incremental"
 * }
 */

import { createClient } from "jsr:@supabase/supabase-js@2";
import { getCorsHeaders } from "../../_shared/cors.ts";

interface BackfillRequest {
  limit?: number;
  offset?: number;
  dryRun?: boolean;
  mode?: "full" | "incremental";
  hoursBack?: number;
  source?: string;  // 'cron' or 'manual'
  onlyUntranslated?: boolean;  // Only fetch content without existing translations
}

interface BackfillResponse {
  success: boolean;
  forumPostsProcessed: number;
  totalTranslations: number;
  estimatedTimeMinutes: number;
  dryRun?: boolean;
  mode?: string;
}

const TARGET_LOCALES_COUNT = 5; // ru, es, de, fr, pt (top 5)
const FIELDS_PER_FORUM_POST = 2; // title, description
const SECONDS_PER_TRANSLATION = 10; // Estimated LLM time
const JOB_TYPE = "forum_posts";
const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

export default async function backfillForumPostsHandler(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({
      success: false,
      error: "Method not allowed. Use POST.",
    }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body: BackfillRequest = await req.json().catch(() => ({}));
    const {
      limit = 100,
      offset = 0,
      dryRun = false,
      mode = "full",
      hoursBack = 24,
      onlyUntranslated = false
    } = body;

    // Validate limits
    if (limit < 1 || limit > 1000) {
      return new Response(JSON.stringify({
        success: false,
        error: "limit must be between 1 and 1000",
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Initialize Supabase client
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // ========== Job Locking: Check if previous job still running ==========
    const { data: inProgressJob } = await supabase
      .from("translation_backfill_jobs")
      .select("*")
      .eq("job_type", JOB_TYPE)
      .eq("status", "in_progress")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (inProgressJob) {
      const jobAge = Date.now() - new Date(inProgressJob.started_at).getTime();

      if (jobAge < STALE_THRESHOLD_MS) {
        // Job still running - skip this cron run
        console.log(`Skipping ${JOB_TYPE} backfill - previous job still running (${Math.round(jobAge / 60000)} mins)`);
        return new Response(JSON.stringify({
          success: true,
          skipped: true,
          reason: "Previous job still in progress",
          previousJobStarted: inProgressJob.started_at,
          jobAgeMinutes: Math.round(jobAge / 60000),
        }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } else {
        // Stale job - mark as failed
        console.log(`Marking stale ${JOB_TYPE} job as failed (${Math.round(jobAge / 60000)} mins old)`);
        await supabase
          .from("translation_backfill_jobs")
          .update({
            status: "failed",
            completed_at: new Date().toISOString(),
            error_message: "Timeout - marked as stale after 30 minutes",
          })
          .eq("id", inProgressJob.id);
      }
    }

    // Create new job record
    const { data: newJob, error: jobError } = await supabase
      .from("translation_backfill_jobs")
      .insert({
        job_type: JOB_TYPE,
        status: "in_progress",
        triggered_by: body.source || "manual",
      })
      .select()
      .single();

    if (jobError) {
      console.error("Failed to create job record:", jobError.message);
    }
    // ========== End Job Locking ==========

    // Fetch forum posts based on mode
    let forumPosts: Array<{ id: number; forum_post_name: string; forum_post_description: string | null }> | null = null;
    let count: number | null = null;
    let error: Error | null = null;

    if (onlyUntranslated) {
      // Only untranslated mode: use RPC to find forum posts without translations
      const { data, error: rpcError } = await supabase.rpc("get_untranslated_forum_posts", {
        p_limit: limit,
        p_offset: offset
      });

      if (rpcError) {
        error = new Error(rpcError.message);
      } else {
        forumPosts = data;
        count = forumPosts?.length || 0;
      }
      console.log(`Fetching untranslated forum posts (limit: ${limit}, offset: ${offset})`);
    } else {
      // Build query based on mode
      let query = supabase
        .from("forum")
        .select("id, forum_post_name, forum_post_description", { count: "exact" })
        .eq("forum_published", true)
        .not("forum_post_name", "is", null);

      if (mode === "incremental") {
        // Incremental mode: fetch recent forum posts (created in last N hours)
        const cutoffTime = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
        query = query
          .gte("forum_post_created_at", cutoffTime)
          .order("forum_post_created_at", { ascending: false })
          .limit(limit);
      } else {
        // Full mode: offset-based pagination
        query = query.range(offset, offset + limit - 1);
      }

      const result = await query;
      forumPosts = result.data;
      count = result.count;
      if (result.error) {
        error = new Error(result.error.message);
      }
    }

    if (error) {
      console.error("Failed to fetch forum posts:", error.message);
      return new Response(JSON.stringify({
        success: false,
        error: `Failed to fetch forum posts: ${error.message}`,
      }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!forumPosts || forumPosts.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        forumPostsProcessed: 0,
        totalTranslations: 0,
        estimatedTimeMinutes: 0,
        message: "No forum posts found to translate",
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const effectiveMode = onlyUntranslated ? "onlyUntranslated" : mode;
    console.log(`Found ${forumPosts.length} forum posts to translate (mode: ${effectiveMode}, offset: ${offset}, total: ${count})`);

    // If dry run, just return counts
    if (dryRun) {
      const totalTranslations = forumPosts.length * FIELDS_PER_FORUM_POST * TARGET_LOCALES_COUNT;
      const estimatedTimeMinutes = Math.ceil(
        (totalTranslations * SECONDS_PER_TRANSLATION) / 60
      );

      return new Response(JSON.stringify({
        success: true,
        forumPostsProcessed: forumPosts.length,
        totalForumPosts: count,
        totalTranslations,
        estimatedTimeMinutes,
        dryRun: true,
        mode: effectiveMode,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Trigger batch translation for each forum post (fire-and-forget)
    const translationPromises = forumPosts.map(async (forumPost) => {
      const fields = [];

      if (forumPost.forum_post_name && forumPost.forum_post_name.trim().length > 0) {
        fields.push({ name: "title", text: forumPost.forum_post_name });
      }

      if (forumPost.forum_post_description && forumPost.forum_post_description.trim().length > 0) {
        fields.push({ name: "description", text: forumPost.forum_post_description });
      }

      if (fields.length === 0) {
        return; // Skip forum posts with no content
      }

      try {
        const response = await supabase.functions.invoke("localization/translate-batch", {
          body: {
            content_type: "forum_post",
            content_id: forumPost.id.toString(),
            fields,
          },
        });

        if (response.error) {
          console.warn(`Failed to trigger translation for forum post ${forumPost.id}:`, response.error);
        } else {
          console.log(`Triggered translation for forum post ${forumPost.id}`);
        }
      } catch (error) {
        console.warn(`Error triggering translation for forum post ${forumPost.id}:`, (error as Error).message);
      }
    });

    // Don't await all - fire and forget, but wait a bit to ensure they're queued
    Promise.all(translationPromises).catch((error) => {
      console.error("Some translations failed:", (error as Error).message);
    });

    const totalTranslations = forumPosts.length * FIELDS_PER_FORUM_POST * TARGET_LOCALES_COUNT;
    const estimatedTimeMinutes = Math.ceil(
      (totalTranslations * SECONDS_PER_TRANSLATION) / 60
    );

    const response: BackfillResponse = {
      success: true,
      forumPostsProcessed: forumPosts.length,
      totalTranslations,
      estimatedTimeMinutes,
      mode: effectiveMode,
    };

    // Mark job as completed
    if (newJob) {
      await supabase
        .from("translation_backfill_jobs")
        .update({
          status: "completed",
          completed_at: new Date().toISOString(),
          items_processed: forumPosts.length,
        })
        .eq("id", newJob.id);
    }

    console.log("Forum posts backfill triggered", response);

    return new Response(JSON.stringify(response), {
      status: 202, // Accepted
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Forum posts backfill error:", (error as Error).message);

    // Mark job as failed (best effort - supabase may not be available)
    try {
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
      );
      await supabase
        .from("translation_backfill_jobs")
        .update({
          status: "failed",
          completed_at: new Date().toISOString(),
          error_message: (error as Error).message,
        })
        .eq("job_type", JOB_TYPE)
        .eq("status", "in_progress");
    } catch {
      // Ignore - best effort
    }

    return new Response(JSON.stringify({
      success: false,
      error: (error as Error).message,
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}
