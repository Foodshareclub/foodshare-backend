/**
 * Notify New User Edge Function - Minimal Version
 * Sends Telegram notifications when new users join.
 */

const botToken = Deno.env.get("BOT_TOKEN")!;
const adminChatId = Deno.env.get("ADMIN_CHAT_ID")!;

async function sendTelegram(text: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: adminChatId, text, parse_mode: "HTML" }),
    });
    const data = await res.json();
    return data.ok === true;
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  // CORS
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  try {
    const { record } = await req.json();

    const name = [record.first_name, record.second_name].filter(Boolean).join(" ") || record.nickname || "New user";
    const msg = `🎉 <b>New user joined FoodShare!</b>\n\n👤 <b>${name}</b>\n📧 ${record.email || "N/A"}\n📅 ${record.created_time}`;

    const sent = await sendTelegram(msg);

    return new Response(JSON.stringify({ success: sent, profile_id: record.id }), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      status: sent ? 200 : 500,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      status: 400,
    });
  }
});
