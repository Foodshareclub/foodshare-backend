/**
 * Image maintenance handlers — cleanup orphans and recompress old images.
 */

import { type HandlerContext, ok } from "../../_shared/api-handler.ts";
import { AuthenticationError } from "../../_shared/errors.ts";
import { cleanupOrphanImages } from "../services/cleanup.ts";
import { recompressOldImages } from "../services/recompression.ts";

/**
 * Cleanup orphan images. Protected by cron secret.
 */
export async function handleCleanup(ctx: HandlerContext): Promise<Response> {
  const cronSecret = Deno.env.get("CRON_SECRET");
  const authHeader = ctx.headers.get("authorization");

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    throw new AuthenticationError("Unauthorized");
  }

  const body = await ctx.request.json().catch(() => ({}));

  const stats = await cleanupOrphanImages(ctx.supabase, {
    gracePeriodHours: body.gracePeriodHours,
    batchSize: body.batchSize,
    dryRun: body.dryRun,
  });

  return ok(stats, ctx);
}

/**
 * Recompress old images. Protected by cron secret.
 */
export async function handleRecompress(ctx: HandlerContext): Promise<Response> {
  const cronSecret = Deno.env.get("CRON_SECRET");
  const authHeader = ctx.headers.get("authorization");

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    throw new AuthenticationError("Unauthorized");
  }

  const body = await ctx.request.json().catch(() => ({}));

  const results = await recompressOldImages(ctx.supabase, {
    batchSize: body.batchSize,
    cutoffDate: body.cutoffDate,
  });

  return ok({ results }, ctx);
}
