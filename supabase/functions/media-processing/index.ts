import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface UploadRequest {
  file_name: string;
  content_type: string;
  file_size: number;
  entity_type: "listing" | "profile" | "message";
  entity_id?: string;
}

interface ProcessRequest {
  storage_path: string;
  operations: Array<{
    type: "resize" | "compress" | "watermark" | "blur_faces";
    params?: Record<string, unknown>;
  }>;
}

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

    // POST /media-processing/upload-url - Get signed upload URL
    if (path === "upload-url" && req.method === "POST") {
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

      const body: UploadRequest = await req.json();
      const { file_name, content_type, file_size, entity_type, entity_id } = body;

      // Validate file size (max 10MB)
      if (file_size > 10 * 1024 * 1024) {
        return new Response(JSON.stringify({ error: "File too large. Maximum size is 10MB." }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Validate content type
      const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/heic"];
      if (!allowedTypes.includes(content_type)) {
        return new Response(JSON.stringify({ error: "Invalid file type. Allowed: JPEG, PNG, WebP, HEIC" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Generate unique path
      const timestamp = Date.now();
      const ext = file_name.split(".").pop() || "jpg";
      const storagePath = `${entity_type}/${user.id}/${timestamp}.${ext}`;

      // Create signed upload URL
      const { data: uploadData, error: uploadError } = await supabaseClient.storage
        .from("media")
        .createSignedUploadUrl(storagePath);

      if (uploadError) throw uploadError;

      // Create processing queue entry
      await supabaseClient.from("media_processing_queue").insert({
        user_id: user.id,
        original_path: storagePath,
        entity_type,
        entity_id,
        status: "pending_upload",
      });

      return new Response(JSON.stringify({
        upload_url: uploadData.signedUrl,
        storage_path: storagePath,
        token: uploadData.token,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /media-processing/process - Queue image processing
    if (path === "process" && req.method === "POST") {
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

      const body: ProcessRequest = await req.json();
      const { storage_path, operations } = body;

      // Update queue entry
      const { data, error } = await supabaseClient
        .from("media_processing_queue")
        .update({
          status: "queued",
          operations: operations,
        })
        .eq("original_path", storage_path)
        .eq("user_id", user.id)
        .select()
        .single();

      if (error) throw error;

      // Trigger async processing (in production, use a worker)
      await processImage(supabaseClient, data.id, storage_path, operations);

      return new Response(JSON.stringify({ queue_id: data.id, status: "processing" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // GET /media-processing/status/:id - Get processing status
    if (path?.startsWith("status-") && req.method === "GET") {
      const queueId = path.replace("status-", "");

      const { data, error } = await supabaseClient
        .from("media_processing_queue")
        .select("id, status, processed_path, error_message, processed_at")
        .eq("id", queueId)
        .single();

      if (error) throw error;

      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /media-processing/check-duplicate - Check for duplicate images
    if (path === "check-duplicate" && req.method === "POST") {
      const body = await req.json();
      const { perceptual_hash } = body;

      const { data, error } = await supabaseClient
        .from("image_hashes")
        .select("storage_path, entity_type, entity_id, similarity")
        .eq("perceptual_hash", perceptual_hash)
        .limit(5);

      if (error) throw error;

      return new Response(JSON.stringify({
        is_duplicate: data && data.length > 0,
        matches: data,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /media-processing/confirm-upload - Confirm upload completed
    if (path === "confirm-upload" && req.method === "POST") {
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
      const { storage_path, perceptual_hash } = body;

      // Update queue status
      await supabaseClient
        .from("media_processing_queue")
        .update({ status: "uploaded" })
        .eq("original_path", storage_path)
        .eq("user_id", user.id);

      // Store hash for deduplication
      if (perceptual_hash) {
        await supabaseClient.from("image_hashes").insert({
          storage_path,
          perceptual_hash,
          user_id: user.id,
        }).onConflict("storage_path").merge();
      }

      // Get public URL
      const { data: urlData } = supabaseClient.storage
        .from("media")
        .getPublicUrl(storage_path);

      return new Response(JSON.stringify({
        success: true,
        public_url: urlData.publicUrl,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // DELETE /media-processing/delete - Delete media
    if (path === "delete" && req.method === "DELETE") {
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

      const storage_path = url.searchParams.get("path");
      if (!storage_path) {
        return new Response(JSON.stringify({ error: "Missing path parameter" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Verify ownership
      const { data: queueData } = await supabaseClient
        .from("media_processing_queue")
        .select("id")
        .eq("original_path", storage_path)
        .eq("user_id", user.id)
        .single();

      if (!queueData) {
        return new Response(JSON.stringify({ error: "Not found or not authorized" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Delete from storage
      await supabaseClient.storage.from("media").remove([storage_path]);

      // Delete queue entry
      await supabaseClient
        .from("media_processing_queue")
        .delete()
        .eq("original_path", storage_path);

      // Delete hash
      await supabaseClient
        .from("image_hashes")
        .delete()
        .eq("storage_path", storage_path);

      return new Response(JSON.stringify({ success: true }), {
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

// Image processing helper (simplified - in production use a dedicated service)
async function processImage(
  supabase: ReturnType<typeof createClient>,
  queueId: string,
  storagePath: string,
  operations: Array<{ type: string; params?: Record<string, unknown> }>
): Promise<void> {
  try {
    // Download original
    const { data: fileData, error: downloadError } = await supabase.storage
      .from("media")
      .download(storagePath);

    if (downloadError) throw downloadError;

    // For now, just copy to processed path (real implementation would process)
    const processedPath = storagePath.replace(/(\.[^.]+)$/, "_processed$1");

    const { error: uploadError } = await supabase.storage
      .from("media")
      .upload(processedPath, fileData, {
        contentType: fileData.type,
        upsert: true,
      });

    if (uploadError) throw uploadError;

    // Update queue
    await supabase
      .from("media_processing_queue")
      .update({
        status: "completed",
        processed_path: processedPath,
        processed_at: new Date().toISOString(),
      })
      .eq("id", queueId);
  } catch (error) {
    await supabase
      .from("media_processing_queue")
      .update({
        status: "failed",
        error_message: error.message,
      })
      .eq("id", queueId);
  }
}
