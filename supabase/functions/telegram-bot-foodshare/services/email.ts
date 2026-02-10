/**
 * Email service for sending verification emails
 */

import { logger } from "../../_shared/logger.ts";
import { SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL } from "../config/index.ts";

export async function sendVerificationEmail(email: string, code: string): Promise<boolean> {
  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/resend`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        to: email,
        subject: "FoodShare - Verify Your Email",
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #22c55e;">🍎 FoodShare Email Verification</h2>
            <p>Your verification code is:</p>
            <div style="background: #f3f4f6; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0;">
              <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #22c55e;">${code}</span>
            </div>
            <p>Enter this code in Telegram to verify your email.</p>
            <p style="color: #6b7280; font-size: 14px;">This code expires in 15 minutes.</p>
            <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
            <p style="color: #9ca3af; font-size: 12px;">If you didn't request this, please ignore this email.</p>
          </div>
        `,
      }),
    });

    return response.ok;
  } catch (error) {
    logger.error("Failed to send verification email", { error: String(error) });
    return false;
  }
}
