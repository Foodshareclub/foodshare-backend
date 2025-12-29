import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

interface EmailPayload {
  to: string;
  subject: string;
  template: "welcome" | "reservation_confirmed" | "new_message" | "item_reserved" | "review_reminder";
  data?: Record<string, any>;
}

const EMAIL_TEMPLATES = {
  welcome: {
    subject: "Welcome to Foodshare! 🍎",
    html: (data: Record<string, any>) => `
      <h2>Welcome to Foodshare, ${data.name}!</h2>
      <p>We're excited to have you join our community of food sharers.</p>
      <p>Get started by:</p>
      <ul>
        <li>Setting up your profile</li>
        <li>Browsing available food items nearby</li>
        <li>Sharing your first item</li>
      </ul>
      <p>Happy sharing!</p>
    `,
  },
  reservation_confirmed: {
    subject: "Reservation Confirmed ✅",
    html: (data: Record<string, any>) => `
      <h2>Your reservation is confirmed!</h2>
      <p>Hi ${data.name},</p>
      <p>Your reservation for <strong>${data.item_title}</strong> has been confirmed.</p>
      <p><strong>Pickup Details:</strong></p>
      <ul>
        <li>Time: ${data.pickup_time}</li>
        <li>Location: ${data.pickup_address}</li>
        <li>Contact: ${data.owner_name}</li>
      </ul>
      <p>Please arrive on time and bring your own container if needed.</p>
    `,
  },
  new_message: {
    subject: "New Message from Foodshare 💬",
    html: (data: Record<string, any>) => `
      <h2>You have a new message!</h2>
      <p>Hi ${data.name},</p>
      <p><strong>${data.sender_name}</strong> sent you a message about <strong>${data.item_title}</strong>:</p>
      <blockquote>${data.message}</blockquote>
      <p><a href="${data.conversation_link}">Reply to this message</a></p>
    `,
  },
  item_reserved: {
    subject: "Someone wants your food! 🎉",
    html: (data: Record<string, any>) => `
      <h2>New reservation request</h2>
      <p>Hi ${data.name},</p>
      <p><strong>${data.requester_name}</strong> wants to reserve your <strong>${data.item_title}</strong>.</p>
      <p>Preferred pickup time: ${data.pickup_time}</p>
      <p><a href="${data.reservation_link}">Review and respond to this request</a></p>
    `,
  },
  review_reminder: {
    subject: "How was your experience? ⭐",
    html: (data: Record<string, any>) => `
      <h2>Share your experience</h2>
      <p>Hi ${data.name},</p>
      <p>We hope your recent food sharing experience with <strong>${data.other_user_name}</strong> went well!</p>
      <p>Would you mind leaving a quick review? It helps build trust in our community.</p>
      <p><a href="${data.review_link}">Leave a review</a></p>
    `,
  },
};

Deno.serve(async (req: Request) => {
  try {
    // CORS headers
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
        },
      });
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "No authorization header" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Verify user authentication
    const token = authHeader.replace("Bearer ", "");
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(token);

    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Get Resend API key from Supabase Vault (using secure audited function)
    const { data: secretData, error: secretError } = await supabase.rpc(
      "get_secret_audited",
      {
        secret_name: "RESEND_API_KEY",
        requesting_user_id: user.id,
        request_metadata: {
          ip_address: req.headers.get("x-forwarded-for"),
          user_agent: req.headers.get("user-agent"),
          request_id: crypto.randomUUID(),
        },
      }
    );

    if (secretError || !secretData) {
      console.error("Error retrieving Resend API key:", secretError);
      return new Response(
        JSON.stringify({ error: "Failed to retrieve email service credentials" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const resendApiKey = secretData;

    // Parse request body
    const payload: EmailPayload = await req.json();
    const { to, subject, template, data = {} } = payload;

    // Validate required fields
    if (!to || (!subject && !template)) {
      return new Response(
        JSON.stringify({ error: "Missing required fields (to, subject or template)" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Get template if specified
    let emailSubject = subject;
    let emailHtml = "";

    if (template && EMAIL_TEMPLATES[template]) {
      emailSubject = EMAIL_TEMPLATES[template].subject;
      emailHtml = EMAIL_TEMPLATES[template].html(data);
    } else if (data.html) {
      emailHtml = data.html;
    } else {
      emailHtml = `<p>${data.message || "You have a notification from Foodshare."}</p>`;
    }

    // Send email via Resend
    const resendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resendApiKey}`,
      },
      body: JSON.stringify({
        from: "Foodshare <notifications@foodshare.club>",
        to: [to],
        subject: emailSubject,
        html: emailHtml,
      }),
    });

    const resendData = await resendResponse.json();

    if (!resendResponse.ok) {
      console.error("Resend API error:", resendData);
      return new Response(
        JSON.stringify({
          error: "Failed to send email",
          details: resendData,
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: "Email sent successfully",
        email_id: resendData.id,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  } catch (error) {
    console.error("Error in send-email:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
});
