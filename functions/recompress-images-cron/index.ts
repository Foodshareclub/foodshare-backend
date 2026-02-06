/**
 * Recompress Old Images Cron
 * 
 * Finds images uploaded before the new compression system
 * and re-compresses them using api-v1-images pipeline
 * 
 * Runs daily to gradually optimize old images
 */

import { createClient } from "jsr:@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";

const VERSION = "1.0.0";
const SERVICE = "recompress-images-cron";
const BATCH_SIZE = 50; // Process 50 images per run

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
      processed: 0,
      compressed: 0,
      failed: 0,
      skipped: 0,
      totalSaved: 0,
    };
    
    // Get old images that haven't been recompressed
    // Look for images uploaded before 2026-02-06 (when new system deployed)
    const cutoffDate = "2026-02-06T00:00:00Z";
    
    const buckets = ["food-images", "profiles", "forum", "challenges", "avatars", "posts"];
    
    for (const bucket of buckets) {
      const { data: files } = await supabase.storage
        .from(bucket)
        .list("", {
          limit: BATCH_SIZE,
          sortBy: { column: "created_at", order: "asc" },
        });
      
      if (!files) continue;
      
      for (const file of files) {
        results.processed++;
        
        // Skip if already in metrics (already compressed by new system)
        const { data: existing } = await supabase
          .from("image_upload_metrics")
          .select("id")
          .eq("bucket", bucket)
          .eq("path", file.name)
          .single();
        
        if (existing) {
          results.skipped++;
          continue;
        }
        
        // Skip if too small (already optimized)
        if (file.metadata?.size && file.metadata.size < 100 * 1024) {
          results.skipped++;
          continue;
        }
        
        try {
          // Download original
          const { data: fileData } = await supabase.storage
            .from(bucket)
            .download(file.name);
          
          if (!fileData) {
            results.failed++;
            continue;
          }
          
          const originalSize = fileData.size;
          const buffer = await fileData.arrayBuffer();
          
          // Recompress via api-v1-images
          const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
          const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
          
          const formData = new FormData();
          formData.append("file", new Blob([buffer]));
          formData.append("bucket", bucket);
          formData.append("path", file.name);
          formData.append("generateThumbnail", "false");
          formData.append("extractEXIF", "false");
          formData.append("enableAI", "false");
          
          const uploadResponse = await fetch(
            `${supabaseUrl}/functions/v1/api-v1-images/upload`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${serviceKey}`,
              },
              body: formData,
            }
          );
          
          if (uploadResponse.ok) {
            const result = await uploadResponse.json();
            results.compressed++;
            results.totalSaved += result.metadata.savedBytes || 0;
            
            console.log(`✅ Recompressed ${bucket}/${file.name}: saved ${result.metadata.savedBytes} bytes`);
          } else {
            results.failed++;
            console.error(`❌ Failed to recompress ${bucket}/${file.name}`);
          }
        } catch (error) {
          results.failed++;
          console.error(`❌ Error processing ${bucket}/${file.name}:`, error);
        }
      }
    }
    
    console.log("Recompression complete:", results);
    
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
    console.error("Recompression error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: corsHeaders }
    );
  }
});
