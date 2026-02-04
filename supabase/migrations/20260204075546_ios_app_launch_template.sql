INSERT INTO email_templates (
  name,
  slug,
  subject,
  html_content,
  text_content,
  category,
  is_active,
  variables,
  version
) VALUES (
  'iOS App Launch Announcement',
  'ios-app-launch',
  'FoodShare is Live on the App Store! 🍓📲',
  $HTML$<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>FoodShare is Live! 🍓</title>
</head>
<body style="margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f0f0f0; color: #363a57;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #fff5f7; padding: 40px 20px;">
  <tr>
    <td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; background-color: #ffffff; border-radius: 20px; box-shadow: 0 4px 24px rgba(255, 45, 85, 0.12); overflow: hidden;">
        <tr>
  <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff5177 50%, #ff6b8a 100%); padding: 50px 30px; text-align: center;">
    <img src="https://***REMOVED***/storage/v1/object/public/assets/logo-512.png" alt="FoodShare Logo" style="width: 100px; height: 100px; border-radius: 50%; margin-bottom: 24px; border: 5px solid rgba(255, 255, 255, 0.4); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); background: white; padding: 4px;">
    <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 800; text-shadow: 0 2px 12px rgba(0, 0, 0, 0.25); letter-spacing: -0.5px;">FoodShare is Live! 🍓</h1>
    <p style="margin: 12px 0 0; color: rgba(255, 255, 255, 0.95); font-size: 16px; font-weight: 500; text-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);">Now available on the App Store</p>
  </td>
</tr><tr>
  <td style="padding: 50px 40px; background-color: #fafafa;">
    <div style="background: white; padding: 30px; border-radius: 12px; border: 2px solid #f0f0f0; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);">
      
    <p style="margin: 0 0 20px; font-size: 17px; line-height: 1.7; color: #363a57;">Hey <strong>{{first_name}}</strong>! 👋</p>
    <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.7; color: #555555;"><strong style="color: #ff2d55;">Exciting news!</strong> FoodShare is now available on the 🍎 <strong>App Store</strong>! Download the app and join thousands of neighbors who are reducing food waste and building community together.</p>

    <p style="margin: 24px 0 16px; font-size: 16px; line-height: 1.7; color: #555555;"><strong>🌱 With FoodShare you can:</strong></p>
    <ul style="margin: 0 0 24px; padding-left: 24px; font-size: 15px; line-height: 2; color: #555555;">
  <li><strong style="color: #ff2d55;">🍎 Share Surplus Food</strong> – Post your extra groceries for neighbors to enjoy</li>
<li><strong style="color: #00A699;">🗺️ Discover Food Near You</strong> – Browse the map to find available food in your area</li>
<li><strong style="color: #FC642D;">💬 Connect & Chat</strong> – Message neighbors to coordinate pickups</li>
<li><strong style="color: #8B5CF6;">🏆 Join Challenges</strong> – Participate in community challenges and earn rewards</li>
</ul>

    <div style="height: 1px; background: linear-gradient(90deg, transparent, #e0e0e0, transparent); margin: 24px 0;"></div>

    <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.7; color: #555555;">Be part of the movement! Every item shared is one less item wasted. Download FoodShare today and start making a difference in your community.</p>
  <table width="100%" cellpadding="0" cellspacing="0">
  <tr>
    <td align="center" style="padding: 24px 0 10px;">
      <a href="https://apps.apple.com/us/app/foodshare-club/id1573242804" style="display: inline-block; padding: 16px 40px; background: #ff2d55; color: #ffffff; text-decoration: none; border-radius: 50px; font-weight: 700; font-size: 16px; box-shadow: 0 4px 16px rgba(255, 45, 85, 0.3);">📲 Download on App Store</a>
    </td>
  </tr>
</table>
    </div>
  </td>
</tr><tr>
  <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff5177 50%, #ff6b8a 100%); padding: 32px 30px; text-align: center; border-radius: 0 0 0 0;">
    <p style="margin: 0; font-size: 22px; font-weight: 700; color: #ffffff;">Happy sharing!</p>
    <p style="margin: 8px 0 0; font-size: 15px; color: rgba(255, 255, 255, 0.9);">Team FoodShare</p>
  </td>
</tr>
<tr>
  <td style="background: #fafafa; padding: 40px 30px; text-align: center;">
    
    <table width="100%" cellpadding="0" cellspacing="0" style="margin: 0 0 20px;">
      <tr>
        <td align="center">
          <a href="https://facebook.com/foodshareclub" style="display: inline-block; margin: 0 8px; width: 36px; height: 36px; background: #363a57; border-radius: 50%; line-height: 36px; text-align: center; text-decoration: none;">
            <span style="font-size: 18px; color: #ffffff; font-family: Georgia, serif; font-weight: bold;">f</span>
          </a>
          <a href="https://www.instagram.com/foodshare.club/" style="display: inline-block; margin: 0 8px; width: 36px; height: 36px; background: #363a57; border-radius: 50%; line-height: 36px; text-align: center; text-decoration: none;">
            <span style="font-size: 14px; color: #ffffff; font-weight: 900;">IG</span>
          </a>
          <a href="https://twitter.com/foodshareclub" style="display: inline-block; margin: 0 8px; width: 36px; height: 36px; background: #363a57; border-radius: 50%; line-height: 36px; text-align: center; text-decoration: none;">
            <span style="font-size: 16px; color: #ffffff;">𝕏</span>
          </a>
        </td>
      </tr>
    </table>
    <div style="margin: 20px 0; text-align: center;">
  <p style="margin: 0 0 16px; font-size: 18px; font-weight: 700; color: #363a57;">Get the FoodShare App</p>
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td align="center">
        <table cellpadding="0" cellspacing="0">
          <tr>
            
    <td align="center" style="padding: 0 8px;">
      <a href="https://apps.apple.com/us/app/foodshare-club/id1573242804" style="display: inline-block;">
        <img src="https://***REMOVED***/storage/v1/object/public/assets/apple-store.png" alt="Download on App Store" style="height: 44px; width: auto; border-radius: 8px;" />
      </a>
    </td>
            <td align="center" style="padding: 0 8px;">
        <img src="https://***REMOVED***/storage/v1/object/public/assets/google-store.png" alt="Google Play" style="height: 44px; width: auto; border-radius: 8px; opacity: 0.35; filter: grayscale(100%);" />
      </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</div>
    <p style="margin: 0 0 8px; font-size: 13px; color: #666666;">FoodShare LLC</p>
    <p style="margin: 0 0 12px; font-size: 12px; color: #999999;">4632 Winding Way, Sacramento, CA 95841</p>
    <p style="margin: 0; font-size: 12px; color: #999999;">
      © 2026 FoodShare LLC. All rights reserved.
    </p>
    
  </td>
</tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>$HTML$,
  'Hey {{first_name}}! Exciting news! FoodShare is now available on the App Store! Download the app and join thousands of neighbors who are reducing food waste and building community together.',
  'marketing',
  true,
  '["first_name"]'::jsonb,
  1
)
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  subject = EXCLUDED.subject,
  html_content = EXCLUDED.html_content,
  text_content = EXCLUDED.text_content,
  category = EXCLUDED.category,
  is_active = EXCLUDED.is_active,
  variables = EXCLUDED.variables,
  version = EXCLUDED.version,
  updated_at = NOW();
