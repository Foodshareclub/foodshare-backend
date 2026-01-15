/**
 * Sentry Telegram Webhook
 * Receives Sentry webhook events and forwards them to Telegram
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const BOT_TOKEN = Deno.env.get("BOT_TOKEN")!;
const ADMIN_CHAT_ID = Deno.env.get("ADMIN_CHAT_ID")!;

interface SentryEvent {
  action: string;
  data: {
    issue?: {
      id: string;
      title: string;
      culprit?: string;
      shortId: string;
      metadata?: { type?: string; value?: string };
      count?: number;
      userCount?: number;
    };
    event?: {
      event_id: string;
      message?: string;
      level?: string;
      environment?: string;
      platform?: string;
    };
  };
}

async function sendTelegram(text: string): Promise<boolean> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: ADMIN_CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatMessage(event: SentryEvent): string {
  const { action, data } = event;
  const issue = data.issue;
  
  let emoji = "🔴";
  if (action === "resolved") emoji = "✅";
  else if (action === "assigned") emoji = "👤";
  else if (action === "ignored") emoji = "🔇";
  
  const lines: string[] = [`${emoji} <b>Sentry: ${action.toUpperCase()}</b>`, ""];
  
  if (issue) {
    lines.push(`<b>${issue.shortId}</b>: ${escapeHtml(issue.title)}`);
    if (issue.culprit) lines.push(`📍 ${escapeHtml(issue.culprit)}`);
    if (issue.metadata?.value) lines.push(`💬 ${escapeHtml(issue.metadata.value.substring(0, 200))}`);
    if (issue.count && issue.count > 1) lines.push(`📊 ${issue.count} events, ${issue.userCount || 0} users`);
    lines.push("", `🔗 https://foodshare.sentry.io/issues/${issue.id}/`);
  }
  
  if (data.event?.environment) lines.push(`🌍 ${data.event.environment}`);
  if (data.event?.platform) lines.push(`📱 ${data.event.platform}`);
  
  return lines.join("\n");
}

serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!BOT_TOKEN || !ADMIN_CHAT_ID) return new Response("Config error", { status: 500 });
  
  try {
    const event: SentryEvent = await req.json();
    console.log("Sentry event:", event.action);
    
    const sent = await sendTelegram(formatMessage(event));
    return new Response(JSON.stringify({ success: sent }), {
      status: sent ? 200 : 500,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Webhook error:", error);
    return new Response(JSON.stringify({ error: "Invalid request" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
});
