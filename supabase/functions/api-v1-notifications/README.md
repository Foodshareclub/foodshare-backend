# Unified Notification API v1

Enterprise-grade notification system consolidating ALL notification channels into a single, cohesive API.

## Features

- **Multi-Channel Delivery**: Email, Push, SMS, In-App
- **Smart Routing**: Automatically routes based on user preferences
- **Quiet Hours**: Respects user quiet hours with timezone support
- **Do Not Disturb**: Temporary notification blocking
- **Digest Batching**: Hourly, daily, and weekly digests
- **Priority Levels**: Critical, high, normal, low
- **Fallback Chains**: Push fails → Email → SMS
- **Scheduled Delivery**: Send at specific times
- **Delivery Tracking**: Comprehensive cross-channel tracking
- **Rate Limiting**: Per-user and per-channel limits
- **Circuit Breakers**: Per-provider resilience
- **Enterprise Audit**: Full audit trail

## Architecture

```
api-v1-notifications/
├── index.ts                    # Main router
├── lib/
│   ├── types.ts               # TypeScript definitions
│   ├── validation.ts          # Zod schemas
│   ├── auth.ts                # Multi-mode authentication
│   ├── orchestrator.ts        # Channel routing & orchestration
│   ├── channels/
│   │   ├── index.ts           # Channel registry
│   │   ├── email.ts           # Email adapter (4 providers)
│   │   ├── push.ts            # Push adapter (FCM, APNs, WebPush)
│   │   ├── sms.ts             # SMS adapter (future)
│   │   └── in-app.ts          # In-app via Supabase Realtime
│   └── handlers/
│       ├── index.ts           # Handler exports
│       └── send.ts            # Send handlers
```

## API Endpoints

### Send Notifications

#### POST /send

Send a single notification.

```bash
curl -X POST https://your-project.supabase.co/functions/v1/api-v1-notifications/send \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "uuid",
    "type": "new_message",
    "title": "New message",
    "body": "Hey, is the bread available?",
    "data": { "chatId": "xyz" },
    "channels": ["push", "email"],
    "priority": "high"
  }'
```

Response:

```json
{
  "success": true,
  "data": {
    "notificationId": "uuid",
    "userId": "uuid",
    "channels": [
      {
        "channel": "push",
        "success": true,
        "deliveredTo": ["device-token-1", "device-token-2"],
        "deliveredAt": "2024-01-01T10:00:00Z"
      },
      {
        "channel": "email",
        "success": true,
        "provider": "resend",
        "deliveredTo": ["user@example.com"],
        "deliveredAt": "2024-01-01T10:00:01Z"
      }
    ],
    "timestamp": "2024-01-01T10:00:00Z"
  }
}
```

#### POST /send/batch

Send multiple notifications in batch.

```bash
curl -X POST https://your-project.supabase.co/functions/v1/api-v1-notifications/send/batch \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "notifications": [
      {
        "userId": "uuid1",
        "type": "new_message",
        "title": "Message 1",
        "body": "Body 1"
      },
      {
        "userId": "uuid2",
        "type": "new_message",
        "title": "Message 2",
        "body": "Body 2"
      }
    ],
    "options": {
      "parallel": true
    }
  }'
```

Response:

```json
{
  "success": true,
  "data": {
    "total": 2,
    "delivered": 2,
    "failed": 0,
    "scheduled": 0,
    "blocked": 0,
    "results": [...],
    "durationMs": 1234
  }
}
```

#### POST /send/template

Send notification using a template.

```bash
curl -X POST https://your-project.supabase.co/functions/v1/api-v1-notifications/send/template \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "uuid",
    "template": "welcome",
    "variables": {
      "name": "John",
      "verificationUrl": "https://..."
    },
    "channels": ["email"]
  }'
```

### User Preferences

#### GET /preferences

Get user's notification preferences.

```bash
curl -X GET https://your-project.supabase.co/functions/v1/api-v1-notifications/preferences \
  -H "Authorization: Bearer YOUR_JWT"
```

Response:

```json
{
  "success": true,
  "data": {
    "settings": {
      "push_enabled": true,
      "email_enabled": true,
      "sms_enabled": false,
      "quiet_hours": {
        "enabled": true,
        "start": "22:00",
        "end": "08:00",
        "timezone": "America/New_York"
      },
      "dnd": {
        "enabled": false,
        "until": null
      }
    },
    "preferences": {
      "chats": {
        "push": { "enabled": true, "frequency": "instant" },
        "email": { "enabled": true, "frequency": "daily" }
      },
      "posts": {
        "push": { "enabled": true, "frequency": "instant" },
        "email": { "enabled": false, "frequency": "never" }
      }
    }
  }
}
```

#### PUT /preferences

Update notification preferences.

```bash
curl -X PUT https://your-project.supabase.co/functions/v1/api-v1-notifications/preferences \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "push_enabled": true,
    "email_enabled": true,
    "quiet_hours": {
      "enabled": true,
      "start": "22:00",
      "end": "08:00",
      "timezone": "America/New_York"
    },
    "categories": {
      "chats": {
        "push": { "enabled": true, "frequency": "instant" },
        "email": { "enabled": true, "frequency": "daily" }
      }
    }
  }'
```

#### POST /preferences/dnd

Enable Do Not Disturb mode.

```bash
curl -X POST https://your-project.supabase.co/functions/v1/api-v1-notifications/preferences/dnd \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "duration_hours": 24
  }'
```

#### DELETE /preferences/dnd

Disable Do Not Disturb mode.

```bash
curl -X DELETE https://your-project.supabase.co/functions/v1/api-v1-notifications/preferences/dnd \
  -H "Authorization: Bearer YOUR_JWT"
```

### Digest Processing (Cron)

#### POST /digest/process

Process queued digest notifications.

```bash
curl -X POST https://your-project.supabase.co/functions/v1/api-v1-notifications/digest/process \
  -H "Authorization: Bearer SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "frequency": "daily",
    "limit": 100,
    "dryRun": false
  }'
```

### Webhooks

#### POST /webhook/:provider

Handle delivery events from providers (Resend, Brevo, SES, MailerSend, FCM, APNs).

```bash
# Called by provider with signature verification
POST https://your-project.supabase.co/functions/v1/api-v1-notifications/webhook/resend
```

### Dashboard & Health

#### GET /health

Health check endpoint.

```bash
curl https://your-project.supabase.co/functions/v1/api-v1-notifications/health
```

Response:

```json
{
  "status": "healthy",
  "version": "1.0.0",
  "timestamp": "2024-01-01T10:00:00Z"
}
```

#### GET /stats

Get system statistics.

```bash
curl https://your-project.supabase.co/functions/v1/api-v1-notifications/stats
```

#### GET /dashboard

Get dashboard metrics.

```bash
curl https://your-project.supabase.co/functions/v1/api-v1-notifications/dashboard \
  -H "Authorization: Bearer YOUR_JWT"
```

## Authentication

The API supports multiple authentication modes:

- **none**: Public endpoints (`/health`, `/stats`)
- **jwt**: Standard user authentication (most endpoints)
- **service**: Service-to-service (`/digest/process`, internal calls)
- **webhook**: Webhook signature verification (`/webhook/:provider`)
- **admin**: Admin operations (`/admin/*` routes - JWT + admin role)

## Notification Types

- `new_message` - New chat message
- `listing_favorited` - Listing favorited
- `listing_expired` - Listing expired
- `arrangement_confirmed` - Arrangement confirmed
- `arrangement_cancelled` - Arrangement cancelled
- `arrangement_completed` - Arrangement completed
- `challenge_complete` - Challenge completed
- `challenge_reminder` - Challenge reminder
- `review_received` - Review received
- `review_reminder` - Review reminder
- `system_announcement` - System announcement
- `moderation_warning` - Moderation warning
- `account_security` - Account security alert
- `welcome` - Welcome email
- `verification` - Email verification
- `password_reset` - Password reset
- `digest` - Digest notification

## Categories

- `posts` - Posts & Listings
- `forum` - Forum posts
- `challenges` - Challenges
- `comments` - Comments
- `chats` - Messages
- `social` - Social (likes, follows)
- `system` - System notifications
- `marketing` - Marketing & newsletters

## Channels

- `push` - Push notifications (FCM, APNs, WebPush)
- `email` - Email (Resend, Brevo, AWS SES, MailerSend)
- `sms` - SMS (future)
- `in_app` - In-app (Supabase Realtime)

## Priority Levels

- `critical` - Always delivered, bypasses all restrictions
- `high` - High priority, bypasses quiet hours
- `normal` - Normal priority (default)
- `low` - Low priority, can be batched

## Frequencies

- `instant` - Send immediately
- `hourly` - Batch into hourly digest
- `daily` - Batch into daily digest
- `weekly` - Batch into weekly digest
- `never` - Don't send

## Database Tables

Required tables (see migration file):

- `notification_delivery_log` - Track all deliveries across channels
- `notification_queue` - Queue for scheduled/digest notifications
- `notification_digest_queue` - Queue for digest batching
- `in_app_notifications` - In-app notification storage
- `email_suppressions` - Email suppression list

## Environment Variables

Required secrets:

```bash
# Supabase
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_ANON_KEY

# Email Providers
RESEND_API_KEY
BREVO_API_KEY
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
AWS_REGION
MAILERSEND_API_KEY

# Push Providers
FCM_PROJECT_ID
FCM_CLIENT_EMAIL
FCM_PRIVATE_KEY
APNS_KEY_ID
APNS_PRIVATE_KEY
APPLE_TEAM_ID
VAPID_PUBLIC_KEY
VAPID_PRIVATE_KEY

# Webhook Secrets
RESEND_WEBHOOK_SECRET
BREVO_WEBHOOK_SECRET
AWS_SES_WEBHOOK_SECRET
MAILERSEND_WEBHOOK_SECRET

# Optional
INTERNAL_SERVICE_SECRET
```

## Deployment

```bash
# Deploy function
supabase functions deploy api-v1-notifications

# Apply database migrations
supabase db push

# Set environment variables
supabase secrets set RESEND_API_KEY=xxx
```

## Testing

```bash
# Health check
curl https://your-project.supabase.co/functions/v1/api-v1-notifications/health

# Send test notification
curl -X POST https://your-project.supabase.co/functions/v1/api-v1-notifications/send \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "YOUR_USER_ID",
    "type": "system_announcement",
    "title": "Test Notification",
    "body": "This is a test",
    "priority": "normal"
  }'
```

## Integration with Existing Systems

This API consolidates and replaces:

- `api-v1-email/` - Email operations
- `unified-notifications/` - Push notifications
- `send-digest-notifications/` - Digest processing
- `api-v1-notification-preferences/` - Preference management

All existing functions can continue to work, or migrate to use this unified API.

## Migration Path

1. Deploy `api-v1-notifications/`
2. Update client apps to call new endpoints
3. Set up cron jobs for digest processing
4. Configure webhook endpoints with providers
5. (Optional) Deprecate old notification functions

## Support

For issues or questions:

- Check function logs: `supabase functions logs api-v1-notifications`
- Review database logs for delivery tracking
- Test with `/health` endpoint first
