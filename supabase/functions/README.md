# Supabase Edge Functions

Edge Functions for the FoodShare platform.

## 📁 Functions

- **telegram-bot-foodshare** - Telegram bot integration
- **notify-new-post** - Post notifications
- **notify-new-user** - User onboarding
- **resend** - Email service
- **smart-email-route** - Email routing
- **process-email-queue** - Email processing
- **monitor-email-health** - Email monitoring
- **resize-tinify-upload-image** - Image optimization
- **search-functions** - Search functionality
- **localization** - i18n services
- **get-translations** - Translation API
- **update-coordinates** - Location updates
- **update-post-coordinates** - Post locations
- **cors-proxy-images** - Image proxy
- **hf-inference** - AI inference
- **check-upstash-services** - Health checks
- **get-my-chat-id** - Telegram utility

## 🚀 Deploy

```bash
# Deploy all
./scripts/deploy/edge-functions/deploy-all-modern.sh

# Deploy one
supabase functions deploy function-name --no-verify-jwt
```

## 📖 Documentation

- **Deployment**: `docs/supabase/edge-functions/`
- **Scripts**: `scripts/deploy/edge-functions/`
- **Telegram Bot**: `docs/telegram-bot/`
