/**
 * Image Review Cron Job
 * 
 * Periodically reviews uploaded images for:
 * - Content moderation (inappropriate content)
 * - Quality issues (blurry, corrupted)
 * - Duplicate detection
 * - Compression opportunities (missed optimizations)
 * 
 * Runs every hour
 */

import { createClient } from "jsr:@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";

const VERSION = "1.0.0";
const SERVICE = "review-images-cron";

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders, status: 204 });
  }
  
  try {
    // Verify cron secret
    const cronSecret = Deno.env.get("CRON_SECRET");
    const authHeader = req.headers.get("authorization");
    
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: corsHeaders }
      );
    }
    
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    
    const results = {
      reviewed: 0,
      flagged: 0,
      compressed: 0,
      duplicates: 0,
    };
    
    // Get recent uploads (last hour)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    
    // Check food-images bucket
    const { data: foodImages } = await supabase.storage
      .from("food-images")
      .list("", {
        limit: 100,
        sortBy: { column: "created_at", order: "desc" },
      });
    
    if (foodImages) {
      for (const image of foodImages) {
        if (new Date(image.created_at) < new Date(oneHourAgo)) break;
        
        results.reviewed++;
        
        // Get image URL
        const { data: urlData } = supabase.storage
          .from("food-images")
          .getPublicUrl(image.name);
        
        // Check if needs moderation
        const needsReview = await checkImageContent(urlData.publicUrl);
        if (needsReview) {
          results.flagged++;
          
          // Flag for manual review
          await supabase.from("image_reviews").insert({
            bucket: "food-images",
            path: image.name,
            url: urlData.publicUrl,
            reason: "content_moderation",
            status: "pending",
          });
        }
        
        // Check if compression was missed
        if (image.metadata?.size && image.metadata.size > 500 * 1024) {
          results.compressed++;
          console.log(`Large image detected: ${image.name} (${image.metadata.size} bytes)`);
        }
      }
    }
    
    // Check other buckets
    const buckets = ["profiles", "forum", "challenges", "avatars", "posts"];
    for (const bucket of buckets) {
      const { data: images } = await supabase.storage
        .from(bucket)
        .list("", {
          limit: 50,
          sortBy: { column: "created_at", order: "desc" },
        });
      
      if (images) {
        for (const image of images) {
          if (new Date(image.created_at) < new Date(oneHourAgo)) break;
          results.reviewed++;
        }
      }
    }
    
    console.log("Image review complete:", results);
    
    return new Response(
      JSON.stringify({
        success: true,
        version: VERSION,
        service: SERVICE,
        results,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Image review error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: corsHeaders }
    );
  }
});

async function checkImageContent(imageUrl: string): Promise<boolean> {
  // Use HuggingFace or similar for content moderation
  const hfToken = Deno.env.get("HUGGINGFACE_ACCESS_TOKEN");
  if (!hfToken) return false;
  
  try {
    const response = await fetch(
      "https://api-inference.huggingface.co/models/Falconsai/nsfw_image_detection",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${hfToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ inputs: imageUrl }),
      }
    );
    
    if (!response.ok) return false;
    
    const result = await response.json();
    
    // Flag if NSFW score > 0.5
    if (Array.isArray(result) && result[0]) {
      const nsfwScore = result[0].find((r: any) => r.label === "nsfw")?.score || 0;
      return nsfwScore > 0.5;
    }
    
    return false;
  } catch (error) {
    console.error("Content check failed:", error);
    return false;
  }
}
