/**
 * Zod schemas for api-v1-email request validation
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";

// =============================================================================
// Schemas
// =============================================================================

export const processSchema = z.object({
  batchSize: z.number().int().min(1).max(200).optional().default(50),
  dryRun: z.boolean().optional().default(false),
  provider: z.string().optional(),
});

export const emailTypeEnum = z.enum([
  "auth", "chat", "food_listing", "feedback", "review_reminder",
  "newsletter", "announcement", "welcome", "goodbye", "notification",
]);

export const sendSchema = z.object({
  to: z.union([z.string().email(), z.array(z.string().email()).min(1).max(50)]),
  subject: z.string().min(1).max(500),
  html: z.string().min(1),
  text: z.string().optional(),
  replyTo: z.string().email().optional(),
  tags: z.array(z.string()).max(10).optional(),
  emailType: emailTypeEnum.optional().default("notification"),
});

export const sendTemplateSchema = z.object({
  to: z.union([z.string().email(), z.array(z.string().email()).min(1).max(50)]),
  slug: z.string().min(1),
  variables: z.record(z.unknown()),
  emailType: emailTypeEnum.optional().default("notification"),
});

export const sendInvitationSchema = z.object({
  recipientEmail: z.string().email(),
  senderName: z.string().min(1).max(100),
  senderEmail: z.string().email().optional(),
  message: z.string().max(500).optional(),
});

export const automationProcessSchema = z.object({
  batchSize: z.number().int().min(1).max(200).optional().default(20),
  concurrency: z.number().int().min(1).max(10).optional().default(3),
  dryRun: z.boolean().optional().default(false),
});
