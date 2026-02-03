-- Migration: Update all email templates with full beautiful footer
-- This adds the complete FoodShare footer matching the enterprise design system

-- ============================================================================
-- Helper: Full Footer HTML (to be used in all templates)
-- ============================================================================
-- The full footer includes:
-- 1. Social links (Facebook, X, Instagram, LinkedIn)
-- 2. Divider line
-- 3. Footer logo (small)
-- 4. Company info (name, EIN, address)
-- 5. Contact email
-- 6. Footer links (Visit Us, Privacy, Terms)

-- ============================================================================
-- 1. Update Welcome Email
-- ============================================================================
UPDATE email_templates SET html_content = '<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to FoodShare!</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, ''Segoe UI'', Roboto, ''Helvetica Neue'', Arial, sans-serif; background-color: #f0f0f0; color: #363a57;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background: linear-gradient(135deg, #f0f0f0 0%, #e5e5e5 100%); padding: 60px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; background-color: #ffffff; border-radius: 16px; box-shadow: 0 10px 40px rgba(255, 45, 85, 0.2); overflow: hidden;">
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff5177 50%, #ff6b8a 100%); padding: 50px 30px; text-align: center;">
              <img src="https://***REMOVED***/storage/v1/object/public/assets/logo-512.png" alt="FoodShare Logo" style="width: 100px; height: 100px; border-radius: 50%; margin-bottom: 24px; border: 5px solid rgba(255, 255, 255, 0.4); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); background: white; padding: 4px;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 800; text-shadow: 0 2px 12px rgba(0, 0, 0, 0.25); letter-spacing: -0.5px;">Welcome to FoodShare! 🎉</h1>
              <p style="margin: 12px 0 0; color: rgba(255, 255, 255, 0.95); font-size: 16px; font-weight: 500; text-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);">Your journey to reducing food waste starts now</p>
            </td>
          </tr>
          <!-- Content -->
          <tr>
            <td style="padding: 50px 40px; background-color: #fafafa;">
              <div style="background: white; padding: 30px; border-radius: 12px; border: 2px solid #f0f0f0; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);">
                <p style="margin: 0 0 20px; font-size: 17px; line-height: 1.7; color: #363a57;">Hey <strong>{{name}}</strong>! 👋</p>
                <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.7; color: #555;">We''re thrilled to have you join the <strong style="color: #ff2d55;">FoodShare</strong> community! Get ready to embark on a journey of delicious discoveries and meaningful connections.</p>
                <p style="margin: 0 0 16px; font-size: 16px; line-height: 1.7; color: #555;"><strong>🌱 Here''s what you can do:</strong></p>
                <ul style="margin: 0 0 24px; padding-left: 24px; font-size: 15px; line-height: 2; color: #555;">
                  <li><strong style="color: #ff2d55;">🍎 Share Surplus Food</strong> – Post your extra groceries for neighbors</li>
                  <li><strong style="color: #00A699;">🗺️ Discover Food Near You</strong> – Browse the map to find available food</li>
                  <li><strong style="color: #FC642D;">💬 Connect & Chat</strong> – Message members to coordinate pickups</li>
                  <li><strong style="color: #8B5CF6;">🏆 Join Challenges</strong> – Participate in community challenges</li>
                </ul>
                <div style="margin: 24px 0 0; padding: 20px; background: linear-gradient(135deg, #f8f8f8 0%, #f3f3f3 100%); border-radius: 8px; border-left: 4px solid #ff2d55;">
                  <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #666;"><strong style="color: #ff2d55;">✨ Your Impact Matters</strong><br>Together, we''re reducing food waste and building stronger communities. Every meal shared makes a difference!</p>
                </div>
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td align="center" style="padding: 24px 0 10px;">
                      <a href="https://foodshare.club/products" style="display: inline-block; padding: 18px 48px; background: linear-gradient(135deg, #ff2d55 0%, #ff4873 50%, #ff5e8a 100%); color: #ffffff; text-decoration: none; border-radius: 50px; font-weight: 700; font-size: 16px; box-shadow: 0 6px 24px rgba(255, 45, 85, 0.35), 0 2px 8px rgba(255, 45, 85, 0.2); text-transform: uppercase; letter-spacing: 1px; border: 2px solid rgba(255, 255, 255, 0.3);">🚀 GET STARTED</a>
                    </td>
                  </tr>
                </table>
              </div>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff4270 100%); padding: 40px 30px; text-align: center;">
              <p style="margin: 0 0 10px; font-size: 15px; color: rgba(255, 255, 255, 0.9); font-weight: 600; text-transform: uppercase; letter-spacing: 1px;">Connect With Us</p>
              <table width="100%" cellpadding="0" cellspacing="0" style="margin: 15px 0 25px;">
                <tr>
                  <td align="center">
                    <a href="https://facebook.com/foodshareclub" style="display: inline-block; margin: 0 6px; width: 48px; height: 48px; background: rgba(255, 255, 255, 0.25); border-radius: 50%; line-height: 48px; text-align: center; text-decoration: none; border: 2px solid rgba(255, 255, 255, 0.4);"><strong style="font-size: 24px; color: #ffffff; font-family: Georgia, serif;">f</strong></a>
                    <a href="https://twitter.com/foodshareclub" style="display: inline-block; margin: 0 6px; width: 48px; height: 48px; background: rgba(255, 255, 255, 0.25); border-radius: 50%; line-height: 48px; text-align: center; text-decoration: none; border: 2px solid rgba(255, 255, 255, 0.4);"><strong style="font-size: 20px; color: #ffffff;">𝕏</strong></a>
                    <a href="https://instagram.com/foodshareclub" style="display: inline-block; margin: 0 6px; width: 48px; height: 48px; background: rgba(255, 255, 255, 0.25); border-radius: 50%; line-height: 48px; text-align: center; text-decoration: none; border: 2px solid rgba(255, 255, 255, 0.4);"><strong style="font-size: 22px; color: #ffffff; font-family: Arial, sans-serif; font-weight: 900;">IG</strong></a>
                    <a href="https://linkedin.com/company/foodshareclub" style="display: inline-block; margin: 0 6px; width: 48px; height: 48px; background: rgba(255, 255, 255, 0.25); border-radius: 50%; line-height: 48px; text-align: center; text-decoration: none; border: 2px solid rgba(255, 255, 255, 0.4);"><strong style="font-size: 22px; color: #ffffff; font-family: Arial, sans-serif; font-weight: 700;">in</strong></a>
                  </td>
                </tr>
              </table>
              <div style="height: 1px; background: rgba(255, 255, 255, 0.3); margin: 25px auto; max-width: 400px;"></div>
              <img src="https://***REMOVED***/storage/v1/object/public/assets/logo-512.png" alt="FoodShare" style="width: 45px; height: 45px; border-radius: 50%; margin: 15px 0 10px; border: 3px solid rgba(255, 255, 255, 0.4); background: white; padding: 2px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);">
              <p style="margin: 12px 0 0; font-size: 16px; line-height: 1.5; color: #ffffff; font-weight: 700;">FoodShare LLC</p>
              <p style="margin: 8px 0 0; font-size: 13px; line-height: 1.5; color: rgba(255, 255, 255, 0.9);">© 2026 USA 20231394981<br>All Rights Reserved</p>
              <p style="margin: 12px 0 0; font-size: 14px; line-height: 1.6; color: rgba(255, 255, 255, 0.9);">📍 4632 Winding Way<br>Sacramento, CA 95841</p>
              <p style="margin: 20px 0 0; font-size: 14px; color: rgba(255, 255, 255, 0.95);">💬 Questions? <a href="mailto:support@foodshare.club" style="color: #ffffff; text-decoration: none; font-weight: 700; border-bottom: 2px solid rgba(255, 255, 255, 0.5);">support@foodshare.club</a></p>
              <p style="margin: 25px 0 0; font-size: 13px; color: rgba(255, 255, 255, 0.9); line-height: 2;">
                <a href="https://foodshare.club" style="color: #ffffff; text-decoration: none; margin: 0 8px; padding: 8px 16px; background: rgba(255, 255, 255, 0.15); border-radius: 20px; display: inline-block; font-weight: 600;">🏠 Visit Us</a>
                <a href="https://foodshare.club/privacy" style="color: #ffffff; text-decoration: none; margin: 0 8px; padding: 8px 16px; background: rgba(255, 255, 255, 0.15); border-radius: 20px; display: inline-block; font-weight: 600;">🔒 Privacy</a>
                <a href="https://foodshare.club/terms" style="color: #ffffff; text-decoration: none; margin: 0 8px; padding: 8px 16px; background: rgba(255, 255, 255, 0.15); border-radius: 20px; display: inline-block; font-weight: 600;">📋 Terms</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>',
updated_at = NOW()
WHERE slug = 'welcome';

-- ============================================================================
-- 2. Update Email Verification
-- ============================================================================
UPDATE email_templates SET html_content = '<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verify Your Email</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, ''Segoe UI'', Roboto, ''Helvetica Neue'', Arial, sans-serif; background-color: #f0f0f0; color: #363a57;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background: linear-gradient(135deg, #f0f0f0 0%, #e5e5e5 100%); padding: 60px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; background-color: #ffffff; border-radius: 16px; box-shadow: 0 10px 40px rgba(255, 45, 85, 0.2); overflow: hidden;">
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff5177 50%, #ff6b8a 100%); padding: 50px 30px; text-align: center;">
              <img src="https://***REMOVED***/storage/v1/object/public/assets/logo-512.png" alt="FoodShare Logo" style="width: 100px; height: 100px; border-radius: 50%; margin-bottom: 24px; border: 5px solid rgba(255, 255, 255, 0.4); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); background: white; padding: 4px;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 800; text-shadow: 0 2px 12px rgba(0, 0, 0, 0.25); letter-spacing: -0.5px;">Welcome to FoodShare! 🎉</h1>
              <p style="margin: 12px 0 0; color: rgba(255, 255, 255, 0.95); font-size: 16px; font-weight: 500; text-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);">Let''s confirm your email to get started</p>
            </td>
          </tr>
          <!-- Content -->
          <tr>
            <td style="padding: 50px 40px; background-color: #fafafa;">
              <div style="background: white; padding: 30px; border-radius: 12px; border: 2px solid #f0f0f0; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);">
                <p style="margin: 0 0 20px; font-size: 17px; line-height: 1.7; color: #363a57;">Thanks for signing up for <strong style="color: #ff2d55;">FoodShare</strong>! 🥗</p>
                <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.7; color: #555;">We''re excited to have you join our community dedicated to reducing food waste and sharing delicious meals. To complete your registration and start making a difference, please confirm your email address below:</p>
                <div style="margin: 24px 0 0; padding: 20px; background: linear-gradient(135deg, #f8f8f8 0%, #f3f3f3 100%); border-radius: 8px; border-left: 4px solid #ff2d55;">
                  <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #666;"><strong style="color: #ff2d55;">✨ What happens next?</strong><br>Once confirmed, your email will be uniquely associated with your account, and you''ll gain full access to share and discover food in your community.</p>
                </div>
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td align="center" style="padding: 24px 0 10px;">
                      <a href="{{verifyUrl}}" style="display: inline-block; padding: 18px 48px; background: linear-gradient(135deg, #ff2d55 0%, #ff4873 50%, #ff5e8a 100%); color: #ffffff; text-decoration: none; border-radius: 50px; font-weight: 700; font-size: 16px; box-shadow: 0 6px 24px rgba(255, 45, 85, 0.35), 0 2px 8px rgba(255, 45, 85, 0.2); text-transform: uppercase; letter-spacing: 1px; border: 2px solid rgba(255, 255, 255, 0.3);">✓ CONFIRM YOUR EMAIL</a>
                    </td>
                  </tr>
                </table>
                <div style="margin: 30px 0 0; font-size: 14px; line-height: 1.6; color: #999; text-align: center; padding: 20px; background-color: #fafafa; border-radius: 8px; border: 1px dashed #e0e0e0;">
                  <strong style="color: #666;">Didn''t sign up?</strong><br>If you didn''t register with FoodShare, you can safely ignore this email.
                </div>
              </div>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff4270 100%); padding: 40px 30px; text-align: center;">
              <p style="margin: 0 0 10px; font-size: 15px; color: rgba(255, 255, 255, 0.9); font-weight: 600; text-transform: uppercase; letter-spacing: 1px;">Connect With Us</p>
              <table width="100%" cellpadding="0" cellspacing="0" style="margin: 15px 0 25px;">
                <tr>
                  <td align="center">
                    <a href="https://facebook.com/foodshareclub" style="display: inline-block; margin: 0 6px; width: 48px; height: 48px; background: rgba(255, 255, 255, 0.25); border-radius: 50%; line-height: 48px; text-align: center; text-decoration: none; border: 2px solid rgba(255, 255, 255, 0.4);"><strong style="font-size: 24px; color: #ffffff; font-family: Georgia, serif;">f</strong></a>
                    <a href="https://twitter.com/foodshareclub" style="display: inline-block; margin: 0 6px; width: 48px; height: 48px; background: rgba(255, 255, 255, 0.25); border-radius: 50%; line-height: 48px; text-align: center; text-decoration: none; border: 2px solid rgba(255, 255, 255, 0.4);"><strong style="font-size: 20px; color: #ffffff;">𝕏</strong></a>
                    <a href="https://instagram.com/foodshareclub" style="display: inline-block; margin: 0 6px; width: 48px; height: 48px; background: rgba(255, 255, 255, 0.25); border-radius: 50%; line-height: 48px; text-align: center; text-decoration: none; border: 2px solid rgba(255, 255, 255, 0.4);"><strong style="font-size: 22px; color: #ffffff; font-family: Arial, sans-serif; font-weight: 900;">IG</strong></a>
                    <a href="https://linkedin.com/company/foodshareclub" style="display: inline-block; margin: 0 6px; width: 48px; height: 48px; background: rgba(255, 255, 255, 0.25); border-radius: 50%; line-height: 48px; text-align: center; text-decoration: none; border: 2px solid rgba(255, 255, 255, 0.4);"><strong style="font-size: 22px; color: #ffffff; font-family: Arial, sans-serif; font-weight: 700;">in</strong></a>
                  </td>
                </tr>
              </table>
              <div style="height: 1px; background: rgba(255, 255, 255, 0.3); margin: 25px auto; max-width: 400px;"></div>
              <img src="https://***REMOVED***/storage/v1/object/public/assets/logo-512.png" alt="FoodShare" style="width: 45px; height: 45px; border-radius: 50%; margin: 15px 0 10px; border: 3px solid rgba(255, 255, 255, 0.4); background: white; padding: 2px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);">
              <p style="margin: 12px 0 0; font-size: 16px; line-height: 1.5; color: #ffffff; font-weight: 700;">FoodShare LLC</p>
              <p style="margin: 8px 0 0; font-size: 13px; line-height: 1.5; color: rgba(255, 255, 255, 0.9);">© 2026 USA 20231394981<br>All Rights Reserved</p>
              <p style="margin: 12px 0 0; font-size: 14px; line-height: 1.6; color: rgba(255, 255, 255, 0.9);">📍 4632 Winding Way<br>Sacramento, CA 95841</p>
              <p style="margin: 20px 0 0; font-size: 14px; color: rgba(255, 255, 255, 0.95);">💬 Questions? <a href="mailto:support@foodshare.club" style="color: #ffffff; text-decoration: none; font-weight: 700; border-bottom: 2px solid rgba(255, 255, 255, 0.5);">support@foodshare.club</a></p>
              <p style="margin: 25px 0 0; font-size: 13px; color: rgba(255, 255, 255, 0.9); line-height: 2;">
                <a href="https://foodshare.club" style="color: #ffffff; text-decoration: none; margin: 0 8px; padding: 8px 16px; background: rgba(255, 255, 255, 0.15); border-radius: 20px; display: inline-block; font-weight: 600;">🏠 Visit Us</a>
                <a href="https://foodshare.club/privacy" style="color: #ffffff; text-decoration: none; margin: 0 8px; padding: 8px 16px; background: rgba(255, 255, 255, 0.15); border-radius: 20px; display: inline-block; font-weight: 600;">🔒 Privacy</a>
                <a href="https://foodshare.club/terms" style="color: #ffffff; text-decoration: none; margin: 0 8px; padding: 8px 16px; background: rgba(255, 255, 255, 0.15); border-radius: 20px; display: inline-block; font-weight: 600;">📋 Terms</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>',
updated_at = NOW()
WHERE slug = 'email-verification';

-- ============================================================================
-- 3. Update Password Reset
-- ============================================================================
UPDATE email_templates SET html_content = '<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset Your Password</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, ''Segoe UI'', Roboto, ''Helvetica Neue'', Arial, sans-serif; background-color: #f0f0f0; color: #363a57;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background: linear-gradient(135deg, #f0f0f0 0%, #e5e5e5 100%); padding: 60px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; background-color: #ffffff; border-radius: 16px; box-shadow: 0 10px 40px rgba(255, 45, 85, 0.2); overflow: hidden;">
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff5177 50%, #ff6b8a 100%); padding: 50px 30px; text-align: center;">
              <img src="https://***REMOVED***/storage/v1/object/public/assets/logo-512.png" alt="FoodShare Logo" style="width: 100px; height: 100px; border-radius: 50%; margin-bottom: 24px; border: 5px solid rgba(255, 255, 255, 0.4); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); background: white; padding: 4px;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 800; text-shadow: 0 2px 12px rgba(0, 0, 0, 0.25); letter-spacing: -0.5px;">Reset Your Password 🔐</h1>
              <p style="margin: 12px 0 0; color: rgba(255, 255, 255, 0.95); font-size: 16px; font-weight: 500; text-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);">Let''s get you back into your account</p>
            </td>
          </tr>
          <!-- Content -->
          <tr>
            <td style="padding: 50px 40px; background-color: #fafafa;">
              <div style="background: white; padding: 30px; border-radius: 12px; border: 2px solid #f0f0f0; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);">
                <p style="margin: 0 0 20px; font-size: 17px; line-height: 1.7; color: #363a57;">Hey <strong>{{name}}</strong>,</p>
                <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.7; color: #555;">We received a request to reset your password. Click the button below to create a new password:</p>
                <div style="margin: 24px 0 0; padding: 20px; background: linear-gradient(135deg, #f8f8f8 0%, #f3f3f3 100%); border-radius: 8px; border-left: 4px solid #ff2d55;">
                  <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #666;"><strong style="color: #ff2d55;">⏰ Time Sensitive</strong><br>This link will expire in <strong>{{expiresIn}}</strong>. If you didn''t request this, you can safely ignore this email.</p>
                </div>
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td align="center" style="padding: 24px 0 10px;">
                      <a href="{{resetUrl}}" style="display: inline-block; padding: 18px 48px; background: linear-gradient(135deg, #ff2d55 0%, #ff4873 50%, #ff5e8a 100%); color: #ffffff; text-decoration: none; border-radius: 50px; font-weight: 700; font-size: 16px; box-shadow: 0 6px 24px rgba(255, 45, 85, 0.35), 0 2px 8px rgba(255, 45, 85, 0.2); text-transform: uppercase; letter-spacing: 1px; border: 2px solid rgba(255, 255, 255, 0.3);">🔑 RESET PASSWORD</a>
                    </td>
                  </tr>
                </table>
                <div style="margin: 30px 0 0; font-size: 14px; line-height: 1.6; color: #999; text-align: center; padding: 20px; background-color: #fafafa; border-radius: 8px; border: 1px dashed #e0e0e0;">
                  <strong style="color: #666;">Didn''t request this?</strong><br>If you didn''t request a password reset, your account is still secure. No action is needed.
                </div>
              </div>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff4270 100%); padding: 40px 30px; text-align: center;">
              <p style="margin: 0 0 10px; font-size: 15px; color: rgba(255, 255, 255, 0.9); font-weight: 600; text-transform: uppercase; letter-spacing: 1px;">Connect With Us</p>
              <table width="100%" cellpadding="0" cellspacing="0" style="margin: 15px 0 25px;">
                <tr>
                  <td align="center">
                    <a href="https://facebook.com/foodshareclub" style="display: inline-block; margin: 0 6px; width: 48px; height: 48px; background: rgba(255, 255, 255, 0.25); border-radius: 50%; line-height: 48px; text-align: center; text-decoration: none; border: 2px solid rgba(255, 255, 255, 0.4);"><strong style="font-size: 24px; color: #ffffff; font-family: Georgia, serif;">f</strong></a>
                    <a href="https://twitter.com/foodshareclub" style="display: inline-block; margin: 0 6px; width: 48px; height: 48px; background: rgba(255, 255, 255, 0.25); border-radius: 50%; line-height: 48px; text-align: center; text-decoration: none; border: 2px solid rgba(255, 255, 255, 0.4);"><strong style="font-size: 20px; color: #ffffff;">𝕏</strong></a>
                    <a href="https://instagram.com/foodshareclub" style="display: inline-block; margin: 0 6px; width: 48px; height: 48px; background: rgba(255, 255, 255, 0.25); border-radius: 50%; line-height: 48px; text-align: center; text-decoration: none; border: 2px solid rgba(255, 255, 255, 0.4);"><strong style="font-size: 22px; color: #ffffff; font-family: Arial, sans-serif; font-weight: 900;">IG</strong></a>
                    <a href="https://linkedin.com/company/foodshareclub" style="display: inline-block; margin: 0 6px; width: 48px; height: 48px; background: rgba(255, 255, 255, 0.25); border-radius: 50%; line-height: 48px; text-align: center; text-decoration: none; border: 2px solid rgba(255, 255, 255, 0.4);"><strong style="font-size: 22px; color: #ffffff; font-family: Arial, sans-serif; font-weight: 700;">in</strong></a>
                  </td>
                </tr>
              </table>
              <div style="height: 1px; background: rgba(255, 255, 255, 0.3); margin: 25px auto; max-width: 400px;"></div>
              <img src="https://***REMOVED***/storage/v1/object/public/assets/logo-512.png" alt="FoodShare" style="width: 45px; height: 45px; border-radius: 50%; margin: 15px 0 10px; border: 3px solid rgba(255, 255, 255, 0.4); background: white; padding: 2px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);">
              <p style="margin: 12px 0 0; font-size: 16px; line-height: 1.5; color: #ffffff; font-weight: 700;">FoodShare LLC</p>
              <p style="margin: 8px 0 0; font-size: 13px; line-height: 1.5; color: rgba(255, 255, 255, 0.9);">© 2026 USA 20231394981<br>All Rights Reserved</p>
              <p style="margin: 12px 0 0; font-size: 14px; line-height: 1.6; color: rgba(255, 255, 255, 0.9);">📍 4632 Winding Way<br>Sacramento, CA 95841</p>
              <p style="margin: 20px 0 0; font-size: 14px; color: rgba(255, 255, 255, 0.95);">💬 Questions? <a href="mailto:support@foodshare.club" style="color: #ffffff; text-decoration: none; font-weight: 700; border-bottom: 2px solid rgba(255, 255, 255, 0.5);">support@foodshare.club</a></p>
              <p style="margin: 25px 0 0; font-size: 13px; color: rgba(255, 255, 255, 0.9); line-height: 2;">
                <a href="https://foodshare.club" style="color: #ffffff; text-decoration: none; margin: 0 8px; padding: 8px 16px; background: rgba(255, 255, 255, 0.15); border-radius: 20px; display: inline-block; font-weight: 600;">🏠 Visit Us</a>
                <a href="https://foodshare.club/privacy" style="color: #ffffff; text-decoration: none; margin: 0 8px; padding: 8px 16px; background: rgba(255, 255, 255, 0.15); border-radius: 20px; display: inline-block; font-weight: 600;">🔒 Privacy</a>
                <a href="https://foodshare.club/terms" style="color: #ffffff; text-decoration: none; margin: 0 8px; padding: 8px 16px; background: rgba(255, 255, 255, 0.15); border-radius: 20px; display: inline-block; font-weight: 600;">📋 Terms</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>',
updated_at = NOW()
WHERE slug = 'password-reset';

-- ============================================================================
-- 4. Update Chat Notification
-- ============================================================================
UPDATE email_templates SET html_content = '<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>New Message</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, ''Segoe UI'', Roboto, ''Helvetica Neue'', Arial, sans-serif; background-color: #f0f0f0; color: #363a57;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background: linear-gradient(135deg, #f0f0f0 0%, #e5e5e5 100%); padding: 60px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; background-color: #ffffff; border-radius: 16px; box-shadow: 0 10px 40px rgba(255, 45, 85, 0.2); overflow: hidden;">
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff5177 50%, #ff6b8a 100%); padding: 50px 30px; text-align: center;">
              <img src="https://***REMOVED***/storage/v1/object/public/assets/logo-512.png" alt="FoodShare Logo" style="width: 100px; height: 100px; border-radius: 50%; margin-bottom: 24px; border: 5px solid rgba(255, 255, 255, 0.4); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); background: white; padding: 4px;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 800; text-shadow: 0 2px 12px rgba(0, 0, 0, 0.25); letter-spacing: -0.5px;">You''ve Got a Message! 💬</h1>
              <p style="margin: 12px 0 0; color: rgba(255, 255, 255, 0.95); font-size: 16px; font-weight: 500; text-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);">{{senderName}} sent you a message</p>
            </td>
          </tr>
          <!-- Content -->
          <tr>
            <td style="padding: 50px 40px; background-color: #fafafa;">
              <div style="background: white; padding: 30px; border-radius: 12px; border: 2px solid #f0f0f0; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);">
                <p style="margin: 0 0 20px; font-size: 17px; line-height: 1.7; color: #363a57;">Hey <strong>{{recipientName}}</strong>! 👋</p>
                <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.7; color: #555;">You have a new message from <strong style="color: #ff2d55;">{{senderName}}</strong>:</p>
                <div style="background: linear-gradient(135deg, #f8f8f8 0%, #f3f3f3 100%); border-radius: 12px; padding: 24px; margin: 0 0 24px; border-left: 4px solid #ff2d55;">
                  <p style="margin: 0; font-size: 16px; line-height: 1.7; color: #555; font-style: italic;">"{{messagePreview}}"</p>
                </div>
                <p style="margin: 0; font-size: 16px; line-height: 1.7; color: #555;">Reply now to continue the conversation! 💬</p>
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td align="center" style="padding: 24px 0 10px;">
                      <a href="{{chatUrl}}" style="display: inline-block; padding: 18px 48px; background: linear-gradient(135deg, #ff2d55 0%, #ff4873 50%, #ff5e8a 100%); color: #ffffff; text-decoration: none; border-radius: 50px; font-weight: 700; font-size: 16px; box-shadow: 0 6px 24px rgba(255, 45, 85, 0.35), 0 2px 8px rgba(255, 45, 85, 0.2); text-transform: uppercase; letter-spacing: 1px; border: 2px solid rgba(255, 255, 255, 0.3);">💬 REPLY NOW</a>
                    </td>
                  </tr>
                </table>
              </div>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff4270 100%); padding: 40px 30px; text-align: center;">
              <p style="margin: 0 0 10px; font-size: 15px; color: rgba(255, 255, 255, 0.9); font-weight: 600; text-transform: uppercase; letter-spacing: 1px;">Connect With Us</p>
              <table width="100%" cellpadding="0" cellspacing="0" style="margin: 15px 0 25px;">
                <tr>
                  <td align="center">
                    <a href="https://facebook.com/foodshareclub" style="display: inline-block; margin: 0 6px; width: 48px; height: 48px; background: rgba(255, 255, 255, 0.25); border-radius: 50%; line-height: 48px; text-align: center; text-decoration: none; border: 2px solid rgba(255, 255, 255, 0.4);"><strong style="font-size: 24px; color: #ffffff; font-family: Georgia, serif;">f</strong></a>
                    <a href="https://twitter.com/foodshareclub" style="display: inline-block; margin: 0 6px; width: 48px; height: 48px; background: rgba(255, 255, 255, 0.25); border-radius: 50%; line-height: 48px; text-align: center; text-decoration: none; border: 2px solid rgba(255, 255, 255, 0.4);"><strong style="font-size: 20px; color: #ffffff;">𝕏</strong></a>
                    <a href="https://instagram.com/foodshareclub" style="display: inline-block; margin: 0 6px; width: 48px; height: 48px; background: rgba(255, 255, 255, 0.25); border-radius: 50%; line-height: 48px; text-align: center; text-decoration: none; border: 2px solid rgba(255, 255, 255, 0.4);"><strong style="font-size: 22px; color: #ffffff; font-family: Arial, sans-serif; font-weight: 900;">IG</strong></a>
                    <a href="https://linkedin.com/company/foodshareclub" style="display: inline-block; margin: 0 6px; width: 48px; height: 48px; background: rgba(255, 255, 255, 0.25); border-radius: 50%; line-height: 48px; text-align: center; text-decoration: none; border: 2px solid rgba(255, 255, 255, 0.4);"><strong style="font-size: 22px; color: #ffffff; font-family: Arial, sans-serif; font-weight: 700;">in</strong></a>
                  </td>
                </tr>
              </table>
              <div style="height: 1px; background: rgba(255, 255, 255, 0.3); margin: 25px auto; max-width: 400px;"></div>
              <img src="https://***REMOVED***/storage/v1/object/public/assets/logo-512.png" alt="FoodShare" style="width: 45px; height: 45px; border-radius: 50%; margin: 15px 0 10px; border: 3px solid rgba(255, 255, 255, 0.4); background: white; padding: 2px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);">
              <p style="margin: 12px 0 0; font-size: 16px; line-height: 1.5; color: #ffffff; font-weight: 700;">FoodShare LLC</p>
              <p style="margin: 8px 0 0; font-size: 13px; line-height: 1.5; color: rgba(255, 255, 255, 0.9);">© 2026 USA 20231394981<br>All Rights Reserved</p>
              <p style="margin: 12px 0 0; font-size: 14px; line-height: 1.6; color: rgba(255, 255, 255, 0.9);">📍 4632 Winding Way<br>Sacramento, CA 95841</p>
              <p style="margin: 20px 0 0; font-size: 14px; color: rgba(255, 255, 255, 0.95);">💬 Questions? <a href="mailto:support@foodshare.club" style="color: #ffffff; text-decoration: none; font-weight: 700; border-bottom: 2px solid rgba(255, 255, 255, 0.5);">support@foodshare.club</a></p>
              <p style="margin: 25px 0 0; font-size: 13px; color: rgba(255, 255, 255, 0.9); line-height: 2;">
                <a href="https://foodshare.club" style="color: #ffffff; text-decoration: none; margin: 0 8px; padding: 8px 16px; background: rgba(255, 255, 255, 0.15); border-radius: 20px; display: inline-block; font-weight: 600;">🏠 Visit Us</a>
                <a href="https://foodshare.club/privacy" style="color: #ffffff; text-decoration: none; margin: 0 8px; padding: 8px 16px; background: rgba(255, 255, 255, 0.15); border-radius: 20px; display: inline-block; font-weight: 600;">🔒 Privacy</a>
                <a href="https://foodshare.club/terms" style="color: #ffffff; text-decoration: none; margin: 0 8px; padding: 8px 16px; background: rgba(255, 255, 255, 0.15); border-radius: 20px; display: inline-block; font-weight: 600;">📋 Terms</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>',
updated_at = NOW()
WHERE slug = 'chat-notification';

-- ============================================================================
-- 5. Update New Listing Nearby
-- ============================================================================
UPDATE email_templates SET html_content = '<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>New Listing Near You</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, ''Segoe UI'', Roboto, ''Helvetica Neue'', Arial, sans-serif; background-color: #f0f0f0; color: #363a57;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background: linear-gradient(135deg, #f0f0f0 0%, #e5e5e5 100%); padding: 60px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; background-color: #ffffff; border-radius: 16px; box-shadow: 0 10px 40px rgba(255, 45, 85, 0.2); overflow: hidden;">
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff5177 50%, #ff6b8a 100%); padding: 50px 30px; text-align: center;">
              <img src="https://***REMOVED***/storage/v1/object/public/assets/logo-512.png" alt="FoodShare Logo" style="width: 100px; height: 100px; border-radius: 50%; margin-bottom: 24px; border: 5px solid rgba(255, 255, 255, 0.4); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); background: white; padding: 4px;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 800; text-shadow: 0 2px 12px rgba(0, 0, 0, 0.25); letter-spacing: -0.5px;">New Listing Near You! 📍</h1>
              <p style="margin: 12px 0 0; color: rgba(255, 255, 255, 0.95); font-size: 16px; font-weight: 500; text-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);">{{listingTitle}} is now available</p>
            </td>
          </tr>
          <!-- Content -->
          <tr>
            <td style="padding: 50px 40px; background-color: #fafafa;">
              <div style="background: white; padding: 30px; border-radius: 12px; border: 2px solid #f0f0f0; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);">
                <p style="margin: 0 0 20px; font-size: 17px; line-height: 1.7; color: #363a57;">Hey <strong>{{recipientName}}</strong>! 👋</p>
                <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.7; color: #555;">Great news! A new {{listingType}} listing is available near you:</p>
                <div style="background: linear-gradient(135deg, #f8f8f8 0%, #f3f3f3 100%); border-radius: 12px; padding: 24px; margin: 0 0 24px; border-left: 4px solid #ff2d55;">
                  <p style="font-size: 20px; font-weight: 700; margin: 0 0 12px; color: #363a57;">{{listingEmoji}} {{listingTitle}}</p>
                  <p style="margin: 0 0 8px; color: #666; font-size: 14px;">📍 {{listingAddress}}</p>
                  <p style="margin: 12px 0 0; font-size: 15px; line-height: 1.6; color: #555;">{{listingDescription}}</p>
                  <p style="margin: 12px 0 0; color: #999; font-size: 14px;">Posted by <strong style="color: #555;">{{posterName}}</strong></p>
                </div>
                <p style="margin: 0; font-size: 16px; line-height: 1.7; color: #555;">Don''t miss out – items go fast! 🏃‍♂️</p>
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td align="center" style="padding: 24px 0 10px;">
                      <a href="{{listingUrl}}" style="display: inline-block; padding: 18px 48px; background: linear-gradient(135deg, #ff2d55 0%, #ff4873 50%, #ff5e8a 100%); color: #ffffff; text-decoration: none; border-radius: 50px; font-weight: 700; font-size: 16px; box-shadow: 0 6px 24px rgba(255, 45, 85, 0.35), 0 2px 8px rgba(255, 45, 85, 0.2); text-transform: uppercase; letter-spacing: 1px; border: 2px solid rgba(255, 255, 255, 0.3);">👀 VIEW LISTING</a>
                    </td>
                  </tr>
                </table>
              </div>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff4270 100%); padding: 40px 30px; text-align: center;">
              <p style="margin: 0 0 10px; font-size: 15px; color: rgba(255, 255, 255, 0.9); font-weight: 600; text-transform: uppercase; letter-spacing: 1px;">Connect With Us</p>
              <table width="100%" cellpadding="0" cellspacing="0" style="margin: 15px 0 25px;">
                <tr>
                  <td align="center">
                    <a href="https://facebook.com/foodshareclub" style="display: inline-block; margin: 0 6px; width: 48px; height: 48px; background: rgba(255, 255, 255, 0.25); border-radius: 50%; line-height: 48px; text-align: center; text-decoration: none; border: 2px solid rgba(255, 255, 255, 0.4);"><strong style="font-size: 24px; color: #ffffff; font-family: Georgia, serif;">f</strong></a>
                    <a href="https://twitter.com/foodshareclub" style="display: inline-block; margin: 0 6px; width: 48px; height: 48px; background: rgba(255, 255, 255, 0.25); border-radius: 50%; line-height: 48px; text-align: center; text-decoration: none; border: 2px solid rgba(255, 255, 255, 0.4);"><strong style="font-size: 20px; color: #ffffff;">𝕏</strong></a>
                    <a href="https://instagram.com/foodshareclub" style="display: inline-block; margin: 0 6px; width: 48px; height: 48px; background: rgba(255, 255, 255, 0.25); border-radius: 50%; line-height: 48px; text-align: center; text-decoration: none; border: 2px solid rgba(255, 255, 255, 0.4);"><strong style="font-size: 22px; color: #ffffff; font-family: Arial, sans-serif; font-weight: 900;">IG</strong></a>
                    <a href="https://linkedin.com/company/foodshareclub" style="display: inline-block; margin: 0 6px; width: 48px; height: 48px; background: rgba(255, 255, 255, 0.25); border-radius: 50%; line-height: 48px; text-align: center; text-decoration: none; border: 2px solid rgba(255, 255, 255, 0.4);"><strong style="font-size: 22px; color: #ffffff; font-family: Arial, sans-serif; font-weight: 700;">in</strong></a>
                  </td>
                </tr>
              </table>
              <div style="height: 1px; background: rgba(255, 255, 255, 0.3); margin: 25px auto; max-width: 400px;"></div>
              <img src="https://***REMOVED***/storage/v1/object/public/assets/logo-512.png" alt="FoodShare" style="width: 45px; height: 45px; border-radius: 50%; margin: 15px 0 10px; border: 3px solid rgba(255, 255, 255, 0.4); background: white; padding: 2px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);">
              <p style="margin: 12px 0 0; font-size: 16px; line-height: 1.5; color: #ffffff; font-weight: 700;">FoodShare LLC</p>
              <p style="margin: 8px 0 0; font-size: 13px; line-height: 1.5; color: rgba(255, 255, 255, 0.9);">© 2026 USA 20231394981<br>All Rights Reserved</p>
              <p style="margin: 12px 0 0; font-size: 14px; line-height: 1.6; color: rgba(255, 255, 255, 0.9);">📍 4632 Winding Way<br>Sacramento, CA 95841</p>
              <p style="margin: 20px 0 0; font-size: 14px; color: rgba(255, 255, 255, 0.95);">💬 Questions? <a href="mailto:support@foodshare.club" style="color: #ffffff; text-decoration: none; font-weight: 700; border-bottom: 2px solid rgba(255, 255, 255, 0.5);">support@foodshare.club</a></p>
              <p style="margin: 25px 0 0; font-size: 13px; color: rgba(255, 255, 255, 0.9); line-height: 2;">
                <a href="https://foodshare.club" style="color: #ffffff; text-decoration: none; margin: 0 8px; padding: 8px 16px; background: rgba(255, 255, 255, 0.15); border-radius: 20px; display: inline-block; font-weight: 600;">🏠 Visit Us</a>
                <a href="https://foodshare.club/privacy" style="color: #ffffff; text-decoration: none; margin: 0 8px; padding: 8px 16px; background: rgba(255, 255, 255, 0.15); border-radius: 20px; display: inline-block; font-weight: 600;">🔒 Privacy</a>
                <a href="https://foodshare.club/terms" style="color: #ffffff; text-decoration: none; margin: 0 8px; padding: 8px 16px; background: rgba(255, 255, 255, 0.15); border-radius: 20px; display: inline-block; font-weight: 600;">📋 Terms</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>',
updated_at = NOW()
WHERE slug = 'new-listing-nearby';

-- ============================================================================
-- 6. Update Feedback Alert
-- ============================================================================
UPDATE email_templates SET html_content = '<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>New Feedback</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, ''Segoe UI'', Roboto, ''Helvetica Neue'', Arial, sans-serif; background-color: #f0f0f0; color: #363a57;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background: linear-gradient(135deg, #f0f0f0 0%, #e5e5e5 100%); padding: 60px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; background-color: #ffffff; border-radius: 16px; box-shadow: 0 10px 40px rgba(255, 45, 85, 0.2); overflow: hidden;">
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff5177 50%, #ff6b8a 100%); padding: 50px 30px; text-align: center;">
              <img src="https://***REMOVED***/storage/v1/object/public/assets/logo-512.png" alt="FoodShare Logo" style="width: 100px; height: 100px; border-radius: 50%; margin-bottom: 24px; border: 5px solid rgba(255, 255, 255, 0.4); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); background: white; padding: 4px;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 800; text-shadow: 0 2px 12px rgba(0, 0, 0, 0.25); letter-spacing: -0.5px;">New Feedback Received</h1>
              <p style="margin: 12px 0 0; color: rgba(255, 255, 255, 0.95); font-size: 16px; font-weight: 500; text-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);">{{feedbackType}} feedback from {{submitterName}}</p>
            </td>
          </tr>
          <!-- Content -->
          <tr>
            <td style="padding: 50px 40px; background-color: #fafafa;">
              <div style="background: white; padding: 30px; border-radius: 12px; border: 2px solid #f0f0f0; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);">
                <p style="margin: 0 0 20px; font-size: 17px; line-height: 1.7; color: #363a57;">New feedback has been submitted:</p>
                <div style="background: linear-gradient(135deg, #f8f8f8 0%, #f3f3f3 100%); border-radius: 12px; padding: 24px; margin: 0 0 24px; border-left: 4px solid #ff2d55;">
                  <p style="margin: 0 0 12px; font-size: 15px; color: #555;"><strong style="color: #363a57;">Type:</strong> {{feedbackEmoji}} {{feedbackType}}</p>
                  <p style="margin: 0 0 12px; font-size: 15px; color: #555;"><strong style="color: #363a57;">Subject:</strong> {{subject}}</p>
                  <p style="margin: 0 0 12px; font-size: 15px; color: #555;"><strong style="color: #363a57;">From:</strong> {{submitterName}} (<a href="mailto:{{submitterEmail}}" style="color: #ff2d55;">{{submitterEmail}}</a>)</p>
                  <p style="margin: 0 0 16px; font-size: 15px; color: #555;"><strong style="color: #363a57;">Submitted:</strong> {{timestamp}}</p>
                  <hr style="border: none; border-top: 1px solid #ddd; margin: 16px 0;">
                  <p style="margin: 0; font-size: 15px; line-height: 1.7; color: #555; white-space: pre-wrap;">{{message}}</p>
                </div>
                <p style="margin: 0; font-size: 13px; color: #999;">Feedback ID: {{feedbackId}}</p>
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td align="center" style="padding: 24px 0 10px;">
                      <a href="https://foodshare.club/admin/feedback" style="display: inline-block; padding: 18px 48px; background: linear-gradient(135deg, #ff2d55 0%, #ff4873 50%, #ff5e8a 100%); color: #ffffff; text-decoration: none; border-radius: 50px; font-weight: 700; font-size: 16px; box-shadow: 0 6px 24px rgba(255, 45, 85, 0.35), 0 2px 8px rgba(255, 45, 85, 0.2); text-transform: uppercase; letter-spacing: 1px; border: 2px solid rgba(255, 255, 255, 0.3);">📋 VIEW IN DASHBOARD</a>
                    </td>
                  </tr>
                </table>
              </div>
            </td>
          </tr>
          <!-- Footer (minimal for admin emails) -->
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff4270 100%); padding: 30px; text-align: center;">
              <img src="https://***REMOVED***/storage/v1/object/public/assets/logo-512.png" alt="FoodShare" style="width: 40px; height: 40px; border-radius: 50%; margin-bottom: 10px; border: 2px solid rgba(255, 255, 255, 0.4); background: white; padding: 2px;">
              <p style="margin: 0; font-size: 14px; color: #ffffff; font-weight: 600;">FoodShare Admin</p>
              <p style="margin: 8px 0 0; font-size: 12px; color: rgba(255, 255, 255, 0.8);">© 2026 FoodShare LLC</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>',
updated_at = NOW()
WHERE slug = 'feedback-alert';
