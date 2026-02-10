/**
 * Unified Atomic Operations Edge Function
 * Phase 4: Transaction batching with rollback support
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface AtomicOperation {
  type: string;
  payload: Record<string, unknown>;
  onSuccess?: string[];
}

interface AtomicRequest {
  operations: AtomicOperation[];
  rollbackOnFailure?: boolean;
  idempotencyKey?: string;
}

interface OperationResult {
  operationType: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

interface AtomicResponse {
  success: boolean;
  results: OperationResult[];
  rollbackPerformed: boolean;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    // Get auth header
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Verify token
    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );

    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Invalid token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { operations, rollbackOnFailure = true, idempotencyKey } = await req
      .json() as AtomicRequest;

    // Check idempotency
    if (idempotencyKey) {
      const { data: existing } = await supabase
        .from("atomic_operations")
        .select("results, status")
        .eq("idempotency_key", idempotencyKey)
        .single();

      if (existing && existing.status === "completed") {
        return new Response(
          JSON.stringify({
            success: true,
            results: existing.results,
            rollbackPerformed: false,
            cached: true,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    // Record operation start
    let operationId: string | null = null;
    if (idempotencyKey) {
      const { data } = await supabase
        .from("atomic_operations")
        .insert({
          idempotency_key: idempotencyKey,
          operations: operations,
          status: "pending",
        })
        .select("id")
        .single();
      operationId = data?.id;
    }

    // Execute operations
    const results: OperationResult[] = [];
    const completedOperations: { type: string; rollbackData: unknown }[] = [];
    let allSuccessful = true;

    for (const op of operations) {
      try {
        const result = await executeOperation(supabase, op, user.id);
        results.push({
          operationType: op.type,
          success: true,
          data: result.data,
        });
        completedOperations.push({
          type: op.type,
          rollbackData: result.rollbackData,
        });

        // Execute onSuccess callbacks
        if (op.onSuccess) {
          for (const callback of op.onSuccess) {
            await executeCallback(supabase, callback, result.data, user.id);
          }
        }
      } catch (error) {
        allSuccessful = false;
        results.push({
          operationType: op.type,
          success: false,
          error: error.message,
        });

        if (rollbackOnFailure) {
          // Rollback completed operations
          for (const completed of completedOperations.reverse()) {
            await rollbackOperation(supabase, completed.type, completed.rollbackData);
          }
          break;
        }
      }
    }

    // Update operation status
    if (operationId) {
      await supabase
        .from("atomic_operations")
        .update({
          status: allSuccessful ? "completed" : "failed",
          results: results,
          completed_at: new Date().toISOString(),
        })
        .eq("id", operationId);
    }

    return new Response(
      JSON.stringify({
        success: allSuccessful,
        results,
        rollbackPerformed: !allSuccessful && rollbackOnFailure,
      } as AtomicResponse),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("Atomic operation error:", error);
    return new Response(
      JSON.stringify({ error: "Operation failed", message: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

async function executeOperation(
  supabase: ReturnType<typeof createClient>,
  op: AtomicOperation,
  userId: string,
): Promise<{ data: unknown; rollbackData: unknown }> {
  switch (op.type) {
    case "create_listing": {
      const { data, error } = await supabase
        .from("posts")
        .insert({
          ...op.payload,
          user_id: userId,
        })
        .select()
        .single();

      if (error) throw new Error(error.message);
      return { data, rollbackData: { id: data.id } };
    }

    case "update_listing": {
      const { id, ...updates } = op.payload;

      // Get current data for rollback
      const { data: current } = await supabase
        .from("posts")
        .select("*")
        .eq("id", id)
        .eq("user_id", userId)
        .single();

      const { data, error } = await supabase
        .from("posts")
        .update(updates)
        .eq("id", id)
        .eq("user_id", userId)
        .select()
        .single();

      if (error) throw new Error(error.message);
      return { data, rollbackData: { id, previousData: current } };
    }

    case "delete_listing": {
      const { id } = op.payload;

      // Get current data for rollback
      const { data: _current } = await supabase
        .from("posts")
        .select("*")
        .eq("id", id)
        .eq("user_id", userId)
        .single();

      const { error } = await supabase
        .from("posts")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id)
        .eq("user_id", userId);

      if (error) throw new Error(error.message);
      return { data: { id }, rollbackData: { id, wasDeleted: false } };
    }

    case "submit_review": {
      const { revieweeId, rating, comment, transactionId } = op.payload;

      const { data, error } = await supabase
        .from("reviews")
        .insert({
          reviewer_id: userId,
          reviewee_id: revieweeId,
          rating,
          comment,
          transaction_id: transactionId,
        })
        .select()
        .single();

      if (error) throw new Error(error.message);
      return { data, rollbackData: { id: data.id } };
    }

    case "add_favorite": {
      const { listingId } = op.payload;

      const { data, error } = await supabase
        .from("favorites")
        .insert({
          user_id: userId,
          post_id: listingId,
        })
        .select()
        .single();

      if (error) throw new Error(error.message);
      return { data, rollbackData: { userId, listingId } };
    }

    case "remove_favorite": {
      const { listingId } = op.payload;

      const { error } = await supabase
        .from("favorites")
        .delete()
        .eq("user_id", userId)
        .eq("post_id", listingId);

      if (error) throw new Error(error.message);
      return { data: { listingId }, rollbackData: { userId, listingId } };
    }

    case "mark_messages_read": {
      const { messageIds } = op.payload;

      const { data, error } = await supabase
        .from("chat_messages")
        .update({ read_at: new Date().toISOString() })
        .in("id", messageIds)
        .select();

      if (error) throw new Error(error.message);
      return { data, rollbackData: { messageIds } };
    }

    case "complete_transaction": {
      const { listingId, recipientId } = op.payload;

      // Update post status
      const { error: postError } = await supabase
        .from("posts")
        .update({ status: "arranged", arranged_with: recipientId })
        .eq("id", listingId)
        .eq("user_id", userId);

      if (postError) throw new Error(postError.message);

      // Create transaction record
      const { data, error } = await supabase
        .from("transactions")
        .insert({
          post_id: listingId,
          donor_id: userId,
          recipient_id: recipientId,
          status: "completed",
        })
        .select()
        .single();

      if (error) throw new Error(error.message);
      return { data, rollbackData: { listingId, transactionId: data.id } };
    }

    case "dismiss_notifications": {
      const { notificationIds } = op.payload;

      const { error } = await supabase
        .from("notifications")
        .update({ dismissed_at: new Date().toISOString() })
        .in("id", notificationIds)
        .eq("user_id", userId);

      if (error) throw new Error(error.message);
      return { data: { notificationIds }, rollbackData: { notificationIds } };
    }

    default:
      throw new Error(`Unknown operation type: ${op.type}`);
  }
}

async function rollbackOperation(
  supabase: ReturnType<typeof createClient>,
  type: string,
  rollbackData: unknown,
): Promise<void> {
  const data = rollbackData as Record<string, unknown>;

  switch (type) {
    case "create_listing":
      await supabase.from("posts").delete().eq("id", data.id);
      break;

    case "update_listing":
      if (data.previousData) {
        await supabase
          .from("posts")
          .update(data.previousData as Record<string, unknown>)
          .eq("id", data.id);
      }
      break;

    case "delete_listing":
      await supabase
        .from("posts")
        .update({ deleted_at: null })
        .eq("id", data.id);
      break;

    case "submit_review":
      await supabase.from("reviews").delete().eq("id", data.id);
      break;

    case "add_favorite":
      await supabase
        .from("favorites")
        .delete()
        .eq("user_id", data.userId)
        .eq("post_id", data.listingId);
      break;

    case "remove_favorite":
      await supabase.from("favorites").insert({
        user_id: data.userId,
        post_id: data.listingId,
      });
      break;

    case "mark_messages_read":
      await supabase
        .from("chat_messages")
        .update({ read_at: null })
        .in("id", data.messageIds as string[]);
      break;

    case "complete_transaction":
      await supabase
        .from("posts")
        .update({ status: "available", arranged_with: null })
        .eq("id", data.listingId);
      await supabase.from("transactions").delete().eq("id", data.transactionId);
      break;

    case "dismiss_notifications":
      await supabase
        .from("notifications")
        .update({ dismissed_at: null })
        .in("id", data.notificationIds as string[]);
      break;
  }
}

async function executeCallback(
  supabase: ReturnType<typeof createClient>,
  callback: string,
  data: unknown,
  userId: string,
): Promise<void> {
  const opData = data as Record<string, unknown>;

  switch (callback) {
    case "notify_nearby":
      // Trigger notification to nearby users
      await supabase.functions.invoke("send-push-notification", {
        body: {
          type: "new_listing",
          listingId: opData.id,
          excludeUserId: userId,
        },
      });
      break;

    case "update_stats":
      // Update user stats
      await supabase.rpc("update_user_stats", { user_id: userId });
      break;

    case "recalculate_rating":
      // Recalculate user rating
      await supabase.rpc("recalculate_user_rating", {
        user_id: opData.reviewee_id,
      });
      break;

    case "award_points":
      // Award gamification points
      await supabase.rpc("award_points", {
        user_id: userId,
        action: "review_submitted",
        points: 10,
      });
      break;

    case "notify_user":
      // Notify the reviewed user
      await supabase.functions.invoke("send-push-notification", {
        body: {
          type: "new_review",
          userId: opData.reviewee_id,
          reviewerId: userId,
        },
      });
      break;

    case "notify_both":
      // Notify both transaction parties
      await supabase.functions.invoke("send-push-notification", {
        body: {
          type: "transaction_complete",
          listingId: opData.post_id,
        },
      });
      break;

    case "trigger_review_prompt":
      // Schedule review prompts
      await supabase.from("scheduled_notifications").insert([
        {
          user_id: opData.donor_id,
          type: "review_prompt",
          data: { transactionId: opData.id, targetUserId: opData.recipient_id },
          scheduled_for: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        },
        {
          user_id: opData.recipient_id,
          type: "review_prompt",
          data: { transactionId: opData.id, targetUserId: opData.donor_id },
          scheduled_for: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        },
      ]);
      break;

    case "mark_inactive":
      // Mark listing as inactive
      await supabase
        .from("posts")
        .update({ is_active: false })
        .eq("id", opData.post_id);
      break;
  }
}
