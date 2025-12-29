const botToken = Deno.env.get("BOT_TOKEN");

Deno.serve(async (req) => {
  try {
    // Get recent updates from Telegram
    const response = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates?limit=10`, {
      method: "GET",
    });

    const result = await response.json();

    if (!result.ok) {
      return new Response(
        JSON.stringify({
          error: "Failed to get updates",
          details: result,
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Extract unique chat IDs from recent messages
    const chatIds = new Set();
    const messages = [];

    for (const update of result.result) {
      if (update.message) {
        const msg = update.message;
        chatIds.add(msg.chat.id);
        messages.push({
          chat_id: msg.chat.id,
          chat_type: msg.chat.type,
          from: msg.from.first_name + (msg.from.last_name ? " " + msg.from.last_name : ""),
          username: msg.from.username || "N/A",
          text: msg.text || "[media]",
          date: new Date(msg.date * 1000).toISOString(),
        });
      }
    }

    return new Response(
      JSON.stringify(
        {
          success: true,
          instructions:
            "Send any message to your bot, then call this function again to see your chat_id",
          unique_chat_ids: Array.from(chatIds),
          recent_messages: messages,
        },
        null,
        2
      ),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: error.message,
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
});
