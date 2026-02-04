# API Examples

Comprehensive examples for all notification API endpoints.

## Send Notifications

### Example 1: Simple Push Notification

```bash
curl -X POST https://your-project.supabase.co/functions/v1/api-v1-notifications/send \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "123e4567-e89b-12d3-a456-426614174000",
    "type": "new_message",
    "title": "New message from John",
    "body": "Hey, is the bread still available?",
    "data": {
      "chatId": "chat-123",
      "senderId": "user-456"
    }
  }'
```

### Example 2: Multi-Channel Notification

```bash
curl -X POST https://your-project.supabase.co/functions/v1/api-v1-notifications/send \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "123e4567-e89b-12d3-a456-426614174000",
    "type": "arrangement_confirmed",
    "title": "Pickup confirmed",
    "body": "Your pickup has been confirmed for tomorrow at 2pm",
    "channels": ["push", "email", "in_app"],
    "priority": "high",
    "imageUrl": "https://example.com/bread.jpg",
    "data": {
      "arrangementId": "arr-789",
      "pickupTime": "2024-01-02T14:00:00Z"
    }
  }'
```

### Example 3: Critical Notification (Bypasses All Settings)

```bash
curl -X POST https://your-project.supabase.co/functions/v1/api-v1-notifications/send \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "123e4567-e89b-12d3-a456-426614174000",
    "type": "account_security",
    "title": "Security Alert",
    "body": "New login detected from an unrecognized device",
    "channels": ["push", "email", "sms"],
    "priority": "critical",
    "data": {
      "location": "New York, NY",
      "device": "iPhone 15 Pro",
      "timestamp": "2024-01-01T10:00:00Z"
    }
  }'
```

### Example 4: Scheduled Notification

```bash
curl -X POST https://your-project.supabase.co/functions/v1/api-v1-notifications/send \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "123e4567-e89b-12d3-a456-426614174000",
    "type": "challenge_reminder",
    "title": "Challenge reminder",
    "body": "Don't forget to complete your weekly food sharing challenge!",
    "scheduledFor": "2024-01-05T09:00:00Z",
    "data": {
      "challengeId": "ch-123"
    }
  }'
```

### Example 5: Batch Notifications

```bash
curl -X POST https://your-project.supabase.co/functions/v1/api-v1-notifications/send/batch \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "notifications": [
      {
        "userId": "user-1",
        "type": "listing_favorited",
        "title": "Someone favorited your listing",
        "body": "Your Fresh Bread listing was favorited"
      },
      {
        "userId": "user-2",
        "type": "new_message",
        "title": "New message",
        "body": "You have a new message"
      },
      {
        "userId": "user-3",
        "type": "review_received",
        "title": "New review",
        "body": "You received a 5-star review!"
      }
    ],
    "options": {
      "parallel": true,
      "stopOnError": false
    }
  }'
```

### Example 6: Template Notification

```bash
curl -X POST https://your-project.supabase.co/functions/v1/api-v1-notifications/send/template \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "123e4567-e89b-12d3-a456-426614174000",
    "template": "welcome",
    "variables": {
      "name": "John Doe",
      "verificationUrl": "https://example.com/verify?token=xyz",
      "supportEmail": "support@foodshare.com"
    },
    "channels": ["email"],
    "priority": "normal"
  }'
```

## User Preferences

### Example 7: Get Preferences

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
      },
      "social": {
        "push": { "enabled": true, "frequency": "instant" },
        "email": { "enabled": true, "frequency": "weekly" }
      }
    }
  }
}
```

### Example 8: Update Global Settings

```bash
curl -X PUT https://your-project.supabase.co/functions/v1/api-v1-notifications/preferences \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "push_enabled": true,
    "email_enabled": true,
    "sms_enabled": false,
    "quiet_hours": {
      "enabled": true,
      "start": "22:00",
      "end": "08:00",
      "timezone": "America/New_York"
    }
  }'
```

### Example 9: Update Category Preferences

```bash
curl -X PUT https://your-project.supabase.co/functions/v1/api-v1-notifications/preferences \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "categories": {
      "chats": {
        "push": { "enabled": true, "frequency": "instant" },
        "email": { "enabled": true, "frequency": "daily" }
      },
      "posts": {
        "push": { "enabled": true, "frequency": "instant" },
        "email": { "enabled": false, "frequency": "never" }
      },
      "marketing": {
        "push": { "enabled": false, "frequency": "never" },
        "email": { "enabled": true, "frequency": "weekly" }
      }
    }
  }'
```

### Example 10: Enable Do Not Disturb (8 hours)

```bash
curl -X POST https://your-project.supabase.co/functions/v1/api-v1-notifications/preferences/dnd \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "duration_hours": 8
  }'
```

### Example 11: Enable DND Until Specific Time

```bash
curl -X POST https://your-project.supabase.co/functions/v1/api-v1-notifications/preferences/dnd \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "until": "2024-01-02T09:00:00Z"
  }'
```

### Example 12: Disable Do Not Disturb

```bash
curl -X DELETE https://your-project.supabase.co/functions/v1/api-v1-notifications/preferences/dnd \
  -H "Authorization: Bearer YOUR_JWT"
```

## Digest Processing (Cron)

### Example 13: Process Hourly Digest

```bash
curl -X POST https://your-project.supabase.co/functions/v1/api-v1-notifications/digest/process \
  -H "Authorization: Bearer SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "frequency": "hourly",
    "limit": 1000,
    "dryRun": false
  }'
```

### Example 14: Dry Run Daily Digest

```bash
curl -X POST https://your-project.supabase.co/functions/v1/api-v1-notifications/digest/process \
  -H "Authorization: Bearer SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "frequency": "daily",
    "limit": 100,
    "dryRun": true
  }'
```

Response:
```json
{
  "success": true,
  "data": {
    "frequency": "daily",
    "usersProcessed": 45,
    "notificationsSent": 45,
    "notificationsFailed": 0,
    "emailsSent": 42,
    "emailsFailed": 3,
    "errors": [],
    "dryRun": true,
    "durationMs": 2345
  }
}
```

## Dashboard & Monitoring

### Example 15: Health Check

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

### Example 16: System Statistics

```bash
curl https://your-project.supabase.co/functions/v1/api-v1-notifications/stats
```

Response:
```json
{
  "success": true,
  "data": {
    "last24Hours": {
      "total": 15234,
      "delivered": 14892,
      "failed": 342,
      "pending": 0
    }
  }
}
```

### Example 17: Dashboard Metrics

```bash
curl https://your-project.supabase.co/functions/v1/api-v1-notifications/dashboard \
  -H "Authorization: Bearer YOUR_JWT"
```

Response:
```json
{
  "success": true,
  "data": {
    "period": "24h",
    "total": 15234,
    "delivered": 14892,
    "failed": 342
  }
}
```

## Response Structures

### Success Response (Single Notification)

```json
{
  "success": true,
  "data": {
    "notificationId": "123e4567-e89b-12d3-a456-426614174000",
    "userId": "user-123",
    "channels": [
      {
        "channel": "push",
        "success": true,
        "deliveredTo": ["device-token-1", "device-token-2"],
        "attemptedAt": "2024-01-01T10:00:00Z",
        "deliveredAt": "2024-01-01T10:00:01Z"
      },
      {
        "channel": "email",
        "success": true,
        "provider": "resend",
        "deliveredTo": ["user@example.com"],
        "attemptedAt": "2024-01-01T10:00:00Z",
        "deliveredAt": "2024-01-01T10:00:02Z"
      }
    ],
    "timestamp": "2024-01-01T10:00:00Z"
  }
}
```

### Scheduled Response

```json
{
  "success": true,
  "data": {
    "notificationId": "123e4567-e89b-12d3-a456-426614174000",
    "userId": "user-123",
    "channels": [],
    "scheduled": true,
    "scheduledFor": "2024-01-05T09:00:00Z",
    "reason": "quiet_hours",
    "timestamp": "2024-01-01T10:00:00Z"
  }
}
```

### Blocked Response

```json
{
  "success": false,
  "data": {
    "notificationId": "123e4567-e89b-12d3-a456-426614174000",
    "userId": "user-123",
    "channels": [],
    "blocked": true,
    "reason": "blocked_by_preferences",
    "timestamp": "2024-01-01T10:00:00Z"
  }
}
```

### Error Response

```json
{
  "success": false,
  "error": "Validation error: userId is required",
  "requestId": "req-123"
}
```

## Integration Examples

### JavaScript/TypeScript

```typescript
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
)

// Send notification
async function sendNotification() {
  const { data, error } = await supabase.functions.invoke(
    'api-v1-notifications/send',
    {
      body: {
        userId: 'user-123',
        type: 'new_message',
        title: 'New message',
        body: 'You have a new message',
      },
    }
  )

  if (error) {
    console.error('Error:', error)
    return
  }

  console.log('Notification sent:', data)
}

// Get preferences
async function getPreferences() {
  const { data, error } = await supabase.functions.invoke(
    'api-v1-notifications/preferences',
    { method: 'GET' }
  )

  if (error) {
    console.error('Error:', error)
    return
  }

  console.log('Preferences:', data)
}

// Enable DND
async function enableDnd(hours: number) {
  const { data, error } = await supabase.functions.invoke(
    'api-v1-notifications/preferences/dnd',
    {
      body: { duration_hours: hours },
    }
  )

  if (error) {
    console.error('Error:', error)
    return
  }

  console.log('DND enabled:', data)
}
```

### Python

```python
from supabase import create_client, Client

supabase: Client = create_client(
    os.environ['SUPABASE_URL'],
    os.environ['SUPABASE_ANON_KEY']
)

# Send notification
def send_notification():
    response = supabase.functions.invoke(
        'api-v1-notifications/send',
        {
            'body': {
                'userId': 'user-123',
                'type': 'new_message',
                'title': 'New message',
                'body': 'You have a new message',
            }
        }
    )

    print('Notification sent:', response.json())

# Get preferences
def get_preferences():
    response = supabase.functions.invoke(
        'api-v1-notifications/preferences',
        {'method': 'GET'}
    )

    print('Preferences:', response.json())
```

## Testing Tips

1. **Start with health check**: Always verify the API is running
2. **Test with dry run**: Use `dryRun: true` for digest processing
3. **Check logs**: Use `supabase functions logs api-v1-notifications`
4. **Monitor dashboard**: Check `/dashboard` endpoint for metrics
5. **Test preferences**: Verify quiet hours and DND work as expected
6. **Test fallbacks**: Disable push to see email fallback
7. **Test priority**: Send critical notifications during quiet hours
8. **Test batching**: Send multiple notifications in batch

## Common Issues

### Issue: "Authentication failed"
**Solution**: Check JWT token is valid and not expired

### Issue: "No device tokens found"
**Solution**: Ensure user has registered device tokens in `device_tokens` table

### Issue: "Email suppressed"
**Solution**: Check `email_suppressions` table for user's email

### Issue: "Blocked by preferences"
**Solution**: Check user's notification preferences and quiet hours settings

### Issue: "Webhook signature invalid"
**Solution**: Verify webhook secret matches provider configuration
