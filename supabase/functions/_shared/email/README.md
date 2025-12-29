# Email Module

Unified email provider system for FoodShare edge functions.

## Architecture

```
_shared/email/
├── index.ts              # Main exports
├── types.ts              # Type definitions
├── email-service.ts      # Orchestration service
├── resend-provider.ts    # Resend provider
├── brevo-provider.ts     # Brevo provider
├── aws-ses-provider.ts   # AWS SES provider
├── templates.ts          # Email templates
└── README.md             # This file
```

## Quick Start

```typescript
import { getEmailService } from "../_shared/email/index.ts";
import { welcomeEmail } from "../_shared/email/templates.ts";

const emailService = getEmailService();

// Send with automatic provider selection
const result = await emailService.sendEmail(
  {
    to: "user@example.com",
    subject: "Hello!",
    html: "<h1>Welcome</h1>",
  },
  "welcome"
);

// Send with specific provider
const result = await emailService.sendEmailWithProvider(
  {
    to: "user@example.com",
    subject: "Hello!",
    html: "<h1>Welcome</h1>",
  },
  "resend"
);

// Use templates
const template = welcomeEmail({ name: "John", email: "john@example.com" });
await emailService.sendEmail(
  {
    to: "john@example.com",
    ...template,
  },
  "welcome"
);
```

## Providers

### Resend

- Best for: Auth emails, critical notifications
- Env: `RESEND_API_KEY`
- Limits: 100/day (free tier)

### Brevo

- Best for: Newsletters, bulk emails
- Env: `BREVO_API_KEY`
- Limits: 300/day (free tier)

### AWS SES

- Best for: High-volume transactional
- Env: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`
- Limits: Based on account (sandbox: 200/day)

## Email Types

Priority order varies by type:

| Type           | Priority                 |
| -------------- | ------------------------ |
| `auth`         | resend → brevo → aws_ses |
| `welcome`      | resend → brevo → aws_ses |
| `chat`         | resend → brevo → aws_ses |
| `newsletter`   | brevo → aws_ses → resend |
| `notification` | resend → brevo → aws_ses |

## Features

### Single Provider (No Fallback)

Uses the first configured provider for each email type. No automatic failover.

### Circuit Breaker

Tracks failures for monitoring (5 consecutive failures logged).

### Health Monitoring

```typescript
const health = await emailService.checkAllHealth();
// Returns health score, latency, status for each provider
```

### Templates

Pre-built templates for common emails:

- `welcomeEmail()` - New user welcome
- `goodbyeEmail()` - Account deletion
- `newListingEmail()` - Food listing notification
- `chatNotificationEmail()` - New message
- `passwordResetEmail()` - Password reset
- `emailVerificationEmail()` - Email verification

## Environment Variables

```bash
# Required for each provider
RESEND_API_KEY=re_xxx
BREVO_API_KEY=xkeysib-xxx
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=xxx
AWS_REGION=us-east-1

# Defaults (optional)
EMAIL_FROM=contact@foodshare.club
EMAIL_FROM_NAME=FoodShare
```

## Unified Email Edge Function

All email operations are handled by a single `email` edge function with action-based routing:

```typescript
// Send email (provider required)
POST /functions/v1/email
{
  "action": "send",
  "to": "user@example.com",
  "subject": "Hello",
  "html": "<h1>Hi</h1>",
  "provider": "resend"  // Required: resend, brevo, or aws_ses
}

// Process email queue
POST /functions/v1/email
{
  "action": "process-queue",
  "batchSize": 50,
  "concurrency": 5
}

// Get provider recommendation
POST /functions/v1/email
{
  "action": "route",
  "emailType": "welcome",
  "forceRefresh": false
}

// Health monitoring
POST /functions/v1/email
{
  "action": "health",
  "mode": "full"  // ping, full, or status
}
```

### Database Triggers

The function also handles database triggers for welcome/goodbye emails:

```typescript
// Triggered by INSERT/DELETE on profiles table
{
  "record": { "email": "user@example.com", "first_name": "John" },
  "type": "INSERT",
  "provider": "resend"  // Optional, defaults to resend
}
```

## Migration Note

The following functions have been merged into the unified `email` function:

- `resend` → `email` with `action: "send"`
- `send-email` → `email` with `action: "send"`
- `process-email-queue` → `email` with `action: "process-queue"`
- `smart-email-route` → `email` with `action: "route"`
- `monitor-email-health` → `email` with `action: "health"`
