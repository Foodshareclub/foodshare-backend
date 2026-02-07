# Integration Guide

## Consolidation Overview

This unified notification API consolidates **ALL** notification operations from these existing functions:

### 1. api-v1-email/
**Status**: Can be kept or replaced
**Migration**: All email operations now available at `/send` endpoint with `channels: ["email"]`

```typescript
// Old
POST /api-v1-email/send
{ to, subject, body }

// New
POST /api-v1-notifications/send
{ userId, type, title, body, channels: ["email"] }
```

### 2. unified-notifications/
**Status**: Can be kept or replaced
**Migration**: Push notifications now at `/send` with `channels: ["push"]`

```typescript
// Old
POST /unified-notifications/send
{ userId, type, title, body }

// New
POST /api-v1-notifications/send
{ userId, type, title, body, channels: ["push"] }
```

### 3. send-digest-notifications/
**Status**: Replace with new endpoint
**Migration**: Use `/digest/process` endpoint

```typescript
// Old
POST /send-digest-notifications
{ frequency, limit, dryRun }

// New
POST /api-v1-notifications/digest/process
{ frequency, limit, dryRun }
```

### 4. api-v1-notification-preferences/
**Status**: Keep or replace
**Migration**: All preference operations available at `/preferences`

```typescript
// Old
GET /api-v1-notification-preferences
PUT /api-v1-notification-preferences

// New
GET /api-v1-notifications/preferences
PUT /api-v1-notifications/preferences
```

## Migration Strategies

### Strategy 1: Gradual Migration (Recommended)
Keep all existing functions and gradually migrate clients to the new unified API.

**Advantages**:
- Zero downtime
- Gradual rollout
- Easy rollback
- Test in production

**Steps**:
1. Deploy `api-v1-notifications/`
2. Update client SDKs to support both old and new endpoints
3. Add feature flag for unified notifications
4. Migrate users gradually
5. Monitor metrics
6. Deprecate old endpoints after 90 days

### Strategy 2: Direct Replacement
Replace old functions with proxies to the new API.

**Advantages**:
- Single source of truth
- Simplified codebase
- Immediate benefits

**Implementation**:
```typescript
// api-v1-email/index.ts
import { proxyToUnified } from "./proxy.ts";

Deno.serve(async (req) => {
  return await proxyToUnified(req, "email");
});
```

### Strategy 3: Parallel Run
Run both systems in parallel and compare results.

**Advantages**:
- Validate behavior
- Catch edge cases
- Build confidence

## Client Integration

### Web (React/Next.js)

```typescript
// lib/notifications.ts
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(url, anonKey)

export async function sendNotification(params: {
  userId: string
  type: string
  title: string
  body: string
  channels?: string[]
  priority?: string
}) {
  const { data, error } = await supabase.functions.invoke(
    'api-v1-notifications/send',
    {
      body: params,
    }
  )

  if (error) throw error
  return data
}

export async function getPreferences() {
  const { data, error } = await supabase.functions.invoke(
    'api-v1-notifications/preferences',
    { method: 'GET' }
  )

  if (error) throw error
  return data
}

export async function updatePreferences(settings: any) {
  const { data, error } = await supabase.functions.invoke(
    'api-v1-notifications/preferences',
    {
      body: settings,
    }
  )

  if (error) throw error
  return data
}
```

### iOS (Swift)

```swift
// NotificationService.swift
import Supabase

class NotificationService {
    let supabase = SupabaseClient(
        supabaseURL: URL(string: "https://your-project.supabase.co")!,
        supabaseKey: "your-anon-key"
    )

    func sendNotification(
        userId: String,
        type: String,
        title: String,
        body: String,
        channels: [String]? = nil,
        priority: String? = nil
    ) async throws -> NotificationResponse {
        let params: [String: Any] = [
            "userId": userId,
            "type": type,
            "title": title,
            "body": body,
            "channels": channels ?? [],
            "priority": priority ?? "normal"
        ]

        let response = try await supabase.functions.invoke(
            "api-v1-notifications/send",
            options: FunctionInvokeOptions(
                body: params
            )
        )

        return try JSONDecoder().decode(NotificationResponse.self, from: response.data)
    }

    func getPreferences() async throws -> NotificationPreferences {
        let response = try await supabase.functions.invoke(
            "api-v1-notifications/preferences",
            options: FunctionInvokeOptions(method: "GET")
        )

        return try JSONDecoder().decode(NotificationPreferences.self, from: response.data)
    }
}

struct NotificationResponse: Codable {
    let success: Bool
    let data: NotificationResult?
    let error: String?
}

struct NotificationResult: Codable {
    let notificationId: String
    let userId: String
    let channels: [ChannelResult]
    let timestamp: String
}

struct ChannelResult: Codable {
    let channel: String
    let success: Bool
    let deliveredTo: [String]?
    let error: String?
}
```

### Android (Kotlin)

```kotlin
// NotificationService.kt
import io.github.jan.supabase.createSupabaseClient
import io.github.jan.supabase.functions.Functions
import io.github.jan.supabase.functions.functions
import kotlinx.serialization.Serializable

class NotificationService {
    private val supabase = createSupabaseClient(
        supabaseUrl = "https://your-project.supabase.co",
        supabaseKey = "your-anon-key"
    ) {
        install(Functions)
    }

    suspend fun sendNotification(
        userId: String,
        type: String,
        title: String,
        body: String,
        channels: List<String>? = null,
        priority: String? = null
    ): NotificationResponse {
        val params = mapOf(
            "userId" to userId,
            "type" to type,
            "title" to title,
            "body" to body,
            "channels" to (channels ?: emptyList()),
            "priority" to (priority ?: "normal")
        )

        return supabase.functions.invoke(
            "api-v1-notifications/send",
            body = params
        )
    }

    suspend fun getPreferences(): NotificationPreferences {
        return supabase.functions.invoke(
            "api-v1-notifications/preferences"
        )
    }
}

@Serializable
data class NotificationResponse(
    val success: Boolean,
    val data: NotificationResult? = null,
    val error: String? = null
)

@Serializable
data class NotificationResult(
    val notificationId: String,
    val userId: String,
    val channels: List<ChannelResult>,
    val timestamp: String
)

@Serializable
data class ChannelResult(
    val channel: String,
    val success: Boolean,
    val deliveredTo: List<String>? = null,
    val error: String? = null
)
```

## Cron Jobs

Update cron configuration to use new digest endpoint:

```yaml
# supabase/functions/cron.yaml
digests:
  - name: hourly-digest
    schedule: "0 * * * *"  # Every hour
    function: api-v1-notifications/digest/process
    body: '{"frequency":"hourly","limit":1000}'

  - name: daily-digest
    schedule: "0 9 * * *"  # Every day at 9am UTC
    function: api-v1-notifications/digest/process
    body: '{"frequency":"daily","limit":5000}'

  - name: weekly-digest
    schedule: "0 9 * * 1"  # Every Monday at 9am UTC
    function: api-v1-notifications/digest/process
    body: '{"frequency":"weekly","limit":10000}'
```

## Webhook Configuration

Update webhook URLs with providers:

### Resend
```bash
Dashboard → Webhooks → Add Webhook
URL: https://your-project.supabase.co/functions/v1/api-v1-notifications/webhook/resend
Events: email.delivered, email.bounced, email.complained
```

### Brevo
```bash
Dashboard → Webhooks → Add Webhook
URL: https://your-project.supabase.co/functions/v1/api-v1-notifications/webhook/brevo
Events: delivered, hard_bounce, soft_bounce, complaint
```

### AWS SES
```bash
SNS Topic → Create subscription
Endpoint: https://your-project.supabase.co/functions/v1/api-v1-notifications/webhook/ses
```

### MailerSend
```bash
Dashboard → Webhooks → Add Webhook
URL: https://your-project.supabase.co/functions/v1/api-v1-notifications/webhook/mailersend
Events: activity.sent, activity.delivered, activity.bounced, activity.complained
```

## Monitoring

### Health Checks

```bash
# Add to monitoring system
curl https://your-project.supabase.co/functions/v1/api-v1-notifications/health
```

### Metrics

```bash
# Dashboard endpoint
curl https://your-project.supabase.co/functions/v1/api-v1-notifications/dashboard \
  -H "Authorization: Bearer YOUR_JWT"
```

### Logs

```bash
# Supabase logs
supabase functions logs api-v1-notifications --follow

# Filter errors
supabase functions logs api-v1-notifications | grep ERROR
```

## Rollback Plan

If issues occur:

1. **Immediate**: Switch traffic back to old endpoints via feature flag
2. **Database**: Migration is non-destructive, old tables remain
3. **Functions**: Old functions still deployed and operational
4. **Client Apps**: Gracefully fall back to old SDK methods

## Testing Checklist

- [ ] Health endpoint returns 200
- [ ] Send single notification (push)
- [ ] Send single notification (email)
- [ ] Send batch notifications
- [ ] Send template notification
- [ ] Get user preferences
- [ ] Update user preferences
- [ ] Enable/disable DND
- [ ] Process digest (dry run)
- [ ] Webhook delivery events
- [ ] Dashboard metrics
- [ ] Rate limiting works
- [ ] Circuit breakers work
- [ ] Quiet hours respected
- [ ] Priority bypasses work
- [ ] Fallback chain works
- [ ] In-app notifications via Realtime

## Performance Targets

- **p50**: < 100ms
- **p95**: < 500ms
- **p99**: < 1000ms
- **Error rate**: < 0.1%
- **Availability**: > 99.9%

## Support

For migration assistance:
- Review function logs
- Check database migration status
- Test with health endpoint
- Monitor dashboard metrics
