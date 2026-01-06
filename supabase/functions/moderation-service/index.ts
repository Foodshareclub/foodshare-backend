import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface ModerationCheckRequest {
  content_type: "listing" | "message" | "review" | "profile" | "forum_post" | "forum_comment";
  content: {
    text?: string;
    title?: string;
    image_urls?: string[];
  };
  entity_id?: string;
}

interface ModerationRuleRequest {
  rule_type: "keyword" | "regex" | "ai_category";
  pattern: string;
  action: "flag" | "block" | "shadow_ban";
  severity: "low" | "medium" | "high";
  applies_to: string[];
}

// Banned keywords for basic content moderation
const BLOCKED_KEYWORDS = [
  "spam", "scam", "fraud", "illegal", "counterfeit", "fake",
];

const FLAGGED_KEYWORDS = [
  "prescription", "medication", "alcohol", "tobacco",
];

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const url = new URL(req.url);
    const path = url.pathname.split("/").pop();

    // POST /moderation-service/check - Pre-submission content check
    if (path === "check" && req.method === "POST") {
      const body: ModerationCheckRequest = await req.json();
      const { content_type, content, entity_id } = body;

      const textToCheck = [content.text, content.title].filter(Boolean).join(" ").toLowerCase();
      const issues: Array<{ type: string; severity: string; message: string }> = [];

      // Check blocked keywords
      for (const keyword of BLOCKED_KEYWORDS) {
        if (textToCheck.includes(keyword)) {
          issues.push({
            type: "blocked_keyword",
            severity: "high",
            message: `Content contains prohibited term: "${keyword}"`,
          });
        }
      }

      // Check flagged keywords
      for (const keyword of FLAGGED_KEYWORDS) {
        if (textToCheck.includes(keyword)) {
          issues.push({
            type: "flagged_keyword",
            severity: "medium",
            message: `Content contains flagged term: "${keyword}"`,
          });
        }
      }

      // Check custom rules from database
      const { data: customRules } = await supabaseClient
        .from("moderation_rules")
        .select("*")
        .eq("enabled", true)
        .contains("applies_to", [content_type]);

      if (customRules) {
        for (const rule of customRules) {
          let matches = false;
          if (rule.rule_type === "keyword") {
            matches = textToCheck.includes(rule.pattern.toLowerCase());
          } else if (rule.rule_type === "regex") {
            try {
              matches = new RegExp(rule.pattern, "i").test(textToCheck);
            } catch {
              // Invalid regex, skip
            }
          }

          if (matches) {
            issues.push({
              type: rule.rule_type,
              severity: rule.severity,
              message: rule.message || `Content matched moderation rule`,
            });
          }
        }
      }

      const isBlocked = issues.some((i) => i.severity === "high");
      const needsReview = issues.some((i) => i.severity === "medium");

      return new Response(JSON.stringify({
        approved: !isBlocked,
        needs_review: needsReview,
        issues,
        content_type,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /moderation-service/report - Report content
    if (path === "report" && req.method === "POST") {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: { user }, error: authError } = await supabaseClient.auth.getUser(
        authHeader.replace("Bearer ", "")
      );
      if (authError || !user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const body = await req.json();
      const { content_type, content_id, reason, description } = body;

      const { data, error } = await supabaseClient
        .from("content_reports")
        .insert({
          reporter_id: user.id,
          content_type,
          content_id,
          reason,
          description,
          status: "pending",
        })
        .select()
        .single();

      if (error) throw error;

      // Check if content has multiple reports
      const { count } = await supabaseClient
        .from("content_reports")
        .select("*", { count: "exact", head: true })
        .eq("content_type", content_type)
        .eq("content_id", content_id)
        .eq("status", "pending");

      // Auto-flag if 3+ reports
      if (count && count >= 3) {
        await supabaseClient
          .from("moderation_queue")
          .upsert({
            content_type,
            content_id,
            status: "auto_flagged",
            report_count: count,
            priority: "high",
          }, {
            onConflict: "content_type,content_id",
          });
      }

      return new Response(JSON.stringify({ report_id: data.id }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // GET /moderation-service/queue - Get moderation queue (admin)
    if (path === "queue" && req.method === "GET") {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: { user }, error: authError } = await supabaseClient.auth.getUser(
        authHeader.replace("Bearer ", "")
      );
      if (authError || !user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Check admin role
      const { data: profile } = await supabaseClient
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .single();

      if (!profile || !["admin", "moderator"].includes(profile.role)) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const status = url.searchParams.get("status") || "pending";
      const limit = parseInt(url.searchParams.get("limit") || "50");

      const { data, error } = await supabaseClient
        .from("moderation_queue")
        .select(`
          *,
          content_reports(id, reason, description, reporter_id, created_at)
        `)
        .eq("status", status)
        .order("priority", { ascending: false })
        .order("created_at", { ascending: true })
        .limit(limit);

      if (error) throw error;

      return new Response(JSON.stringify({ queue: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /moderation-service/review - Review content (admin)
    if (path === "review" && req.method === "POST") {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: { user }, error: authError } = await supabaseClient.auth.getUser(
        authHeader.replace("Bearer ", "")
      );
      if (authError || !user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Check admin role
      const { data: profile } = await supabaseClient
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .single();

      if (!profile || !["admin", "moderator"].includes(profile.role)) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const body = await req.json();
      const { queue_id, decision, action, notes } = body;

      // Update queue item
      const { data: queueItem, error: queueError } = await supabaseClient
        .from("moderation_queue")
        .update({
          status: decision,
          reviewed_by: user.id,
          reviewed_at: new Date().toISOString(),
          notes,
        })
        .eq("id", queue_id)
        .select()
        .single();

      if (queueError) throw queueError;

      // Apply action to content
      if (action === "remove" && queueItem) {
        const tableMap: Record<string, string> = {
          listing: "posts",
          message: "messages",
          review: "reviews",
          profile: "profiles",
          forum_post: "forum_posts",
          forum_comment: "forum_comments",
        };

        const table = tableMap[queueItem.content_type];
        if (table) {
          await supabaseClient
            .from(table)
            .update({ status: "removed", moderation_reason: notes })
            .eq("id", queueItem.content_id);
        }
      }

      // Update related reports
      await supabaseClient
        .from("content_reports")
        .update({ status: decision === "approved" ? "dismissed" : "actioned" })
        .eq("content_type", queueItem.content_type)
        .eq("content_id", queueItem.content_id);

      return new Response(JSON.stringify({ success: true, queue_item: queueItem }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /moderation-service/rules - Create moderation rule (admin)
    if (path === "rules" && req.method === "POST") {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: { user }, error: authError } = await supabaseClient.auth.getUser(
        authHeader.replace("Bearer ", "")
      );
      if (authError || !user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Check admin role
      const { data: profile } = await supabaseClient
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .single();

      if (!profile || profile.role !== "admin") {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const body: ModerationRuleRequest = await req.json();

      const { data, error } = await supabaseClient
        .from("moderation_rules")
        .insert({
          rule_type: body.rule_type,
          pattern: body.pattern,
          action: body.action,
          severity: body.severity,
          applies_to: body.applies_to,
          created_by: user.id,
        })
        .select()
        .single();

      if (error) throw error;

      return new Response(JSON.stringify({ rule: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // GET /moderation-service/rules - List moderation rules (admin)
    if (path === "rules" && req.method === "GET") {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: { user }, error: authError } = await supabaseClient.auth.getUser(
        authHeader.replace("Bearer ", "")
      );
      if (authError || !user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Check admin role
      const { data: profile } = await supabaseClient
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .single();

      if (!profile || !["admin", "moderator"].includes(profile.role)) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data, error } = await supabaseClient
        .from("moderation_rules")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) throw error;

      return new Response(JSON.stringify({ rules: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // GET /moderation-service/stats - Get moderation statistics (admin)
    if (path === "stats" && req.method === "GET") {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: { user }, error: authError } = await supabaseClient.auth.getUser(
        authHeader.replace("Bearer ", "")
      );
      if (authError || !user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Check admin role
      const { data: profile } = await supabaseClient
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .single();

      if (!profile || !["admin", "moderator"].includes(profile.role)) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Get queue stats
      const { data: queueStats } = await supabaseClient
        .from("moderation_queue")
        .select("status")
        .gte("created_at", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());

      const stats = {
        pending: queueStats?.filter((q) => q.status === "pending").length || 0,
        approved: queueStats?.filter((q) => q.status === "approved").length || 0,
        rejected: queueStats?.filter((q) => q.status === "rejected").length || 0,
        auto_flagged: queueStats?.filter((q) => q.status === "auto_flagged").length || 0,
      };

      return new Response(JSON.stringify({ stats }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
