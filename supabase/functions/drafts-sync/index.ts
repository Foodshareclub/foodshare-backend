/**
 * Drafts Sync Edge Function
 *
 * Cross-device form draft synchronization for Web, iOS, and Android.
 * Supports auto-save, conflict detection, and resolution.
 *
 * Endpoints:
 *   POST /save     - Save or update a draft
 *   GET  /get      - Get a specific draft
 *   GET  /list     - List user's drafts
 *   POST /resolve  - Resolve a draft conflict
 *   DELETE /delete - Delete a draft
 */

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-device-id, x-platform",
};

// =============================================================================
// Types
// =============================================================================

interface SaveDraftRequest {
  formType: string;
  entityId?: string;
  fields: Record<string, unknown>;
  validationState?: Record<string, unknown>;
  clientVersion?: number;
  metadata?: Record<string, unknown>;
}

interface ResolveConflictRequest {
  draftId: string;
  resolvedFields: Record<string, unknown>;
}

// =============================================================================
// Main Handler
// =============================================================================

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Get auth token
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Authorization required" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      {
        global: {
          headers: { Authorization: authHeader },
        },
      }
    );

    // Verify auth
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Invalid token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const url = new URL(req.url);
    const path = url.pathname.replace("/drafts-sync", "");
    const deviceId = req.headers.get("x-device-id") || "unknown";
    const platform = req.headers.get("x-platform") || "web";

    // Route handling
    if (req.method === "POST" && path === "/save") {
      return await handleSave(req, supabase, deviceId, platform);
    }

    if (req.method === "GET" && path === "/get") {
      return await handleGet(req, supabase);
    }

    if (req.method === "GET" && path === "/list") {
      return await handleList(req, supabase);
    }

    if (req.method === "POST" && path === "/resolve") {
      return await handleResolve(req, supabase, deviceId, platform);
    }

    if (req.method === "DELETE" && path === "/delete") {
      return await handleDelete(req, supabase);
    }

    if (req.method === "GET" && path === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", service: "drafts-sync" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: "Not found" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Drafts sync error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

// =============================================================================
// Handlers
// =============================================================================

async function handleSave(
  req: Request,
  supabase: ReturnType<typeof createClient>,
  deviceId: string,
  platform: string
): Promise<Response> {
  const body: SaveDraftRequest = await req.json();

  if (!body.formType || !body.fields) {
    return new Response(
      JSON.stringify({ error: "Missing required fields: formType, fields" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const { data, error } = await supabase.rpc("save_form_draft", {
    p_form_type: body.formType,
    p_entity_id: body.entityId || null,
    p_fields: body.fields,
    p_validation_state: body.validationState || {},
    p_device_id: deviceId,
    p_platform: platform,
    p_client_version: body.clientVersion || 1,
    p_metadata: body.metadata || {},
  });

  if (error) {
    console.error("Save draft error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const result = data?.[0];

  if (result?.has_conflict) {
    return new Response(
      JSON.stringify({
        success: false,
        conflict: true,
        draftId: result.draft_id,
        serverVersion: result.server_version,
        serverFields: result.server_fields,
        message: "Draft has been modified on another device",
      }),
      { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({
      success: true,
      draftId: result?.draft_id,
      version: result?.version,
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

async function handleGet(
  req: Request,
  supabase: ReturnType<typeof createClient>
): Promise<Response> {
  const url = new URL(req.url);
  const formType = url.searchParams.get("formType");
  const entityId = url.searchParams.get("entityId");

  if (!formType) {
    return new Response(
      JSON.stringify({ error: "Missing required parameter: formType" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const { data, error } = await supabase.rpc("get_form_draft", {
    p_form_type: formType,
    p_entity_id: entityId || null,
  });

  if (error) {
    console.error("Get draft error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (!data) {
    return new Response(
      JSON.stringify({ draft: null }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({
      draft: {
        id: data.id,
        formType: data.form_type,
        entityId: data.entity_id,
        fields: data.fields,
        validationState: data.validation_state,
        version: data.version,
        deviceId: data.device_id,
        platform: data.platform,
        metadata: data.metadata,
        createdAt: data.created_at,
        updatedAt: data.updated_at,
        expiresAt: data.expires_at,
      },
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

async function handleList(
  req: Request,
  supabase: ReturnType<typeof createClient>
): Promise<Response> {
  const url = new URL(req.url);
  const formType = url.searchParams.get("formType");
  const includeExpired = url.searchParams.get("includeExpired") === "true";

  const { data, error } = await supabase.rpc("get_form_drafts", {
    p_form_type: formType || null,
    p_include_expired: includeExpired,
  });

  if (error) {
    console.error("List drafts error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const drafts = (data || []).map((d: Record<string, unknown>) => ({
    id: d.id,
    formType: d.form_type,
    entityId: d.entity_id,
    fields: d.fields,
    version: d.version,
    platform: d.platform,
    updatedAt: d.updated_at,
    expiresAt: d.expires_at,
  }));

  return new Response(
    JSON.stringify({ drafts, count: drafts.length }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

async function handleResolve(
  req: Request,
  supabase: ReturnType<typeof createClient>,
  deviceId: string,
  platform: string
): Promise<Response> {
  const body: ResolveConflictRequest = await req.json();

  if (!body.draftId || !body.resolvedFields) {
    return new Response(
      JSON.stringify({ error: "Missing required fields: draftId, resolvedFields" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const { data, error } = await supabase.rpc("resolve_draft_conflict", {
    p_draft_id: body.draftId,
    p_resolved_fields: body.resolvedFields,
    p_device_id: deviceId,
    p_platform: platform,
  });

  if (error) {
    console.error("Resolve conflict error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({
      success: true,
      draft: {
        id: data.id,
        version: data.version,
        fields: data.fields,
        updatedAt: data.updated_at,
      },
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

async function handleDelete(
  req: Request,
  supabase: ReturnType<typeof createClient>
): Promise<Response> {
  const url = new URL(req.url);
  const draftId = url.searchParams.get("draftId");
  const formType = url.searchParams.get("formType");
  const entityId = url.searchParams.get("entityId");

  let success = false;

  if (draftId) {
    const { data, error } = await supabase.rpc("delete_form_draft", {
      p_draft_id: draftId,
    });

    if (error) {
      console.error("Delete draft error:", error);
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    success = data === true;
  } else if (formType) {
    const { data, error } = await supabase.rpc("delete_form_draft_by_type", {
      p_form_type: formType,
      p_entity_id: entityId || null,
    });

    if (error) {
      console.error("Delete draft error:", error);
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    success = data === true;
  } else {
    return new Response(
      JSON.stringify({ error: "Must provide draftId or formType" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({ success }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}
