-- Seed Data: Email Templates
-- Description: Initial email templates for the cross-platform email template system
-- All templates follow the unified FoodShare design system

-- ============================================================================
-- Constants used in templates
-- ============================================================================
-- LOGO_URL: https://api.foodshare.club/storage/v1/object/public/assets/logo-512.png
-- Primary Color: #ff2d55
-- Company: FoodShare LLC, USA 20231394981
-- Address: 4632 Winding Way, Sacramento, CA 95841
-- Website: https://foodshare.club

-- ============================================================================
-- 1. Welcome Email
-- ============================================================================
INSERT INTO email_templates (slug, name, category, subject, html_content, text_content, variables, metadata)
VALUES (
  'welcome',
  'Welcome Email',
  'transactional',
  'Welcome to FoodShare! 🎉',
  '<!DOCTYPE html>
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
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff5177 50%, #ff6b8a 100%); padding: 50px 30px; text-align: center;">
              <img src="https://api.foodshare.club/storage/v1/object/public/assets/logo-512.png" alt="FoodShare Logo" style="width: 100px; height: 100px; border-radius: 50%; margin-bottom: 24px; border: 5px solid rgba(255, 255, 255, 0.4); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); background: white; padding: 4px;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 800; text-shadow: 0 2px 12px rgba(0, 0, 0, 0.25);">Welcome to FoodShare! 🎉</h1>
              <p style="margin: 12px 0 0; color: rgba(255, 255, 255, 0.95); font-size: 16px; font-weight: 500;">Your journey to reducing food waste starts now</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 50px 40px; background-color: #fafafa;">
              <div style="background: white; padding: 30px; border-radius: 12px; border: 2px solid #f0f0f0;">
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
                      <a href="https://foodshare.club/products" style="display: inline-block; padding: 18px 48px; background: linear-gradient(135deg, #ff2d55 0%, #ff4873 50%, #ff5e8a 100%); color: #ffffff; text-decoration: none; border-radius: 50px; font-weight: 700; font-size: 16px; box-shadow: 0 6px 24px rgba(255, 45, 85, 0.35);">🚀 Get Started</a>
                    </td>
                  </tr>
                </table>
              </div>
            </td>
          </tr>
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff4270 100%); padding: 40px 30px; text-align: center;">
              <p style="margin: 0 0 10px; font-size: 15px; color: rgba(255, 255, 255, 0.9); font-weight: 600;">Connect With Us</p>
              <p style="margin: 12px 0 0; font-size: 16px; color: #ffffff; font-weight: 700;">FoodShare LLC</p>
              <p style="margin: 8px 0 0; font-size: 13px; color: rgba(255, 255, 255, 0.9);">© 2024 USA 20231394981<br>All Rights Reserved</p>
              <p style="margin: 12px 0 0; font-size: 14px; color: rgba(255, 255, 255, 0.9);">📍 4632 Winding Way<br>Sacramento, CA 95841</p>
              <p style="margin: 20px 0 0; font-size: 14px; color: rgba(255, 255, 255, 0.95);">💬 Questions? <a href="mailto:support@foodshare.club" style="color: #ffffff; text-decoration: none; font-weight: 700;">support@foodshare.club</a></p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>',
  'Welcome to FoodShare, {{name}}!

We''re thrilled to have you join our community!

Here''s what you can do:
- Share Surplus Food - Post your extra groceries for neighbors
- Discover Food Near You - Browse the map to find available food
- Connect & Chat - Message members to coordinate pickups
- Join Challenges - Participate in community challenges

Get started at https://foodshare.club/products

Together, we''re reducing food waste and building stronger communities!

---
FoodShare LLC
4632 Winding Way, Sacramento, CA 95841
support@foodshare.club',
  '[{"name": "name", "type": "string", "required": true, "default": "there"}]'::jsonb,
  '{"preview_text": "Start sharing and discovering food in your community", "tags": ["onboarding", "welcome"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
  html_content = EXCLUDED.html_content,
  text_content = EXCLUDED.text_content,
  variables = EXCLUDED.variables,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();

-- ============================================================================
-- 2. Email Verification
-- ============================================================================
INSERT INTO email_templates (slug, name, category, subject, html_content, text_content, variables, metadata)
VALUES (
  'email-verification',
  'Email Verification',
  'transactional',
  'Confirm your email to join FoodShare! ✉️',
  '<!DOCTYPE html>
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
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff5177 50%, #ff6b8a 100%); padding: 50px 30px; text-align: center;">
              <img src="https://api.foodshare.club/storage/v1/object/public/assets/logo-512.png" alt="FoodShare Logo" style="width: 100px; height: 100px; border-radius: 50%; margin-bottom: 24px; border: 5px solid rgba(255, 255, 255, 0.4); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); background: white; padding: 4px;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 800;">Welcome to FoodShare! 🎉</h1>
              <p style="margin: 12px 0 0; color: rgba(255, 255, 255, 0.95); font-size: 16px; font-weight: 500;">Let''s confirm your email to get started</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 50px 40px; background-color: #fafafa;">
              <div style="background: white; padding: 30px; border-radius: 12px; border: 2px solid #f0f0f0;">
                <p style="margin: 0 0 20px; font-size: 17px; line-height: 1.7; color: #363a57;">Thanks for signing up for <strong style="color: #ff2d55;">FoodShare</strong>! 🥗</p>
                <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.7; color: #555;">We''re excited to have you join our community dedicated to reducing food waste and sharing delicious meals. To complete your registration, please confirm your email address below:</p>
                <div style="margin: 24px 0 0; padding: 20px; background: linear-gradient(135deg, #f8f8f8 0%, #f3f3f3 100%); border-radius: 8px; border-left: 4px solid #ff2d55;">
                  <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #666;"><strong style="color: #ff2d55;">✨ What happens next?</strong><br>Once confirmed, you''ll gain full access to share and discover food in your community.</p>
                </div>
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td align="center" style="padding: 24px 0 10px;">
                      <a href="{{verifyUrl}}" style="display: inline-block; padding: 18px 48px; background: linear-gradient(135deg, #ff2d55 0%, #ff4873 50%, #ff5e8a 100%); color: #ffffff; text-decoration: none; border-radius: 50px; font-weight: 700; font-size: 16px; box-shadow: 0 6px 24px rgba(255, 45, 85, 0.35);">✓ Confirm Your Email</a>
                    </td>
                  </tr>
                </table>
                <div style="margin: 30px 0 0; font-size: 14px; line-height: 1.6; color: #999; text-align: center; padding: 20px; background-color: #fafafa; border-radius: 8px; border: 1px dashed #e0e0e0;">
                  <strong style="color: #666;">Didn''t sign up?</strong><br>If you didn''t register with FoodShare, you can safely ignore this email.
                </div>
              </div>
            </td>
          </tr>
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff4270 100%); padding: 40px 30px; text-align: center;">
              <p style="margin: 0; font-size: 16px; color: #ffffff; font-weight: 700;">FoodShare LLC</p>
              <p style="margin: 8px 0 0; font-size: 13px; color: rgba(255, 255, 255, 0.9);">© 2024 All Rights Reserved</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>',
  'Confirm your FoodShare email

Thanks for signing up! Please verify your email by clicking the link below:

{{verifyUrl}}

Once confirmed, you''ll gain full access to share and discover food in your community.

If you didn''t sign up for FoodShare, you can safely ignore this email.

---
FoodShare LLC',
  '[{"name": "verifyUrl", "type": "url", "required": true}]'::jsonb,
  '{"preview_text": "One click to confirm your FoodShare account", "tags": ["auth", "verification"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
  html_content = EXCLUDED.html_content,
  text_content = EXCLUDED.text_content,
  variables = EXCLUDED.variables,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();

-- ============================================================================
-- 3. Password Reset
-- ============================================================================
INSERT INTO email_templates (slug, name, category, subject, html_content, text_content, variables, metadata)
VALUES (
  'password-reset',
  'Password Reset',
  'transactional',
  'Reset your FoodShare password 🔐',
  '<!DOCTYPE html>
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
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff5177 50%, #ff6b8a 100%); padding: 50px 30px; text-align: center;">
              <img src="https://api.foodshare.club/storage/v1/object/public/assets/logo-512.png" alt="FoodShare Logo" style="width: 100px; height: 100px; border-radius: 50%; margin-bottom: 24px; border: 5px solid rgba(255, 255, 255, 0.4); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); background: white; padding: 4px;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 800;">Reset Your Password 🔐</h1>
              <p style="margin: 12px 0 0; color: rgba(255, 255, 255, 0.95); font-size: 16px; font-weight: 500;">Let''s get you back into your account</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 50px 40px; background-color: #fafafa;">
              <div style="background: white; padding: 30px; border-radius: 12px; border: 2px solid #f0f0f0;">
                <p style="margin: 0 0 20px; font-size: 17px; line-height: 1.7; color: #363a57;">Hey <strong>{{name}}</strong>,</p>
                <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.7; color: #555;">We received a request to reset your password. Click the button below to create a new password:</p>
                <div style="margin: 24px 0 0; padding: 20px; background: linear-gradient(135deg, #f8f8f8 0%, #f3f3f3 100%); border-radius: 8px; border-left: 4px solid #ff2d55;">
                  <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #666;"><strong style="color: #ff2d55;">⏰ Time Sensitive</strong><br>This link will expire in <strong>{{expiresIn}}</strong>. If you didn''t request this, you can safely ignore this email.</p>
                </div>
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td align="center" style="padding: 24px 0 10px;">
                      <a href="{{resetUrl}}" style="display: inline-block; padding: 18px 48px; background: linear-gradient(135deg, #ff2d55 0%, #ff4873 50%, #ff5e8a 100%); color: #ffffff; text-decoration: none; border-radius: 50px; font-weight: 700; font-size: 16px; box-shadow: 0 6px 24px rgba(255, 45, 85, 0.35);">🔑 Reset Password</a>
                    </td>
                  </tr>
                </table>
                <div style="margin: 30px 0 0; font-size: 14px; line-height: 1.6; color: #999; text-align: center; padding: 20px; background-color: #fafafa; border-radius: 8px; border: 1px dashed #e0e0e0;">
                  <strong style="color: #666;">Didn''t request this?</strong><br>Your account is still secure. No action is needed.
                </div>
              </div>
            </td>
          </tr>
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff4270 100%); padding: 40px 30px; text-align: center;">
              <p style="margin: 0; font-size: 16px; color: #ffffff; font-weight: 700;">FoodShare LLC</p>
              <p style="margin: 8px 0 0; font-size: 13px; color: rgba(255, 255, 255, 0.9);">© 2024 All Rights Reserved</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>',
  'Reset your FoodShare password

Hey {{name}},

We received a request to reset your password. Click the link below to create a new password:

{{resetUrl}}

This link will expire in {{expiresIn}}.

If you didn''t request this, your account is still secure. No action is needed.

---
FoodShare LLC',
  '[{"name": "name", "type": "string", "required": true, "default": "there"}, {"name": "resetUrl", "type": "url", "required": true}, {"name": "expiresIn", "type": "string", "required": false, "default": "1 hour"}]'::jsonb,
  '{"preview_text": "Click to reset your FoodShare password", "tags": ["auth", "password"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
  html_content = EXCLUDED.html_content,
  text_content = EXCLUDED.text_content,
  variables = EXCLUDED.variables,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();

-- ============================================================================
-- 4. Volunteer Welcome
-- ============================================================================
INSERT INTO email_templates (slug, name, category, subject, html_content, text_content, variables, metadata)
VALUES (
  'volunteer-welcome',
  'Volunteer Welcome',
  'transactional',
  'Welcome to the FoodShare Volunteer Team! 🌟',
  '<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome Volunteer!</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, ''Segoe UI'', Roboto, ''Helvetica Neue'', Arial, sans-serif; background-color: #f0f0f0; color: #363a57;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background: linear-gradient(135deg, #f0f0f0 0%, #e5e5e5 100%); padding: 60px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; background-color: #ffffff; border-radius: 16px; box-shadow: 0 10px 40px rgba(255, 45, 85, 0.2); overflow: hidden;">
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff5177 50%, #ff6b8a 100%); padding: 50px 30px; text-align: center;">
              <img src="https://api.foodshare.club/storage/v1/object/public/assets/logo-512.png" alt="FoodShare Logo" style="width: 100px; height: 100px; border-radius: 50%; margin-bottom: 24px; border: 5px solid rgba(255, 255, 255, 0.4); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); background: white; padding: 4px;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 800;">Welcome, Volunteer! 🌟</h1>
              <p style="margin: 12px 0 0; color: rgba(255, 255, 255, 0.95); font-size: 16px; font-weight: 500;">You''re now part of something amazing</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 50px 40px; background-color: #fafafa;">
              <div style="background: white; padding: 30px; border-radius: 12px; border: 2px solid #f0f0f0;">
                <p style="margin: 0 0 20px; font-size: 17px; line-height: 1.7; color: #363a57;">Hey <strong>{{name}}</strong>! 👋</p>
                <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.7; color: #555;">Thank you for joining the FoodShare volunteer team! Your dedication to reducing food waste and helping our community is truly inspiring.</p>
                <p style="margin: 0 0 16px; font-size: 16px; line-height: 1.7; color: #555;"><strong>🎯 As a volunteer, you can:</strong></p>
                <ul style="margin: 0 0 24px; padding-left: 24px; font-size: 15px; line-height: 2; color: #555;">
                  <li><strong style="color: #ff2d55;">🚗 Coordinate Pickups</strong> – Help connect food donors with recipients</li>
                  <li><strong style="color: #00A699;">📦 Manage Distributions</strong> – Organize food distribution events</li>
                  <li><strong style="color: #FC642D;">🤝 Mentor New Members</strong> – Welcome and guide newcomers</li>
                  <li><strong style="color: #8B5CF6;">📊 Track Impact</strong> – See the difference you''re making</li>
                </ul>
                <div style="margin: 24px 0 0; padding: 20px; background: linear-gradient(135deg, #f8f8f8 0%, #f3f3f3 100%); border-radius: 8px; border-left: 4px solid #ff2d55;">
                  <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #666;"><strong style="color: #ff2d55;">💪 Your Impact</strong><br>Volunteers like you help save thousands of meals every month. Together, we''re building a world with zero food waste!</p>
                </div>
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td align="center" style="padding: 24px 0 10px;">
                      <a href="https://foodshare.club/volunteer/dashboard" style="display: inline-block; padding: 18px 48px; background: linear-gradient(135deg, #ff2d55 0%, #ff4873 50%, #ff5e8a 100%); color: #ffffff; text-decoration: none; border-radius: 50px; font-weight: 700; font-size: 16px; box-shadow: 0 6px 24px rgba(255, 45, 85, 0.35);">🎯 View Volunteer Dashboard</a>
                    </td>
                  </tr>
                </table>
              </div>
            </td>
          </tr>
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff4270 100%); padding: 40px 30px; text-align: center;">
              <p style="margin: 0; font-size: 16px; color: #ffffff; font-weight: 700;">FoodShare LLC</p>
              <p style="margin: 8px 0 0; font-size: 13px; color: rgba(255, 255, 255, 0.9);">© 2024 All Rights Reserved</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>',
  'Welcome to the FoodShare Volunteer Team!

Hey {{name}},

Thank you for joining the FoodShare volunteer team! Your dedication to reducing food waste is truly inspiring.

As a volunteer, you can:
- Coordinate Pickups - Help connect food donors with recipients
- Manage Distributions - Organize food distribution events
- Mentor New Members - Welcome and guide newcomers
- Track Impact - See the difference you''re making

View your dashboard: https://foodshare.club/volunteer/dashboard

---
FoodShare LLC',
  '[{"name": "name", "type": "string", "required": true, "default": "there"}]'::jsonb,
  '{"preview_text": "Thank you for joining our volunteer team!", "tags": ["onboarding", "volunteer"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
  html_content = EXCLUDED.html_content,
  text_content = EXCLUDED.text_content,
  variables = EXCLUDED.variables,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();

-- ============================================================================
-- 5. Complete Profile Reminder
-- ============================================================================
INSERT INTO email_templates (slug, name, category, subject, html_content, text_content, variables, metadata)
VALUES (
  'complete-profile',
  'Complete Profile Reminder',
  'transactional',
  'Complete your FoodShare profile to get started! 📝',
  '<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Complete Your Profile</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, ''Segoe UI'', Roboto, ''Helvetica Neue'', Arial, sans-serif; background-color: #f0f0f0; color: #363a57;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background: linear-gradient(135deg, #f0f0f0 0%, #e5e5e5 100%); padding: 60px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; background-color: #ffffff; border-radius: 16px; box-shadow: 0 10px 40px rgba(255, 45, 85, 0.2); overflow: hidden;">
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff5177 50%, #ff6b8a 100%); padding: 50px 30px; text-align: center;">
              <img src="https://api.foodshare.club/storage/v1/object/public/assets/logo-512.png" alt="FoodShare Logo" style="width: 100px; height: 100px; border-radius: 50%; margin-bottom: 24px; border: 5px solid rgba(255, 255, 255, 0.4); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); background: white; padding: 4px;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 800;">Almost There! 📝</h1>
              <p style="margin: 12px 0 0; color: rgba(255, 255, 255, 0.95); font-size: 16px; font-weight: 500;">Complete your profile to unlock all features</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 50px 40px; background-color: #fafafa;">
              <div style="background: white; padding: 30px; border-radius: 12px; border: 2px solid #f0f0f0;">
                <p style="margin: 0 0 20px; font-size: 17px; line-height: 1.7; color: #363a57;">Hey <strong>{{name}}</strong>! 👋</p>
                <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.7; color: #555;">Your FoodShare profile is <strong>{{completionPercent}}%</strong> complete. Add a few more details to get the full experience!</p>
                <p style="margin: 0 0 16px; font-size: 16px; line-height: 1.7; color: #555;"><strong>✅ A complete profile helps you:</strong></p>
                <ul style="margin: 0 0 24px; padding-left: 24px; font-size: 15px; line-height: 2; color: #555;">
                  <li><strong style="color: #ff2d55;">🔍 Get Found</strong> – Neighbors can discover you more easily</li>
                  <li><strong style="color: #00A699;">🤝 Build Trust</strong> – People are more likely to connect with complete profiles</li>
                  <li><strong style="color: #FC642D;">📍 Get Matched</strong> – Find food shares near your location</li>
                </ul>
                <div style="margin: 24px 0 0; padding: 20px; background: linear-gradient(135deg, #f8f8f8 0%, #f3f3f3 100%); border-radius: 8px; border-left: 4px solid #ff2d55;">
                  <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #666;"><strong style="color: #ff2d55;">💡 Quick Tip</strong><br>Adding a profile photo increases your chances of successful connections by 3x!</p>
                </div>
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td align="center" style="padding: 24px 0 10px;">
                      <a href="https://foodshare.club/settings/profile" style="display: inline-block; padding: 18px 48px; background: linear-gradient(135deg, #ff2d55 0%, #ff4873 50%, #ff5e8a 100%); color: #ffffff; text-decoration: none; border-radius: 50px; font-weight: 700; font-size: 16px; box-shadow: 0 6px 24px rgba(255, 45, 85, 0.35);">📝 Complete Profile</a>
                    </td>
                  </tr>
                </table>
              </div>
            </td>
          </tr>
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff4270 100%); padding: 40px 30px; text-align: center;">
              <p style="margin: 0; font-size: 16px; color: #ffffff; font-weight: 700;">FoodShare LLC</p>
              <p style="margin: 8px 0 0; font-size: 13px; color: rgba(255, 255, 255, 0.9);">© 2024 All Rights Reserved</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>',
  'Complete your FoodShare profile

Hey {{name}},

Your FoodShare profile is {{completionPercent}}% complete. Add a few more details to unlock all features!

A complete profile helps you:
- Get Found by neighbors
- Build Trust with complete profiles
- Get Matched with food shares near you

Complete your profile: https://foodshare.club/settings/profile

---
FoodShare LLC',
  '[{"name": "name", "type": "string", "required": true, "default": "there"}, {"name": "completionPercent", "type": "number", "required": false, "default": 50}]'::jsonb,
  '{"preview_text": "Your profile is almost complete!", "tags": ["onboarding", "engagement"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
  html_content = EXCLUDED.html_content,
  text_content = EXCLUDED.text_content,
  variables = EXCLUDED.variables,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();

-- ============================================================================
-- 6. First Share Tips
-- ============================================================================
INSERT INTO email_templates (slug, name, category, subject, html_content, text_content, variables, metadata)
VALUES (
  'first-share-tips',
  'First Share Tips',
  'transactional',
  'Ready to share? Here are some tips! 🍎',
  '<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>First Share Tips</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, ''Segoe UI'', Roboto, ''Helvetica Neue'', Arial, sans-serif; background-color: #f0f0f0; color: #363a57;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background: linear-gradient(135deg, #f0f0f0 0%, #e5e5e5 100%); padding: 60px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; background-color: #ffffff; border-radius: 16px; box-shadow: 0 10px 40px rgba(255, 45, 85, 0.2); overflow: hidden;">
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff5177 50%, #ff6b8a 100%); padding: 50px 30px; text-align: center;">
              <img src="https://api.foodshare.club/storage/v1/object/public/assets/logo-512.png" alt="FoodShare Logo" style="width: 100px; height: 100px; border-radius: 50%; margin-bottom: 24px; border: 5px solid rgba(255, 255, 255, 0.4); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); background: white; padding: 4px;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 800;">Ready to Share? 🍎</h1>
              <p style="margin: 12px 0 0; color: rgba(255, 255, 255, 0.95); font-size: 16px; font-weight: 500;">Tips for a successful first share</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 50px 40px; background-color: #fafafa;">
              <div style="background: white; padding: 30px; border-radius: 12px; border: 2px solid #f0f0f0;">
                <p style="margin: 0 0 20px; font-size: 17px; line-height: 1.7; color: #363a57;">Hey <strong>{{name}}</strong>! 👋</p>
                <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.7; color: #555;">Ready to make your first food share? Here are some tips to make it a great experience:</p>
                <p style="margin: 0 0 16px; font-size: 16px; line-height: 1.7; color: #555;"><strong>📸 Creating a Great Listing:</strong></p>
                <ul style="margin: 0 0 24px; padding-left: 24px; font-size: 15px; line-height: 2; color: #555;">
                  <li><strong style="color: #ff2d55;">📷 Add Clear Photos</strong> – Good photos get 5x more interest</li>
                  <li><strong style="color: #00A699;">📝 Be Descriptive</strong> – Include quantity, expiry dates, and dietary info</li>
                  <li><strong style="color: #FC642D;">📍 Set Pickup Details</strong> – Clear time and location help coordination</li>
                  <li><strong style="color: #8B5CF6;">⚡ Respond Quickly</strong> – Fast responses lead to successful pickups</li>
                </ul>
                <div style="margin: 24px 0 0; padding: 20px; background: linear-gradient(135deg, #f8f8f8 0%, #f3f3f3 100%); border-radius: 8px; border-left: 4px solid #ff2d55;">
                  <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #666;"><strong style="color: #ff2d55;">🌟 Pro Tip</strong><br>Start with items that are still fresh but you can''t use in time. Produce, bread, and leftovers are popular first shares!</p>
                </div>
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td align="center" style="padding: 24px 0 10px;">
                      <a href="https://foodshare.club/share" style="display: inline-block; padding: 18px 48px; background: linear-gradient(135deg, #ff2d55 0%, #ff4873 50%, #ff5e8a 100%); color: #ffffff; text-decoration: none; border-radius: 50px; font-weight: 700; font-size: 16px; box-shadow: 0 6px 24px rgba(255, 45, 85, 0.35);">🍎 Create Your First Share</a>
                    </td>
                  </tr>
                </table>
              </div>
            </td>
          </tr>
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff4270 100%); padding: 40px 30px; text-align: center;">
              <p style="margin: 0; font-size: 16px; color: #ffffff; font-weight: 700;">FoodShare LLC</p>
              <p style="margin: 8px 0 0; font-size: 13px; color: rgba(255, 255, 255, 0.9);">© 2024 All Rights Reserved</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>',
  'Ready to make your first food share?

Hey {{name}},

Here are some tips for a successful first share:

1. Add Clear Photos - Good photos get 5x more interest
2. Be Descriptive - Include quantity, expiry dates, and dietary info
3. Set Pickup Details - Clear time and location help coordination
4. Respond Quickly - Fast responses lead to successful pickups

Pro tip: Start with items that are still fresh but you can''t use in time!

Create your first share: https://foodshare.club/share

---
FoodShare LLC',
  '[{"name": "name", "type": "string", "required": true, "default": "there"}]'::jsonb,
  '{"preview_text": "Tips for a successful first food share", "tags": ["onboarding", "tips"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
  html_content = EXCLUDED.html_content,
  text_content = EXCLUDED.text_content,
  variables = EXCLUDED.variables,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();

-- ============================================================================
-- 7. Community Highlights (Weekly Digest)
-- ============================================================================
INSERT INTO email_templates (slug, name, category, subject, html_content, text_content, variables, metadata)
VALUES (
  'community-highlights',
  'Community Highlights',
  'digest',
  'Your Weekly FoodShare Highlights 🌟',
  '<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Community Highlights</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, ''Segoe UI'', Roboto, ''Helvetica Neue'', Arial, sans-serif; background-color: #f0f0f0; color: #363a57;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background: linear-gradient(135deg, #f0f0f0 0%, #e5e5e5 100%); padding: 60px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; background-color: #ffffff; border-radius: 16px; box-shadow: 0 10px 40px rgba(255, 45, 85, 0.2); overflow: hidden;">
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff5177 50%, #ff6b8a 100%); padding: 50px 30px; text-align: center;">
              <img src="https://api.foodshare.club/storage/v1/object/public/assets/logo-512.png" alt="FoodShare Logo" style="width: 100px; height: 100px; border-radius: 50%; margin-bottom: 24px; border: 5px solid rgba(255, 255, 255, 0.4); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); background: white; padding: 4px;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 800;">Weekly Highlights 🌟</h1>
              <p style="margin: 12px 0 0; color: rgba(255, 255, 255, 0.95); font-size: 16px; font-weight: 500;">See what''s happening in your community</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 50px 40px; background-color: #fafafa;">
              <div style="background: white; padding: 30px; border-radius: 12px; border: 2px solid #f0f0f0;">
                <p style="margin: 0 0 20px; font-size: 17px; line-height: 1.7; color: #363a57;">Hey <strong>{{name}}</strong>! 👋</p>
                <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.7; color: #555;">Here''s what happened in your FoodShare community this week:</p>

                <div style="margin: 24px 0; padding: 20px; background: linear-gradient(135deg, #f8f8f8 0%, #f3f3f3 100%); border-radius: 8px;">
                  <p style="margin: 0 0 16px; font-size: 18px; font-weight: 700; color: #363a57;">📊 Community Impact</p>
                  <table width="100%" cellpadding="8" cellspacing="0">
                    <tr>
                      <td style="text-align: center; padding: 12px;">
                        <p style="margin: 0; font-size: 32px; font-weight: 800; color: #ff2d55;">{{mealsShared}}</p>
                        <p style="margin: 4px 0 0; font-size: 13px; color: #666;">Meals Shared</p>
                      </td>
                      <td style="text-align: center; padding: 12px;">
                        <p style="margin: 0; font-size: 32px; font-weight: 800; color: #00A699;">{{co2Saved}}</p>
                        <p style="margin: 4px 0 0; font-size: 13px; color: #666;">kg CO₂ Saved</p>
                      </td>
                      <td style="text-align: center; padding: 12px;">
                        <p style="margin: 0; font-size: 32px; font-weight: 800; color: #8B5CF6;">{{newMembers}}</p>
                        <p style="margin: 4px 0 0; font-size: 13px; color: #666;">New Members</p>
                      </td>
                    </tr>
                  </table>
                </div>

                <div style="margin: 24px 0 0; padding: 20px; background: linear-gradient(135deg, #f8f8f8 0%, #f3f3f3 100%); border-radius: 8px; border-left: 4px solid #ff2d55;">
                  <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #666;"><strong style="color: #ff2d55;">🏆 Top Contributors</strong><br>{{topContributors}}</p>
                </div>

                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td align="center" style="padding: 24px 0 10px;">
                      <a href="https://foodshare.club/community" style="display: inline-block; padding: 18px 48px; background: linear-gradient(135deg, #ff2d55 0%, #ff4873 50%, #ff5e8a 100%); color: #ffffff; text-decoration: none; border-radius: 50px; font-weight: 700; font-size: 16px; box-shadow: 0 6px 24px rgba(255, 45, 85, 0.35);">🌟 See Full Highlights</a>
                    </td>
                  </tr>
                </table>
              </div>
            </td>
          </tr>
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff4270 100%); padding: 40px 30px; text-align: center;">
              <p style="margin: 0; font-size: 16px; color: #ffffff; font-weight: 700;">FoodShare LLC</p>
              <p style="margin: 20px 0 0; font-size: 13px; color: rgba(255, 255, 255, 0.9);"><a href="{{unsubscribeUrl}}" style="color: #ffffff;">Unsubscribe from weekly highlights</a></p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>',
  'Your Weekly FoodShare Highlights

Hey {{name}},

Here''s what happened in your community this week:

📊 Community Impact:
- {{mealsShared}} Meals Shared
- {{co2Saved}} kg CO₂ Saved
- {{newMembers}} New Members

🏆 Top Contributors: {{topContributors}}

See full highlights: https://foodshare.club/community

---
Unsubscribe: {{unsubscribeUrl}}
FoodShare LLC',
  '[{"name": "name", "type": "string", "required": true, "default": "there"}, {"name": "mealsShared", "type": "number", "required": true, "default": 0}, {"name": "co2Saved", "type": "number", "required": true, "default": 0}, {"name": "newMembers", "type": "number", "required": true, "default": 0}, {"name": "topContributors", "type": "string", "required": false, "default": "Check out who''s making an impact!"}, {"name": "unsubscribeUrl", "type": "url", "required": true}]'::jsonb,
  '{"preview_text": "See what''s happening in your community", "tags": ["digest", "weekly"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
  html_content = EXCLUDED.html_content,
  text_content = EXCLUDED.text_content,
  variables = EXCLUDED.variables,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();

-- ============================================================================
-- 8. Monthly Impact Report
-- ============================================================================
INSERT INTO email_templates (slug, name, category, subject, html_content, text_content, variables, metadata)
VALUES (
  'monthly-impact',
  'Monthly Impact Report',
  'digest',
  'Your Monthly Impact Report 📊',
  '<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Monthly Impact</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, ''Segoe UI'', Roboto, ''Helvetica Neue'', Arial, sans-serif; background-color: #f0f0f0; color: #363a57;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background: linear-gradient(135deg, #f0f0f0 0%, #e5e5e5 100%); padding: 60px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; background-color: #ffffff; border-radius: 16px; box-shadow: 0 10px 40px rgba(255, 45, 85, 0.2); overflow: hidden;">
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff5177 50%, #ff6b8a 100%); padding: 50px 30px; text-align: center;">
              <img src="https://api.foodshare.club/storage/v1/object/public/assets/logo-512.png" alt="FoodShare Logo" style="width: 100px; height: 100px; border-radius: 50%; margin-bottom: 24px; border: 5px solid rgba(255, 255, 255, 0.4); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); background: white; padding: 4px;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 800;">Your Impact in {{month}} 📊</h1>
              <p style="margin: 12px 0 0; color: rgba(255, 255, 255, 0.95); font-size: 16px; font-weight: 500;">Look at the difference you''ve made!</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 50px 40px; background-color: #fafafa;">
              <div style="background: white; padding: 30px; border-radius: 12px; border: 2px solid #f0f0f0;">
                <p style="margin: 0 0 20px; font-size: 17px; line-height: 1.7; color: #363a57;">Hey <strong>{{name}}</strong>! 👋</p>
                <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.7; color: #555;">Here''s your personal impact report for {{month}}:</p>

                <div style="margin: 24px 0; padding: 24px; background: linear-gradient(135deg, #ff2d55 0%, #ff5177 100%); border-radius: 12px; text-align: center;">
                  <p style="margin: 0; font-size: 14px; color: rgba(255,255,255,0.9); text-transform: uppercase; letter-spacing: 1px;">Your Total Impact</p>
                  <p style="margin: 8px 0 0; font-size: 48px; font-weight: 800; color: #ffffff;">{{totalMeals}}</p>
                  <p style="margin: 4px 0 0; font-size: 16px; color: rgba(255,255,255,0.95);">meals saved from waste</p>
                </div>

                <table width="100%" cellpadding="8" cellspacing="0" style="margin: 24px 0;">
                  <tr>
                    <td style="text-align: center; padding: 16px; background: #f8f8f8; border-radius: 8px;">
                      <p style="margin: 0; font-size: 28px; font-weight: 800; color: #00A699;">{{foodSavedKg}}</p>
                      <p style="margin: 4px 0 0; font-size: 12px; color: #666;">kg Food Saved</p>
                    </td>
                    <td style="width: 16px;"></td>
                    <td style="text-align: center; padding: 16px; background: #f8f8f8; border-radius: 8px;">
                      <p style="margin: 0; font-size: 28px; font-weight: 800; color: #8B5CF6;">{{co2Prevented}}</p>
                      <p style="margin: 4px 0 0; font-size: 12px; color: #666;">kg CO₂ Prevented</p>
                    </td>
                    <td style="width: 16px;"></td>
                    <td style="text-align: center; padding: 16px; background: #f8f8f8; border-radius: 8px;">
                      <p style="margin: 0; font-size: 28px; font-weight: 800; color: #FC642D;">{{connections}}</p>
                      <p style="margin: 4px 0 0; font-size: 12px; color: #666;">Connections Made</p>
                    </td>
                  </tr>
                </table>

                <div style="margin: 24px 0 0; padding: 20px; background: linear-gradient(135deg, #f8f8f8 0%, #f3f3f3 100%); border-radius: 8px; border-left: 4px solid #ff2d55;">
                  <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #666;"><strong style="color: #ff2d55;">🌍 Fun Fact</strong><br>The CO₂ you prevented is equivalent to driving {{carMilesEquivalent}} miles in a car!</p>
                </div>

                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td align="center" style="padding: 24px 0 10px;">
                      <a href="https://foodshare.club/impact" style="display: inline-block; padding: 18px 48px; background: linear-gradient(135deg, #ff2d55 0%, #ff4873 50%, #ff5e8a 100%); color: #ffffff; text-decoration: none; border-radius: 50px; font-weight: 700; font-size: 16px; box-shadow: 0 6px 24px rgba(255, 45, 85, 0.35);">📊 View Full Report</a>
                    </td>
                  </tr>
                </table>
              </div>
            </td>
          </tr>
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff4270 100%); padding: 40px 30px; text-align: center;">
              <p style="margin: 0; font-size: 16px; color: #ffffff; font-weight: 700;">FoodShare LLC</p>
              <p style="margin: 8px 0 0; font-size: 13px; color: rgba(255, 255, 255, 0.9);">© 2024 All Rights Reserved</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>',
  'Your Monthly Impact Report - {{month}}

Hey {{name}},

Here''s your personal impact for {{month}}:

🍽️ Total Meals Saved: {{totalMeals}}
📦 Food Saved: {{foodSavedKg}} kg
🌍 CO₂ Prevented: {{co2Prevented}} kg
🤝 Connections Made: {{connections}}

Fun Fact: The CO₂ you prevented is equivalent to driving {{carMilesEquivalent}} miles!

View your full report: https://foodshare.club/impact

---
FoodShare LLC',
  '[{"name": "name", "type": "string", "required": true, "default": "there"}, {"name": "month", "type": "string", "required": true}, {"name": "totalMeals", "type": "number", "required": true, "default": 0}, {"name": "foodSavedKg", "type": "number", "required": true, "default": 0}, {"name": "co2Prevented", "type": "number", "required": true, "default": 0}, {"name": "connections", "type": "number", "required": true, "default": 0}, {"name": "carMilesEquivalent", "type": "number", "required": false, "default": 0}]'::jsonb,
  '{"preview_text": "See the difference you made this month", "tags": ["digest", "monthly", "impact"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
  html_content = EXCLUDED.html_content,
  text_content = EXCLUDED.text_content,
  variables = EXCLUDED.variables,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();

-- ============================================================================
-- 9. Milestone Celebration
-- ============================================================================
INSERT INTO email_templates (slug, name, category, subject, html_content, text_content, variables, metadata)
VALUES (
  'milestone-celebration',
  'Milestone Celebration',
  'transactional',
  'You did it! 🎉 {{milestoneName}}',
  '<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Milestone Achieved!</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, ''Segoe UI'', Roboto, ''Helvetica Neue'', Arial, sans-serif; background-color: #f0f0f0; color: #363a57;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background: linear-gradient(135deg, #f0f0f0 0%, #e5e5e5 100%); padding: 60px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; background-color: #ffffff; border-radius: 16px; box-shadow: 0 10px 40px rgba(255, 45, 85, 0.2); overflow: hidden;">
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff5177 50%, #ff6b8a 100%); padding: 50px 30px; text-align: center;">
              <img src="https://api.foodshare.club/storage/v1/object/public/assets/logo-512.png" alt="FoodShare Logo" style="width: 100px; height: 100px; border-radius: 50%; margin-bottom: 24px; border: 5px solid rgba(255, 255, 255, 0.4); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); background: white; padding: 4px;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 800;">🎉 Achievement Unlocked!</h1>
              <p style="margin: 12px 0 0; color: rgba(255, 255, 255, 0.95); font-size: 16px; font-weight: 500;">You''ve reached an amazing milestone</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 50px 40px; background-color: #fafafa;">
              <div style="background: white; padding: 30px; border-radius: 12px; border: 2px solid #f0f0f0;">
                <p style="margin: 0 0 20px; font-size: 17px; line-height: 1.7; color: #363a57;">Congratulations <strong>{{name}}</strong>! 🎊</p>

                <div style="margin: 24px 0; padding: 32px; background: linear-gradient(135deg, #8B5CF6 0%, #A78BFA 100%); border-radius: 16px; text-align: center;">
                  <p style="margin: 0; font-size: 64px;">{{milestoneEmoji}}</p>
                  <p style="margin: 16px 0 0; font-size: 24px; font-weight: 800; color: #ffffff;">{{milestoneName}}</p>
                  <p style="margin: 8px 0 0; font-size: 16px; color: rgba(255,255,255,0.9);">{{milestoneDescription}}</p>
                </div>

                <p style="margin: 24px 0; font-size: 16px; line-height: 1.7; color: #555;">This achievement puts you in the top <strong style="color: #ff2d55;">{{percentile}}%</strong> of FoodShare members. Keep up the amazing work!</p>

                <div style="margin: 24px 0 0; padding: 20px; background: linear-gradient(135deg, #f8f8f8 0%, #f3f3f3 100%); border-radius: 8px; border-left: 4px solid #ff2d55;">
                  <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #666;"><strong style="color: #ff2d55;">🎯 Next Goal</strong><br>{{nextMilestone}}</p>
                </div>

                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td align="center" style="padding: 24px 0 10px;">
                      <a href="https://foodshare.club/achievements" style="display: inline-block; padding: 18px 48px; background: linear-gradient(135deg, #ff2d55 0%, #ff4873 50%, #ff5e8a 100%); color: #ffffff; text-decoration: none; border-radius: 50px; font-weight: 700; font-size: 16px; box-shadow: 0 6px 24px rgba(255, 45, 85, 0.35);">🏆 View All Achievements</a>
                    </td>
                  </tr>
                </table>
              </div>
            </td>
          </tr>
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff4270 100%); padding: 40px 30px; text-align: center;">
              <p style="margin: 0; font-size: 16px; color: #ffffff; font-weight: 700;">FoodShare LLC</p>
              <p style="margin: 8px 0 0; font-size: 13px; color: rgba(255, 255, 255, 0.9);">© 2024 All Rights Reserved</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>',
  'Achievement Unlocked: {{milestoneName}}

Congratulations {{name}}! 🎊

{{milestoneEmoji}} {{milestoneName}}
{{milestoneDescription}}

This achievement puts you in the top {{percentile}}% of FoodShare members!

Next Goal: {{nextMilestone}}

View all achievements: https://foodshare.club/achievements

---
FoodShare LLC',
  '[{"name": "name", "type": "string", "required": true, "default": "there"}, {"name": "milestoneName", "type": "string", "required": true}, {"name": "milestoneDescription", "type": "string", "required": true}, {"name": "milestoneEmoji", "type": "string", "required": false, "default": "🏆"}, {"name": "percentile", "type": "number", "required": false, "default": 10}, {"name": "nextMilestone", "type": "string", "required": false, "default": "Keep sharing to unlock your next achievement!"}]'::jsonb,
  '{"preview_text": "You''ve unlocked an achievement!", "tags": ["engagement", "gamification"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
  html_content = EXCLUDED.html_content,
  text_content = EXCLUDED.text_content,
  variables = EXCLUDED.variables,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();

-- ============================================================================
-- 10. Neighborhood Welcome
-- ============================================================================
INSERT INTO email_templates (slug, name, category, subject, html_content, text_content, variables, metadata)
VALUES (
  'neighborhood-welcome',
  'Neighborhood Welcome',
  'transactional',
  'Welcome to the {{neighborhood}} FoodShare Community! 🏘️',
  '<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Neighborhood Welcome</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, ''Segoe UI'', Roboto, ''Helvetica Neue'', Arial, sans-serif; background-color: #f0f0f0; color: #363a57;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background: linear-gradient(135deg, #f0f0f0 0%, #e5e5e5 100%); padding: 60px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; background-color: #ffffff; border-radius: 16px; box-shadow: 0 10px 40px rgba(255, 45, 85, 0.2); overflow: hidden;">
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff5177 50%, #ff6b8a 100%); padding: 50px 30px; text-align: center;">
              <img src="https://api.foodshare.club/storage/v1/object/public/assets/logo-512.png" alt="FoodShare Logo" style="width: 100px; height: 100px; border-radius: 50%; margin-bottom: 24px; border: 5px solid rgba(255, 255, 255, 0.4); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); background: white; padding: 4px;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 800;">Welcome to {{neighborhood}}! 🏘️</h1>
              <p style="margin: 12px 0 0; color: rgba(255, 255, 255, 0.95); font-size: 16px; font-weight: 500;">Meet your local FoodShare community</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 50px 40px; background-color: #fafafa;">
              <div style="background: white; padding: 30px; border-radius: 12px; border: 2px solid #f0f0f0;">
                <p style="margin: 0 0 20px; font-size: 17px; line-height: 1.7; color: #363a57;">Hey <strong>{{name}}</strong>! 👋</p>
                <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.7; color: #555;">Great news! You''ve joined the <strong style="color: #ff2d55;">{{neighborhood}}</strong> FoodShare community. Here''s what''s happening locally:</p>

                <div style="margin: 24px 0; padding: 20px; background: linear-gradient(135deg, #f8f8f8 0%, #f3f3f3 100%); border-radius: 8px;">
                  <table width="100%" cellpadding="8" cellspacing="0">
                    <tr>
                      <td style="text-align: center; padding: 12px;">
                        <p style="margin: 0; font-size: 32px; font-weight: 800; color: #ff2d55;">{{activeMembers}}</p>
                        <p style="margin: 4px 0 0; font-size: 13px; color: #666;">Active Members</p>
                      </td>
                      <td style="text-align: center; padding: 12px;">
                        <p style="margin: 0; font-size: 32px; font-weight: 800; color: #00A699;">{{availableNow}}</p>
                        <p style="margin: 4px 0 0; font-size: 13px; color: #666;">Items Available</p>
                      </td>
                      <td style="text-align: center; padding: 12px;">
                        <p style="margin: 0; font-size: 32px; font-weight: 800; color: #8B5CF6;">{{sharesThisWeek}}</p>
                        <p style="margin: 4px 0 0; font-size: 13px; color: #666;">Shares This Week</p>
                      </td>
                    </tr>
                  </table>
                </div>

                <div style="margin: 24px 0 0; padding: 20px; background: linear-gradient(135deg, #f8f8f8 0%, #f3f3f3 100%); border-radius: 8px; border-left: 4px solid #ff2d55;">
                  <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #666;"><strong style="color: #ff2d55;">📍 Local Tip</strong><br>Check out listings from your neighbors - most pickups in {{neighborhood}} happen within 10 minutes!</p>
                </div>

                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td align="center" style="padding: 24px 0 10px;">
                      <a href="https://foodshare.club/nearby" style="display: inline-block; padding: 18px 48px; background: linear-gradient(135deg, #ff2d55 0%, #ff4873 50%, #ff5e8a 100%); color: #ffffff; text-decoration: none; border-radius: 50px; font-weight: 700; font-size: 16px; box-shadow: 0 6px 24px rgba(255, 45, 85, 0.35);">🗺️ Explore Nearby</a>
                    </td>
                  </tr>
                </table>
              </div>
            </td>
          </tr>
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff4270 100%); padding: 40px 30px; text-align: center;">
              <p style="margin: 0; font-size: 16px; color: #ffffff; font-weight: 700;">FoodShare LLC</p>
              <p style="margin: 8px 0 0; font-size: 13px; color: rgba(255, 255, 255, 0.9);">© 2024 All Rights Reserved</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>',
  'Welcome to {{neighborhood}} FoodShare!

Hey {{name}},

Great news! You''ve joined the {{neighborhood}} FoodShare community.

Local stats:
- {{activeMembers}} Active Members
- {{availableNow}} Items Available Now
- {{sharesThisWeek}} Shares This Week

Local tip: Most pickups in {{neighborhood}} happen within 10 minutes!

Explore nearby: https://foodshare.club/nearby

---
FoodShare LLC',
  '[{"name": "name", "type": "string", "required": true, "default": "there"}, {"name": "neighborhood", "type": "string", "required": true}, {"name": "activeMembers", "type": "number", "required": false, "default": 0}, {"name": "availableNow", "type": "number", "required": false, "default": 0}, {"name": "sharesThisWeek", "type": "number", "required": false, "default": 0}]'::jsonb,
  '{"preview_text": "Meet your local FoodShare community", "tags": ["onboarding", "local"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
  html_content = EXCLUDED.html_content,
  text_content = EXCLUDED.text_content,
  variables = EXCLUDED.variables,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();

-- ============================================================================
-- 11. Re-engagement Email
-- ============================================================================
INSERT INTO email_templates (slug, name, category, subject, html_content, text_content, variables, metadata)
VALUES (
  'reengagement',
  'Re-engagement Email',
  'marketing',
  'We miss you! Come back to FoodShare 💚',
  '<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>We Miss You!</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, ''Segoe UI'', Roboto, ''Helvetica Neue'', Arial, sans-serif; background-color: #f0f0f0; color: #363a57;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background: linear-gradient(135deg, #f0f0f0 0%, #e5e5e5 100%); padding: 60px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; background-color: #ffffff; border-radius: 16px; box-shadow: 0 10px 40px rgba(255, 45, 85, 0.2); overflow: hidden;">
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff5177 50%, #ff6b8a 100%); padding: 50px 30px; text-align: center;">
              <img src="https://api.foodshare.club/storage/v1/object/public/assets/logo-512.png" alt="FoodShare Logo" style="width: 100px; height: 100px; border-radius: 50%; margin-bottom: 24px; border: 5px solid rgba(255, 255, 255, 0.4); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); background: white; padding: 4px;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 800;">We Miss You! 💚</h1>
              <p style="margin: 12px 0 0; color: rgba(255, 255, 255, 0.95); font-size: 16px; font-weight: 500;">A lot has happened since you''ve been away</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 50px 40px; background-color: #fafafa;">
              <div style="background: white; padding: 30px; border-radius: 12px; border: 2px solid #f0f0f0;">
                <p style="margin: 0 0 20px; font-size: 17px; line-height: 1.7; color: #363a57;">Hey <strong>{{name}}</strong>! 👋</p>
                <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.7; color: #555;">It''s been {{daysSinceLastVisit}} days since we last saw you, and your community has been busy!</p>

                <div style="margin: 24px 0; padding: 20px; background: linear-gradient(135deg, #f8f8f8 0%, #f3f3f3 100%); border-radius: 8px;">
                  <p style="margin: 0 0 16px; font-size: 16px; font-weight: 700; color: #363a57;">📊 While You Were Away:</p>
                  <ul style="margin: 0; padding-left: 24px; font-size: 15px; line-height: 2; color: #555;">
                    <li><strong style="color: #ff2d55;">{{newListingsNearby}}</strong> new listings posted near you</li>
                    <li><strong style="color: #00A699;">{{mealsSavedCommunity}}</strong> meals saved from waste in your area</li>
                    <li><strong style="color: #8B5CF6;">{{newMembersNearby}}</strong> new members joined your neighborhood</li>
                  </ul>
                </div>

                <div style="margin: 24px 0 0; padding: 20px; background: linear-gradient(135deg, #f8f8f8 0%, #f3f3f3 100%); border-radius: 8px; border-left: 4px solid #ff2d55;">
                  <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #666;"><strong style="color: #ff2d55;">🎁 Welcome Back Offer</strong><br>Share something in the next 7 days and earn double impact points!</p>
                </div>

                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td align="center" style="padding: 24px 0 10px;">
                      <a href="https://foodshare.club" style="display: inline-block; padding: 18px 48px; background: linear-gradient(135deg, #ff2d55 0%, #ff4873 50%, #ff5e8a 100%); color: #ffffff; text-decoration: none; border-radius: 50px; font-weight: 700; font-size: 16px; box-shadow: 0 6px 24px rgba(255, 45, 85, 0.35);">💚 Come Back</a>
                    </td>
                  </tr>
                </table>
              </div>
            </td>
          </tr>
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff4270 100%); padding: 40px 30px; text-align: center;">
              <p style="margin: 0; font-size: 16px; color: #ffffff; font-weight: 700;">FoodShare LLC</p>
              <p style="margin: 20px 0 0; font-size: 13px; color: rgba(255, 255, 255, 0.9);"><a href="{{unsubscribeUrl}}" style="color: #ffffff;">Unsubscribe</a></p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>',
  'We miss you at FoodShare!

Hey {{name}},

It''s been {{daysSinceLastVisit}} days since we last saw you!

While you were away:
- {{newListingsNearby}} new listings posted near you
- {{mealsSavedCommunity}} meals saved in your area
- {{newMembersNearby}} new members in your neighborhood

Welcome back offer: Share something in the next 7 days and earn double impact points!

Come back: https://foodshare.club

---
Unsubscribe: {{unsubscribeUrl}}
FoodShare LLC',
  '[{"name": "name", "type": "string", "required": true, "default": "there"}, {"name": "daysSinceLastVisit", "type": "number", "required": true, "default": 30}, {"name": "newListingsNearby", "type": "number", "required": false, "default": 0}, {"name": "mealsSavedCommunity", "type": "number", "required": false, "default": 0}, {"name": "newMembersNearby", "type": "number", "required": false, "default": 0}, {"name": "unsubscribeUrl", "type": "url", "required": true}]'::jsonb,
  '{"preview_text": "A lot has happened since you''ve been away", "tags": ["marketing", "reengagement"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
  html_content = EXCLUDED.html_content,
  text_content = EXCLUDED.text_content,
  variables = EXCLUDED.variables,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();

-- ============================================================================
-- 12. New Listing Nearby
-- ============================================================================
INSERT INTO email_templates (slug, name, category, subject, html_content, text_content, variables, metadata)
VALUES (
  'new-listing-nearby',
  'New Listing Nearby',
  'transactional',
  '🍎 New {{listingType}} available: {{listingTitle}}',
  '<!DOCTYPE html>
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
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff5177 50%, #ff6b8a 100%); padding: 50px 30px; text-align: center;">
              <img src="https://api.foodshare.club/storage/v1/object/public/assets/logo-512.png" alt="FoodShare Logo" style="width: 100px; height: 100px; border-radius: 50%; margin-bottom: 24px; border: 5px solid rgba(255, 255, 255, 0.4); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); background: white; padding: 4px;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 800;">New Listing Near You! 📍</h1>
              <p style="margin: 12px 0 0; color: rgba(255, 255, 255, 0.95); font-size: 16px; font-weight: 500;">{{listingTitle}} is now available</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 50px 40px; background-color: #fafafa;">
              <div style="background: white; padding: 30px; border-radius: 12px; border: 2px solid #f0f0f0;">
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
                      <a href="{{listingUrl}}" style="display: inline-block; padding: 18px 48px; background: linear-gradient(135deg, #ff2d55 0%, #ff4873 50%, #ff5e8a 100%); color: #ffffff; text-decoration: none; border-radius: 50px; font-weight: 700; font-size: 16px; box-shadow: 0 6px 24px rgba(255, 45, 85, 0.35);">👀 View Listing</a>
                    </td>
                  </tr>
                </table>
              </div>
            </td>
          </tr>
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff4270 100%); padding: 40px 30px; text-align: center;">
              <p style="margin: 0; font-size: 16px; color: #ffffff; font-weight: 700;">FoodShare LLC</p>
              <p style="margin: 8px 0 0; font-size: 13px; color: rgba(255, 255, 255, 0.9);">© 2024 All Rights Reserved</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>',
  'New {{listingType}} available near you!

Hey {{recipientName}},

Great news! A new listing is available near you:

{{listingEmoji}} {{listingTitle}}
📍 {{listingAddress}}
{{listingDescription}}

Posted by {{posterName}}

View listing: {{listingUrl}}

Items go fast - don''t miss out!

---
FoodShare LLC',
  '[{"name": "recipientName", "type": "string", "required": true, "default": "there"}, {"name": "listingTitle", "type": "string", "required": true}, {"name": "listingDescription", "type": "string", "required": false, "default": ""}, {"name": "listingAddress", "type": "string", "required": false, "default": "Near you"}, {"name": "posterName", "type": "string", "required": true}, {"name": "listingUrl", "type": "url", "required": true}, {"name": "listingType", "type": "string", "required": false, "default": "food"}, {"name": "listingEmoji", "type": "string", "required": false, "default": "🍎"}]'::jsonb,
  '{"preview_text": "A new listing is available near you", "tags": ["notification", "listing"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
  html_content = EXCLUDED.html_content,
  text_content = EXCLUDED.text_content,
  variables = EXCLUDED.variables,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();

-- ============================================================================
-- 13. Chat Notification
-- ============================================================================
INSERT INTO email_templates (slug, name, category, subject, html_content, text_content, variables, metadata)
VALUES (
  'chat-notification',
  'Chat Notification',
  'transactional',
  '💬 New message from {{senderName}}',
  '<!DOCTYPE html>
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
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff5177 50%, #ff6b8a 100%); padding: 50px 30px; text-align: center;">
              <img src="https://api.foodshare.club/storage/v1/object/public/assets/logo-512.png" alt="FoodShare Logo" style="width: 100px; height: 100px; border-radius: 50%; margin-bottom: 24px; border: 5px solid rgba(255, 255, 255, 0.4); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); background: white; padding: 4px;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 800;">You''ve Got a Message! 💬</h1>
              <p style="margin: 12px 0 0; color: rgba(255, 255, 255, 0.95); font-size: 16px; font-weight: 500;">{{senderName}} sent you a message</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 50px 40px; background-color: #fafafa;">
              <div style="background: white; padding: 30px; border-radius: 12px; border: 2px solid #f0f0f0;">
                <p style="margin: 0 0 20px; font-size: 17px; line-height: 1.7; color: #363a57;">Hey <strong>{{recipientName}}</strong>! 👋</p>
                <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.7; color: #555;">You have a new message from <strong style="color: #ff2d55;">{{senderName}}</strong>:</p>

                <div style="background: linear-gradient(135deg, #f8f8f8 0%, #f3f3f3 100%); border-radius: 12px; padding: 24px; margin: 0 0 24px; border-left: 4px solid #ff2d55;">
                  <p style="margin: 0; font-size: 16px; line-height: 1.7; color: #555; font-style: italic;">"{{messagePreview}}"</p>
                </div>

                <p style="margin: 0; font-size: 16px; line-height: 1.7; color: #555;">Reply now to continue the conversation! 💬</p>

                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td align="center" style="padding: 24px 0 10px;">
                      <a href="{{chatUrl}}" style="display: inline-block; padding: 18px 48px; background: linear-gradient(135deg, #ff2d55 0%, #ff4873 50%, #ff5e8a 100%); color: #ffffff; text-decoration: none; border-radius: 50px; font-weight: 700; font-size: 16px; box-shadow: 0 6px 24px rgba(255, 45, 85, 0.35);">💬 Reply Now</a>
                    </td>
                  </tr>
                </table>
              </div>
            </td>
          </tr>
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff4270 100%); padding: 40px 30px; text-align: center;">
              <p style="margin: 0; font-size: 16px; color: #ffffff; font-weight: 700;">FoodShare LLC</p>
              <p style="margin: 8px 0 0; font-size: 13px; color: rgba(255, 255, 255, 0.9);">© 2024 All Rights Reserved</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>',
  'New message from {{senderName}}

Hey {{recipientName}},

You have a new message from {{senderName}}:

"{{messagePreview}}"

Reply now: {{chatUrl}}

---
FoodShare LLC',
  '[{"name": "recipientName", "type": "string", "required": true, "default": "there"}, {"name": "senderName", "type": "string", "required": true}, {"name": "messagePreview", "type": "string", "required": true}, {"name": "chatUrl", "type": "url", "required": true}]'::jsonb,
  '{"preview_text": "You have a new message", "tags": ["notification", "chat"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
  html_content = EXCLUDED.html_content,
  text_content = EXCLUDED.text_content,
  variables = EXCLUDED.variables,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();

-- ============================================================================
-- 14. Feedback Alert (Admin)
-- ============================================================================
INSERT INTO email_templates (slug, name, category, subject, html_content, text_content, variables, metadata)
VALUES (
  'feedback-alert',
  'Feedback Alert',
  'transactional',
  '{{feedbackEmoji}} New Feedback: {{subject}}',
  '<!DOCTYPE html>
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
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff5177 50%, #ff6b8a 100%); padding: 50px 30px; text-align: center;">
              <img src="https://api.foodshare.club/storage/v1/object/public/assets/logo-512.png" alt="FoodShare Logo" style="width: 100px; height: 100px; border-radius: 50%; margin-bottom: 24px; border: 5px solid rgba(255, 255, 255, 0.4); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); background: white; padding: 4px;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 800;">New Feedback Received</h1>
              <p style="margin: 12px 0 0; color: rgba(255, 255, 255, 0.95); font-size: 16px; font-weight: 500;">{{feedbackType}} feedback from {{submitterName}}</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 50px 40px; background-color: #fafafa;">
              <div style="background: white; padding: 30px; border-radius: 12px; border: 2px solid #f0f0f0;">
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
                      <a href="https://foodshare.club/admin/feedback" style="display: inline-block; padding: 18px 48px; background: linear-gradient(135deg, #ff2d55 0%, #ff4873 50%, #ff5e8a 100%); color: #ffffff; text-decoration: none; border-radius: 50px; font-weight: 700; font-size: 16px; box-shadow: 0 6px 24px rgba(255, 45, 85, 0.35);">📋 View in Dashboard</a>
                    </td>
                  </tr>
                </table>
              </div>
            </td>
          </tr>
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff4270 100%); padding: 40px 30px; text-align: center;">
              <p style="margin: 0; font-size: 16px; color: #ffffff; font-weight: 700;">FoodShare LLC</p>
              <p style="margin: 8px 0 0; font-size: 13px; color: rgba(255, 255, 255, 0.9);">© 2024 All Rights Reserved</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>',
  'New Feedback: {{subject}}

Type: {{feedbackEmoji}} {{feedbackType}}
From: {{submitterName}} ({{submitterEmail}})
Submitted: {{timestamp}}

Message:
{{message}}

---
Feedback ID: {{feedbackId}}
View in dashboard: https://foodshare.club/admin/feedback

FoodShare LLC',
  '[{"name": "feedbackId", "type": "string", "required": true}, {"name": "feedbackType", "type": "string", "required": true}, {"name": "feedbackEmoji", "type": "string", "required": false, "default": "📩"}, {"name": "subject", "type": "string", "required": true}, {"name": "submitterName", "type": "string", "required": true}, {"name": "submitterEmail", "type": "string", "required": true}, {"name": "message", "type": "string", "required": true}, {"name": "timestamp", "type": "string", "required": false}]'::jsonb,
  '{"preview_text": "New feedback has been submitted", "tags": ["admin", "feedback"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
  html_content = EXCLUDED.html_content,
  text_content = EXCLUDED.text_content,
  variables = EXCLUDED.variables,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();

-- ============================================================================
-- Verification: List all inserted templates
-- ============================================================================
-- SELECT slug, name, category FROM email_templates ORDER BY slug;
