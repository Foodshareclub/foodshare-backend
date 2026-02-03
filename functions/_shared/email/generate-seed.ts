#!/usr/bin/env -S deno run --allow-write --allow-read

/**
 * Email Template SQL Seed Generator
 *
 * Generates SQL INSERT statements for all email templates using the
 * componentized template system. Run this whenever templates are updated.
 *
 * Usage:
 *   deno run --allow-write --allow-read generate-seed.ts
 *   deno run --allow-write --allow-read generate-seed.ts --output ../../../migrations/seed-email-templates.sql
 */

import {
  welcomeTemplate,
  emailVerificationTemplate,
  passwordResetTemplate,
  chatNotificationTemplate,
  newListingTemplate,
  volunteerWelcomeTemplate,
  completeProfileTemplate,
  firstShareTipsTemplate,
  milestoneTemplate,
  reengagementTemplate,
  feedbackAlertTemplate,
} from "./template-builder.ts";

interface TemplateDefinition {
  slug: string;
  name: string;
  category: "transactional" | "marketing" | "digest" | "admin";
  subject: string;
  html_content: string;
  text_content: string | null;
  variables: TemplateVariable[];
  metadata: Record<string, unknown>;
}

interface TemplateVariable {
  name: string;
  type: "string" | "number" | "boolean" | "date" | "url";
  required: boolean;
  default?: unknown;
}

// Define template metadata and variable schemas
const TEMPLATE_DEFINITIONS: Omit<TemplateDefinition, "html_content">[] = [
  {
    slug: "welcome",
    name: "Welcome Email",
    category: "transactional",
    subject: "Welcome to FoodShare! 🎉",
    text_content: null,
    variables: [
      { name: "name", type: "string", required: true },
    ],
    metadata: { preheader: "Start sharing and discovering food in your community" },
  },
  {
    slug: "email-verification",
    name: "Email Verification",
    category: "transactional",
    subject: "Confirm your email to join FoodShare! ✉️",
    text_content: null,
    variables: [
      { name: "verifyUrl", type: "url", required: true },
    ],
    metadata: { preheader: "One click to confirm your FoodShare account" },
  },
  {
    slug: "password-reset",
    name: "Password Reset",
    category: "transactional",
    subject: "Reset your FoodShare password 🔐",
    text_content: null,
    variables: [
      { name: "name", type: "string", required: true },
      { name: "resetUrl", type: "url", required: true },
      { name: "expiresIn", type: "string", required: false, default: "1 hour" },
    ],
    metadata: { preheader: "Click to reset your FoodShare password" },
  },
  {
    slug: "chat-notification",
    name: "Chat Message Notification",
    category: "transactional",
    subject: "💬 New message from {{senderName}}",
    text_content: null,
    variables: [
      { name: "recipientName", type: "string", required: true },
      { name: "senderName", type: "string", required: true },
      { name: "messagePreview", type: "string", required: true },
      { name: "chatUrl", type: "url", required: true },
    ],
    metadata: {},
  },
  {
    slug: "new-listing-nearby",
    name: "New Listing Notification",
    category: "transactional",
    subject: "{{listingEmoji}} New {{listingType}} available: {{listingTitle}}",
    text_content: null,
    variables: [
      { name: "recipientName", type: "string", required: true },
      { name: "listingTitle", type: "string", required: true },
      { name: "listingDescription", type: "string", required: false },
      { name: "listingAddress", type: "string", required: false },
      { name: "posterName", type: "string", required: true },
      { name: "listingUrl", type: "url", required: true },
      { name: "listingType", type: "string", required: false, default: "food" },
      { name: "listingEmoji", type: "string", required: false, default: "🍎" },
    ],
    metadata: {},
  },
  {
    slug: "volunteer-welcome",
    name: "Volunteer Welcome",
    category: "transactional",
    subject: "Welcome to the FoodShare Volunteer Team! 🌟",
    text_content: null,
    variables: [
      { name: "name", type: "string", required: true },
    ],
    metadata: { preheader: "You're joining an amazing team" },
  },
  {
    slug: "complete-profile",
    name: "Complete Profile Reminder",
    category: "marketing",
    subject: "Complete your FoodShare profile 📝",
    text_content: null,
    variables: [
      { name: "name", type: "string", required: true },
      { name: "completionPercent", type: "number", required: false, default: 50 },
    ],
    metadata: { preheader: "Complete your profile to unlock all features" },
  },
  {
    slug: "first-share-tips",
    name: "First Share Tips",
    category: "marketing",
    subject: "Tips for your first FoodShare 🍎",
    text_content: null,
    variables: [
      { name: "name", type: "string", required: true },
    ],
    metadata: { preheader: "Tips for a successful first share" },
  },
  {
    slug: "milestone-celebration",
    name: "Milestone Achievement",
    category: "marketing",
    subject: "🎉 Achievement Unlocked: {{milestoneName}}!",
    text_content: null,
    variables: [
      { name: "name", type: "string", required: true },
      { name: "milestoneName", type: "string", required: true },
      { name: "milestoneDescription", type: "string", required: true },
      { name: "milestoneEmoji", type: "string", required: false, default: "🏆" },
      { name: "percentile", type: "number", required: false, default: 10 },
      { name: "nextMilestone", type: "string", required: false },
    ],
    metadata: {},
  },
  {
    slug: "reengagement",
    name: "Reengagement Email",
    category: "marketing",
    subject: "We miss you at FoodShare! 💚",
    text_content: null,
    variables: [
      { name: "name", type: "string", required: true },
      { name: "daysSinceLastVisit", type: "number", required: true },
      { name: "newListingsNearby", type: "number", required: false, default: 0 },
      { name: "mealsSavedCommunity", type: "number", required: false, default: 0 },
      { name: "newMembersNearby", type: "number", required: false, default: 0 },
      { name: "unsubscribeUrl", type: "url", required: true },
    ],
    metadata: { preheader: "A lot has happened since you've been away" },
  },
  {
    slug: "feedback-alert",
    name: "Feedback Alert (Admin)",
    category: "admin",
    subject: "{{feedbackEmoji}} New Feedback: {{subject}}",
    text_content: null,
    variables: [
      { name: "feedbackId", type: "string", required: true },
      { name: "feedbackType", type: "string", required: true },
      { name: "feedbackEmoji", type: "string", required: false, default: "📩" },
      { name: "subject", type: "string", required: true },
      { name: "submitterName", type: "string", required: true },
      { name: "submitterEmail", type: "string", required: true },
      { name: "message", type: "string", required: true },
      { name: "timestamp", type: "date", required: false },
    ],
    metadata: {},
  },
];

// Sample data for rendering templates
const SAMPLE_DATA: Record<string, Record<string, unknown>> = {
  welcome: { name: "John" },
  "email-verification": { verifyUrl: "https://foodshare.club/verify?token=abc123" },
  "password-reset": { name: "John", resetUrl: "https://foodshare.club/reset?token=xyz789", expiresIn: "1 hour" },
  "chat-notification": { recipientName: "John", senderName: "Sarah", messagePreview: "Hey! Is the pasta still available?", chatUrl: "https://foodshare.club/chat/123" },
  "new-listing-nearby": { recipientName: "John", listingTitle: "Fresh vegetables", listingDescription: "Organic tomatoes and cucumbers from my garden", listingAddress: "123 Main St", posterName: "Sarah", listingUrl: "https://foodshare.club/food/456", listingType: "food", listingEmoji: "🍎" },
  "volunteer-welcome": { name: "John" },
  "complete-profile": { name: "John", completionPercent: 65 },
  "first-share-tips": { name: "John" },
  "milestone-celebration": { name: "John", milestoneName: "First Share", milestoneDescription: "You shared your first meal with the community!", milestoneEmoji: "🎉", percentile: 10, nextMilestone: "Share 5 more meals to unlock Food Hero badge" },
  reengagement: { name: "John", daysSinceLastVisit: 14, newListingsNearby: 8, mealsSavedCommunity: 234, newMembersNearby: 12, unsubscribeUrl: "https://foodshare.club/unsubscribe?token=abc" },
  "feedback-alert": { feedbackId: "fb-123", feedbackType: "feature", feedbackEmoji: "✨", subject: "Add dark mode", submitterName: "John Doe", submitterEmail: "john@example.com", message: "It would be great to have a dark mode option for the app.", timestamp: "2024-02-01T10:30:00Z" },
};

// Template render functions map
const TEMPLATE_FUNCTIONS: Record<string, (params: Record<string, unknown>) => { subject: string; html: string }> = {
  welcome: (p) => welcomeTemplate({ name: String(p.name) }),
  "email-verification": (p) => emailVerificationTemplate({ verifyUrl: String(p.verifyUrl) }),
  "password-reset": (p) => passwordResetTemplate({ name: String(p.name), resetUrl: String(p.resetUrl), expiresIn: p.expiresIn as string }),
  "chat-notification": (p) => chatNotificationTemplate({ recipientName: String(p.recipientName), senderName: String(p.senderName), messagePreview: String(p.messagePreview), chatUrl: String(p.chatUrl) }),
  "new-listing-nearby": (p) => newListingTemplate({ recipientName: String(p.recipientName), listingTitle: String(p.listingTitle), listingDescription: p.listingDescription as string, listingAddress: p.listingAddress as string, posterName: String(p.posterName), listingUrl: String(p.listingUrl), listingType: p.listingType as string, listingEmoji: p.listingEmoji as string }),
  "volunteer-welcome": (p) => volunteerWelcomeTemplate({ name: String(p.name) }),
  "complete-profile": (p) => completeProfileTemplate({ name: String(p.name), completionPercent: p.completionPercent as number }),
  "first-share-tips": (p) => firstShareTipsTemplate({ name: String(p.name) }),
  "milestone-celebration": (p) => milestoneTemplate({ name: String(p.name), milestoneName: String(p.milestoneName), milestoneDescription: String(p.milestoneDescription), milestoneEmoji: p.milestoneEmoji as string, percentile: p.percentile as number, nextMilestone: p.nextMilestone as string }),
  reengagement: (p) => reengagementTemplate({ name: String(p.name), daysSinceLastVisit: p.daysSinceLastVisit as number, newListingsNearby: p.newListingsNearby as number, mealsSavedCommunity: p.mealsSavedCommunity as number, newMembersNearby: p.newMembersNearby as number, unsubscribeUrl: String(p.unsubscribeUrl) }),
  "feedback-alert": (p) => feedbackAlertTemplate({ feedbackId: String(p.feedbackId), feedbackType: String(p.feedbackType), feedbackEmoji: p.feedbackEmoji as string, subject: String(p.subject), submitterName: String(p.submitterName), submitterEmail: String(p.submitterEmail), message: String(p.message), timestamp: p.timestamp as string }),
};

function escapeSQL(str: string): string {
  return str.replace(/'/g, "''");
}

function generateSQL(): string {
  const lines: string[] = [
    "-- ============================================================================",
    "-- Email Templates Seed Data",
    "-- Generated by: deno run --allow-write --allow-read generate-seed.ts",
    `-- Generated at: ${new Date().toISOString()}`,
    "-- ============================================================================",
    "",
    "-- Clear existing templates (optional - comment out for incremental updates)",
    "-- DELETE FROM email_templates;",
    "",
    "-- Insert templates with ON CONFLICT to handle updates",
    "",
  ];

  for (const def of TEMPLATE_DEFINITIONS) {
    const sampleData = SAMPLE_DATA[def.slug];
    const renderFn = TEMPLATE_FUNCTIONS[def.slug];

    if (!renderFn || !sampleData) {
      console.warn(`Skipping ${def.slug}: missing render function or sample data`);
      continue;
    }

    const rendered = renderFn(sampleData);
    const htmlContent = rendered.html;

    lines.push(`-- Template: ${def.name}`);
    lines.push(`INSERT INTO email_templates (slug, name, category, subject, html_content, text_content, variables, metadata, is_active, version)`);
    lines.push(`VALUES (`);
    lines.push(`  '${escapeSQL(def.slug)}',`);
    lines.push(`  '${escapeSQL(def.name)}',`);
    lines.push(`  '${escapeSQL(def.category)}',`);
    lines.push(`  '${escapeSQL(def.subject)}',`);
    lines.push(`  '${escapeSQL(htmlContent)}',`);
    lines.push(`  ${def.text_content ? `'${escapeSQL(def.text_content)}'` : "NULL"},`);
    lines.push(`  '${escapeSQL(JSON.stringify(def.variables))}'::jsonb,`);
    lines.push(`  '${escapeSQL(JSON.stringify(def.metadata))}'::jsonb,`);
    lines.push(`  true,`);
    lines.push(`  1`);
    lines.push(`)`);
    lines.push(`ON CONFLICT (slug) DO UPDATE SET`);
    lines.push(`  name = EXCLUDED.name,`);
    lines.push(`  category = EXCLUDED.category,`);
    lines.push(`  subject = EXCLUDED.subject,`);
    lines.push(`  html_content = EXCLUDED.html_content,`);
    lines.push(`  text_content = EXCLUDED.text_content,`);
    lines.push(`  variables = EXCLUDED.variables,`);
    lines.push(`  metadata = EXCLUDED.metadata,`);
    lines.push(`  version = email_templates.version + 1,`);
    lines.push(`  updated_at = NOW();`);
    lines.push("");
  }

  lines.push("-- ============================================================================");
  lines.push(`-- Generated ${TEMPLATE_DEFINITIONS.length} templates`);
  lines.push("-- ============================================================================");

  return lines.join("\n");
}

// Main execution
if (import.meta.main) {
  const args = Deno.args;
  const outputIndex = args.indexOf("--output");
  const outputPath = outputIndex !== -1 ? args[outputIndex + 1] : null;

  const sql = generateSQL();

  if (outputPath) {
    await Deno.writeTextFile(outputPath, sql);
    console.log(`✅ Generated SQL seed file: ${outputPath}`);
  } else {
    console.log(sql);
  }

  console.log(`\n📊 Summary:`);
  console.log(`   Templates: ${TEMPLATE_DEFINITIONS.length}`);
  console.log(`   Categories: transactional, marketing, admin`);
}
