/**
 * Apple Sign-In Handler
 *
 * Implements custom Apple OAuth verification to avoid redundancy in GoTrue .env.
 * Consumes secrets directly from the Supabase Vault.
 */

import { logger } from "../../_shared/logger.ts";
import { getSecret } from "../../_shared/vault.ts";
import { AppError } from "../../_shared/errors.ts";
import { AuthContext } from "./types.ts";
import { appleSignInSchema } from "./schemas.ts";
import * as jose from "jose";

/**
 * Handle Apple Sign-In
 */
export async function handleAppleSignIn(
  body: unknown,
  ctx: AuthContext,
): Promise<Response> {
  const { corsHeaders, supabase } = ctx;

  // 1. Validate body
  const parsed = appleSignInSchema.parse(body);
  const { identityToken, email: providedEmail, firstName, lastName } = parsed;

  try {
    // 2. Fetch Apple secrets from Vault
    const appleClientId = await getSecret("GOTRUE_EXTERNAL_APPLE_CLIENT_ID");

    if (!appleClientId) {
      throw new AppError("Apple auth is not configured", "AUTH_NOT_CONFIGURED", 500);
    }

    // 3. Verify Apple Token
    // We fetch Apple's public keys
    const JWKS = jose.createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));

    const { payload } = await jose.jwtVerify(identityToken, JWKS, {
      issuer: "https://appleid.apple.com",
      audience: appleClientId,
    });

    const appleSub = payload.sub as string;
    const appleEmail = (payload.email as string) || providedEmail;

    if (!appleSub) {
      throw new AppError("Invalid Apple token: missing sub", "INVALID_TOKEN", 400);
    }

    logger.info("Apple token verified", { sub: appleSub, email: appleEmail });

    // 4. Find or Create User in auth.users
    // We use the admin client (which is already in ctx.supabase as it's the Service Role client)

    // Check if user already exists by apple sub (stored in raw_user_meta_data)
    const { data: user, error: _userError } = await supabase.auth.admin.listUsers();

    // Optimization: In a real production DB with many users, we should use a custom SQL query
    // to search raw_user_meta_data or use a mapping table.
    // For now, we search existing users.

    let existingUser = (user?.users || []).find((u) =>
      u.raw_user_meta_data?.sub === appleSub || u.email === appleEmail
    );

    if (!existingUser) {
      logger.info("Creating new user for Apple Sign-In", { email: appleEmail });
      const { data: newUser, error: createError } = await supabase.auth.admin.createUser({
        email: appleEmail,
        email_confirm: true,
        user_metadata: {
          sub: appleSub,
          full_name: firstName && lastName ? `${firstName} ${lastName}` : firstName || "",
          provider: "apple",
          providers: ["apple"],
        },
      });

      if (createError) {
        throw new AppError(
          `Failed to create user: ${createError.message}`,
          "AUTH_CREATE_FAILED",
          500,
        );
      }
      existingUser = newUser.user;
    } else {
      // Update provider if missing
      const providers = existingUser.raw_user_meta_data?.providers || [];
      if (!providers.includes("apple")) {
        await supabase.auth.admin.updateUserById(existingUser.id, {
          user_metadata: {
            ...existingUser.raw_user_meta_data,
            sub: appleSub,
            providers: [...providers, "apple"],
          },
        });
      }
    }

    if (!existingUser) {
      throw new AppError("User not found or created", "AUTH_FAILED", 500);
    }

    // 5. Generate Supabase Session JWT
    // This is the "Magic" part. We generate a token that looks like a GoTrue token.
    const jwtSecret = await getSecret("JWT_SECRET");
    if (!jwtSecret) {
      throw new AppError("Internal security error", "INTERNAL_ERROR", 500);
    }

    const secret = new TextEncoder().encode(jwtSecret);
    const now = Math.floor(Date.now() / 1000);

    const sessionToken = await new jose.SignJWT({
      aud: "authenticated",
      sub: existingUser.id,
      email: existingUser.email,
      phone: existingUser.phone,
      app_metadata: existingUser.app_metadata || { provider: "email", providers: ["email"] },
      user_metadata: existingUser.raw_user_meta_data || {},
      role: "authenticated",
      session_id: crypto.randomUUID(),
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt(now)
      .setExpirationTime(now + 3600 * 24 * 7) // 1 week
      .sign(secret);

    // 6. Return Session response
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          access_token: sessionToken,
          token_type: "bearer",
          expires_in: 3600 * 24 * 7,
          refresh_token: "manual_flow_no_refresh_yet", // We can implement refresh tokens later
          user: {
            id: existingUser.id,
            email: existingUser.email,
            user_metadata: existingUser.raw_user_meta_data,
          },
        },
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    logger.error("Apple Sign-In failed", error instanceof Error ? error : new Error(String(error)));

    if (error instanceof AppError) {
      return new Response(JSON.stringify({ success: false, error: error.message }), {
        status: error.statusCode,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: false, error: "Authentication failed" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}
