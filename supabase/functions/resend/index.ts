/**
 * Resend Email Edge Function
 *
 * Sends welcome/goodbye emails when users are created or deleted.
 * Triggered by database webhooks on auth.users table.
 *
 * Security:
 * - Uses Supabase Vault for API key storage (audited access)
 * - Only triggered by internal database events
 * - Request metadata logged for audit trail
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Types
interface WebhookPayload {
  record: UserRecord | null;
  old_record: UserRecord | null;
  type: "INSERT" | "UPDATE" | "DELETE";
}

interface UserRecord {
  id: string;
  email: string;
  created_at?: string;
  deleted_at?: string;
}

const emailTemplate = (isDeleted: boolean, email: string) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${isDeleted ? "Sorry to see you go" : "Welcome to Foodshare.club"}</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      line-height: 1.6;
      color: #363a57;
      max-width: 600px;
      margin: 0 auto;
      padding: 20px;
    }
    .container {
      background-color: #f3f2f5;
      border-radius: 8px;
      padding: 20px;
    }
    h1 {
      color: #363a57;
      text-align: center;
    }
    .logo {
      text-align: center;
      margin-bottom: 20px;
    }
    .cta-button {
      display: block;
      background-color: #ff2d55;
      color: white;
      padding: 10px 20px;
      text-decoration: none;
      border-radius: 8px;
      margin: 20px auto;
      text-align: center;
      font-weight: bold;
    }
    .footer {
      background-color: #ff2d55;
      color: white;
      text-align: center;
      padding: 20px;
      border-radius: 8px;
      margin-top: 20px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">
      <img src="https://i.ibb.co/d6sMFKD/Cover.png" alt="Foodshare Logo" width="504" style="max-width: 100%; height: auto;">
    </div>
    <h1>${isDeleted ? "We're Sad to See You Go" : "Welcome to Foodshare.club!"}</h1>
    <p>Hey ${email},</p>
    ${isDeleted ? `<p>We're very sad to see you go. Your presence in our community will be missed. If there's anything we could have done better, please don't hesitate to let us know.</p>
         <p>Remember, you're always welcome back if you change your mind!</p>` : `<p>We're thrilled to have you join the Foodshare.club community! Get ready to embark on a journey of delicious discoveries and meaningful connections.</p>
         <p>Here's what you can do next:</p>
         <ul>
           <li>Complete your profile</li>
           <li>Explore local food sharing opportunities</li>
           <li>Connect with other food enthusiasts</li>
         </ul>`}
    <a href="${isDeleted ? 'https://eu-submit.jotform.com/231016600816041' : 'https://foodshare.club/food'}" class="cta-button">
      ${isDeleted ? 'Give Feedback' : 'Get Started'}
    </a>
    <p>Best regards,<br>The Foodshare Team</p>
  </div>
  <div class="footer">
    <p>&copy; Foodshare LLC © <span id="year">2024</span> USA 20231394981. All Rights Reserved.</p>
    <p>4632 Winding Way, Sacramento CA 95841</p>
    <p>If you have any questions please contact us at support@foodshare.club</p>
    <p>
      <a href="https://foodshare.club/" style="color: white;">Visit Us</a> |
      <a href="https://app.gitbook.com/o/S1q71czYZ02oMxTaZgTT/s/XbVLvP6lx1ACYUl8wUUI/" style="color: white;">Privacy Policy</a> |
      <a href="https://app.gitbook.com/o/S1q71czYZ02oMxTaZgTT/s/XbVLvP6lx1ACYUl8wUUI/terms-of-use" style="color: white;">Terms of Use</a>
    </p>
  </div>
</body>
</html>
`;

// CORS headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const requestId = crypto.randomUUID();
  const startTime = performance.now();

  try {
    // =========================================================================
    // INITIALIZE SUPABASE CLIENT
    // =========================================================================

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseKey) {
      console.error("Missing Supabase configuration");
      return new Response(
        JSON.stringify({ error: "Server configuration error" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // =========================================================================
    // PARSE WEBHOOK PAYLOAD
    // =========================================================================

    const payload: WebhookPayload = await req.json();
    const newUser = payload.record;
    const deletedUser = payload.old_record;
    const isDeleted = !!deletedUser && !newUser;

    const targetEmail = deletedUser?.email ?? newUser?.email;
    const targetUserId = deletedUser?.id ?? newUser?.id ?? "unknown";

    if (!targetEmail) {
      console.error("No email address in webhook payload");
      return new Response(
        JSON.stringify({ error: "No email address provided" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    console.log(
      `Processing ${isDeleted ? "deletion" : "creation"} email for: ${targetEmail}`
    );

    // =========================================================================
    // FETCH RESEND API KEY FROM VAULT (AUDITED)
    // =========================================================================

    const requestMetadata = {
      ip_address:
        req.headers.get("x-forwarded-for") ||
        req.headers.get("x-real-ip") ||
        "internal",
      user_agent: req.headers.get("user-agent") || "supabase-webhook",
      request_id: requestId,
      trigger_type: isDeleted ? "user_deleted" : "user_created",
      target_email: targetEmail,
    };

    const { data: resendApiKey, error: vaultError } = await supabase.rpc(
      "get_secret_audited",
      {
        secret_name: "RESEND_API_KEY",
        requesting_user_id: targetUserId,
        request_metadata: requestMetadata,
      }
    );

    if (vaultError || !resendApiKey) {
      console.error("Failed to retrieve Resend API key from Vault:", vaultError);
      return new Response(
        JSON.stringify({ error: "Failed to retrieve email service credentials" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    console.log("✅ Resend API key retrieved from Vault");

    // =========================================================================
    // SEND EMAIL VIA RESEND
    // =========================================================================

    const emailPayload = {
      from: "Foodshare <support@foodshare.club>",
      to: [targetEmail],
      subject: isDeleted ? "Sorry to see you go" : "Welcome to Foodshare.club",
      html: emailTemplate(isDeleted, targetEmail),
    };

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resendApiKey}`,
      },
      body: JSON.stringify(emailPayload),
    });

    if (!res.ok) {
      const contentType = res.headers.get("content-type");
      let errorDetails: string;

      if (contentType && contentType.includes("application/json")) {
        const errorData = await res.json();
        errorDetails = JSON.stringify(errorData);
        console.error("Error response from Resend API:", errorData);
      } else {
        errorDetails = await res.text();
        console.error("Unexpected response from Resend API:", errorDetails);
      }

      // Log the failure to audit
      await logEmailEvent(supabase, {
        event_type: "email_failed",
        target_email: targetEmail,
        email_type: isDeleted ? "goodbye" : "welcome",
        error: `Resend API error: ${res.status} - ${errorDetails}`,
        request_id: requestId,
        duration_ms: Math.round(performance.now() - startTime),
      });

      throw new Error(
        `Resend API error: ${res.status} ${res.statusText}`
      );
    }

    const data = await res.json();
    console.log("✅ Email sent successfully:", data);

    // Log successful email to audit
    await logEmailEvent(supabase, {
      event_type: "email_sent",
      target_email: targetEmail,
      email_type: isDeleted ? "goodbye" : "welcome",
      resend_id: data.id,
      request_id: requestId,
      duration_ms: Math.round(performance.now() - startTime),
    });

    return new Response(
      JSON.stringify({
        message: "Email sent successfully",
        email_id: data.id,
        type: isDeleted ? "goodbye" : "welcome",
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Error in resend function:", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error",
        request_id: requestId,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

/**
 * Log email events for audit trail
 */
async function logEmailEvent(
  supabase: ReturnType<typeof createClient>,
  event: {
    event_type: string;
    target_email: string;
    email_type: string;
    error?: string;
    resend_id?: string;
    request_id: string;
    duration_ms: number;
  }
): Promise<void> {
  try {
    await supabase.from("audit.vault_access_log").insert({
      user_id: null,
      secret_name: "EMAIL_EVENT",
      access_result: event.event_type,
      ip_address: "internal",
      user_agent: "resend-function",
      request_id: event.request_id,
      additional_info: {
        target_email: event.target_email,
        email_type: event.email_type,
        resend_id: event.resend_id,
        error: event.error,
        duration_ms: event.duration_ms,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (logError) {
    console.error("Failed to log email event:", logError);
    // Don't throw - logging failure shouldn't break email sending
  }
}
