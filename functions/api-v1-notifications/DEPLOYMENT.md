# Deployment Guide

## Pre-Deployment Checklist

### 1. Database Preparation

```bash
# Apply database migration
cd /Users/organic/dev/work/foodshare/foodshare-backend
supabase db push

# Verify tables created
supabase db pull --dry-run
```

Expected tables:
- `notification_delivery_log`
- `notification_queue`
- `notification_digest_queue`
- `in_app_notifications`
- `email_suppressions`

### 2. Environment Variables

Set all required secrets in Supabase Dashboard → Project Settings → Edge Functions:

```bash
# Core Supabase (should already exist)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_ANON_KEY=your-anon-key

# Email Providers (reuse from api-v1-email if exists)
RESEND_API_KEY=re_xxxxx
BREVO_API_KEY=xkeysib-xxxxx
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1
MAILERSEND_API_KEY=mlsn.xxxxx

# Push Providers (reuse from unified-notifications if exists)
FCM_PROJECT_ID=your-project-id
FCM_CLIENT_EMAIL=firebase-adminsdk@...
FCM_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
APNS_KEY_ID=ABC123
APNS_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
APPLE_TEAM_ID=TEAM123
VAPID_PUBLIC_KEY=BN...
VAPID_PRIVATE_KEY=...

# Webhook Secrets (generate new ones)
RESEND_WEBHOOK_SECRET=$(openssl rand -hex 32)
BREVO_WEBHOOK_SECRET=$(openssl rand -hex 32)
AWS_SES_WEBHOOK_SECRET=$(openssl rand -hex 32)
MAILERSEND_WEBHOOK_SECRET=$(openssl rand -hex 32)

# Optional
INTERNAL_SERVICE_SECRET=$(openssl rand -hex 32)
ENVIRONMENT=production
```

Set secrets via CLI:

```bash
# Set all at once
supabase secrets set \
  RESEND_API_KEY=re_xxxxx \
  BREVO_API_KEY=xkeysib-xxxxx \
  FCM_PROJECT_ID=your-project \
  RESEND_WEBHOOK_SECRET=$(openssl rand -hex 32)

# Or individually
supabase secrets set RESEND_API_KEY=re_xxxxx
```

### 3. Verify Existing Systems

```bash
# Check if email service is working
curl https://your-project.supabase.co/functions/v1/api-v1-email/health

# Check if push notifications are working
curl https://your-project.supabase.co/functions/v1/unified-notifications/status

# Check notification preferences
curl https://your-project.supabase.co/functions/v1/api-v1-notification-preferences/health
```

## Deployment Steps

### Step 1: Deploy Function

```bash
cd /Users/organic/dev/work/foodshare/foodshare-backend

# Deploy
supabase functions deploy api-v1-notifications

# Verify deployment
supabase functions list | grep api-v1-notifications
```

### Step 2: Test Health Endpoint

```bash
# Test health (should return 200)
curl https://your-project.supabase.co/functions/v1/api-v1-notifications/health

# Expected response:
# {
#   "status": "healthy",
#   "version": "1.0.0",
#   "timestamp": "2024-01-01T10:00:00Z"
# }
```

### Step 3: Test Stats Endpoint

```bash
curl https://your-project.supabase.co/functions/v1/api-v1-notifications/stats

# Expected response:
# {
#   "success": true,
#   "data": {
#     "last24Hours": {
#       "total": 0
#     }
#   }
# }
```

### Step 4: Test Send Endpoint (Authenticated)

```bash
# Get a test JWT token first
export TEST_JWT="your-test-jwt"

# Send test notification
curl -X POST https://your-project.supabase.co/functions/v1/api-v1-notifications/send \
  -H "Authorization: Bearer $TEST_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "your-user-id",
    "type": "system_announcement",
    "title": "Test Notification",
    "body": "This is a test notification from the unified API",
    "priority": "normal"
  }'

# Expected: Success response with notification details
```

### Step 5: Configure Webhooks

#### Resend

1. Go to Resend Dashboard → Webhooks
2. Click "Add Webhook"
3. Set URL: `https://your-project.supabase.co/functions/v1/api-v1-notifications/webhook/resend`
4. Select events: `email.delivered`, `email.bounced`, `email.complained`
5. Copy webhook secret and set: `supabase secrets set RESEND_WEBHOOK_SECRET=whsec_xxxxx`

#### Brevo

1. Go to Brevo Dashboard → Transactional → Settings → Webhooks
2. Add webhook URL: `https://your-project.supabase.co/functions/v1/api-v1-notifications/webhook/brevo`
3. Select events: `delivered`, `hard_bounce`, `soft_bounce`, `complaint`
4. Set secret in env

#### MailerSend

1. Go to MailerSend Dashboard → Webhooks
2. Add webhook URL: `https://your-project.supabase.co/functions/v1/api-v1-notifications/webhook/mailersend`
3. Select events: `activity.sent`, `activity.delivered`, `activity.bounced`, `activity.complained`
4. Set secret in env

### Step 6: Set Up Cron Jobs

Create cron configuration file if it doesn't exist:

```yaml
# supabase/functions/cron.yaml
functions:
  # Hourly digest
  - name: hourly-digest
    schedule: "0 * * * *"  # Every hour at :00
    url: https://your-project.supabase.co/functions/v1/api-v1-notifications/digest/process
    method: POST
    headers:
      Authorization: "Bearer SERVICE_ROLE_KEY"
      Content-Type: "application/json"
    body: '{"frequency":"hourly","limit":1000}'

  # Daily digest
  - name: daily-digest
    schedule: "0 9 * * *"  # Every day at 9am UTC
    url: https://your-project.supabase.co/functions/v1/api-v1-notifications/digest/process
    method: POST
    headers:
      Authorization: "Bearer SERVICE_ROLE_KEY"
      Content-Type: "application/json"
    body: '{"frequency":"daily","limit":5000}'

  # Weekly digest
  - name: weekly-digest
    schedule: "0 9 * * 1"  # Every Monday at 9am UTC
    url: https://your-project.supabase.co/functions/v1/api-v1-notifications/digest/process
    method: POST
    headers:
      Authorization: "Bearer SERVICE_ROLE_KEY"
      Content-Type: "application/json"
    body: '{"frequency":"weekly","limit":10000}'

  # Cleanup old notifications
  - name: cleanup-notifications
    schedule: "0 2 * * *"  # Every day at 2am UTC
    url: https://your-project.supabase.co/functions/v1/api-v1-notifications/admin/cleanup
    method: POST
    headers:
      Authorization: "Bearer SERVICE_ROLE_KEY"
```

Apply cron configuration:

```bash
# Via Supabase Dashboard → Database → Cron Jobs
# Or via pg_cron directly
```

### Step 7: Monitor Logs

```bash
# Follow logs
supabase functions logs api-v1-notifications --follow

# Check for errors
supabase functions logs api-v1-notifications | grep ERROR

# Check recent activity
supabase functions logs api-v1-notifications --limit 100
```

## Post-Deployment Verification

### 1. End-to-End Test

```bash
# Send notification
NOTIFICATION_ID=$(curl -X POST https://your-project.supabase.co/functions/v1/api-v1-notifications/send \
  -H "Authorization: Bearer $TEST_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "your-user-id",
    "type": "system_announcement",
    "title": "E2E Test",
    "body": "End-to-end test notification"
  }' | jq -r '.data.notificationId')

echo "Notification ID: $NOTIFICATION_ID"

# Check delivery log
psql $DATABASE_URL -c "
  SELECT * FROM notification_delivery_log
  WHERE notification_id = '$NOTIFICATION_ID'
  ORDER BY created_at DESC
  LIMIT 1;
"
```

### 2. Test Preferences

```bash
# Get preferences
curl -X GET https://your-project.supabase.co/functions/v1/api-v1-notifications/preferences \
  -H "Authorization: Bearer $TEST_JWT"

# Update preferences
curl -X PUT https://your-project.supabase.co/functions/v1/api-v1-notifications/preferences \
  -H "Authorization: Bearer $TEST_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "push_enabled": true,
    "email_enabled": true
  }'

# Enable DND
curl -X POST https://your-project.supabase.co/functions/v1/api-v1-notifications/preferences/dnd \
  -H "Authorization: Bearer $TEST_JWT" \
  -H "Content-Type: application/json" \
  -d '{"duration_hours": 1}'

# Try to send (should be blocked/scheduled)
curl -X POST https://your-project.supabase.co/functions/v1/api-v1-notifications/send \
  -H "Authorization: Bearer $TEST_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "your-user-id",
    "type": "new_message",
    "title": "Test DND",
    "body": "This should be blocked or scheduled"
  }'

# Disable DND
curl -X DELETE https://your-project.supabase.co/functions/v1/api-v1-notifications/preferences/dnd \
  -H "Authorization: Bearer $TEST_JWT"
```

### 3. Test Digest Processing

```bash
# Add test items to digest queue
psql $DATABASE_URL -c "
  INSERT INTO notification_digest_queue (user_id, notification_type, category, title, body, frequency, scheduled_for)
  VALUES
    ('your-user-id', 'new_message', 'chats', 'Test 1', 'Body 1', 'hourly', NOW() - INTERVAL '1 hour'),
    ('your-user-id', 'new_message', 'chats', 'Test 2', 'Body 2', 'hourly', NOW() - INTERVAL '1 hour');
"

# Process digest (dry run)
curl -X POST https://your-project.supabase.co/functions/v1/api-v1-notifications/digest/process \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "frequency": "hourly",
    "limit": 10,
    "dryRun": true
  }'
```

### 4. Test Webhooks

```bash
# Test webhook endpoint (simulate provider)
curl -X POST https://your-project.supabase.co/functions/v1/api-v1-notifications/webhook/resend \
  -H "Content-Type: application/json" \
  -H "resend-signature: t=1234567890,v1=test_signature" \
  -d '{
    "type": "email.delivered",
    "data": {
      "email_id": "test-123",
      "to": "user@example.com",
      "status": "delivered"
    }
  }'

# Check logs for webhook processing
supabase functions logs api-v1-notifications | grep webhook
```

## Performance Testing

### Load Test with Artillery

```yaml
# artillery.yml
config:
  target: https://your-project.supabase.co
  phases:
    - duration: 60
      arrivalRate: 10
      name: "Warm up"
    - duration: 300
      arrivalRate: 50
      name: "Sustained load"

scenarios:
  - name: "Send notifications"
    flow:
      - post:
          url: /functions/v1/api-v1-notifications/send
          headers:
            Authorization: "Bearer {{ $env.TEST_JWT }}"
            Content-Type: "application/json"
          json:
            userId: "load-test-user"
            type: "system_announcement"
            title: "Load test notification"
            body: "Testing under load"
```

Run load test:

```bash
artillery run artillery.yml
```

## Monitoring Setup

### 1. Set Up Alerts

```sql
-- Create alert for high error rate
CREATE OR REPLACE FUNCTION check_notification_error_rate()
RETURNS void AS $$
DECLARE
  v_error_rate NUMERIC;
BEGIN
  SELECT
    (COUNT(*) FILTER (WHERE status = 'failed')::NUMERIC / NULLIF(COUNT(*), 0)) * 100
  INTO v_error_rate
  FROM notification_delivery_log
  WHERE created_at > NOW() - INTERVAL '1 hour';

  IF v_error_rate > 5 THEN
    -- Send alert (integrate with your monitoring system)
    RAISE WARNING 'High error rate: %', v_error_rate;
  END IF;
END;
$$ LANGUAGE plpgsql;
```

### 2. Dashboard Queries

```sql
-- Notification volume by channel (last 24h)
SELECT
  jsonb_array_elements(channels)->>'channel' AS channel,
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE status = 'delivered') AS delivered,
  COUNT(*) FILTER (WHERE status = 'failed') AS failed
FROM notification_delivery_log
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY channel
ORDER BY total DESC;

-- Top error types
SELECT
  type,
  COUNT(*) AS count,
  error
FROM notification_delivery_log
WHERE status = 'failed'
  AND created_at > NOW() - INTERVAL '24 hours'
GROUP BY type, error
ORDER BY count DESC
LIMIT 10;

-- User notification activity
SELECT
  user_id,
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE status = 'delivered') AS delivered,
  MAX(created_at) AS last_notification
FROM notification_delivery_log
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY user_id
ORDER BY total DESC
LIMIT 20;
```

## Rollback Procedure

If issues occur:

### 1. Emergency Rollback

```bash
# Revert to previous deployment
supabase functions deploy api-v1-notifications --no-verify-jwt

# Or disable function temporarily
# (via Supabase Dashboard → Edge Functions)
```

### 2. Partial Rollback

Route traffic back to old endpoints via feature flag:

```typescript
// In client app
const USE_UNIFIED_API = false; // Switch to false to rollback

if (USE_UNIFIED_API) {
  await sendViaUnifiedAPI(notification);
} else {
  await sendViaOldAPI(notification);
}
```

### 3. Database Rollback

Database changes are non-destructive. Old tables remain intact.

```bash
# If needed, drop new tables
psql $DATABASE_URL -c "
  DROP TABLE IF EXISTS notification_delivery_log CASCADE;
  DROP TABLE IF EXISTS notification_queue CASCADE;
  DROP TABLE IF EXISTS notification_digest_queue CASCADE;
  DROP TABLE IF EXISTS in_app_notifications CASCADE;
  DROP TABLE IF EXISTS email_suppressions CASCADE;
"
```

## Success Criteria

- [ ] Health endpoint returns 200
- [ ] All authentication modes work
- [ ] Send notification succeeds for all channels
- [ ] User preferences can be updated
- [ ] DND mode works correctly
- [ ] Digest processing runs successfully
- [ ] Webhooks receive and process events
- [ ] Dashboard metrics are accurate
- [ ] Logs show no errors
- [ ] Performance meets SLA (p95 < 500ms)
- [ ] Error rate < 0.1%

## Support

- **Logs**: `supabase functions logs api-v1-notifications`
- **Database**: Check `notification_delivery_log` table
- **Health**: Monitor `/health` endpoint
- **Dashboard**: Check `/dashboard` for metrics
- **Documentation**: See README.md, EXAMPLES.md, INTEGRATION.md
