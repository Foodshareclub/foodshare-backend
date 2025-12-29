# Edge Functions Platform Guide

This document categorizes Edge Functions by platform usage.

## Core Functions (All Platforms)

Used by web, iOS, and Android apps:

| Function | Description |
|----------|-------------|
| `email/` | Unified email service (4 providers) |
| `send-push-notification/` | Push notifications for iOS/Android/Web |
| `search-functions/` | Search functionality |
| `update-coordinates/` | Location updates |
| `update-post-coordinates/` | Post location updates |
| `health/` | Health check endpoint |
| `geolocate-user/` | User geolocation |

## Web-Only Functions

Bot integrations and web-specific features:

| Function | Description |
|----------|-------------|
| `telegram-bot-foodshare/` | Telegram bot integration |
| `whatsapp-bot-foodshare/` | WhatsApp bot integration |
| `notify-forum-post/` | Forum post notifications |
| `notify-new-post/` | New post notifications |
| `notify-new-report/` | Report notifications |
| `notify-new-user/` | New user notifications |
| `get-translations/` | Translation service |
| `localization/` | Localization utilities |
| `cors-proxy-images/` | CORS proxy for external images |
| `hf-inference/` | HuggingFace AI inference |
| `sync-analytics/` | Analytics synchronization |
| `domain-monitor/` | Domain health monitoring |
| `process-automation-queue/` | Background automation |
| `check-upstash-services/` | Service health checks |
| `resize-tinify-upload-image/` | Image compression |
| `get-my-chat-id/` | Chat ID retrieval |

## Mobile-Only Functions

iOS and Android specific:

| Function | Description |
|----------|-------------|
| `verify-attestation/` | iOS App Attest verification |
| `get-certificate-pins/` | Certificate pinning for mobile |
| `check-login-rate/` | Login rate limiting |
| `create-listing/` | Thin client listing creation |
| `update-listing/` | Thin client listing updates |
| `validate-listing/` | Server-side listing validation |
| `delete-user/` | Account deletion |
| `match-users/` | User matching |
| `notify-new-listing/` | New listing push notifications |
| `cache-management/` | Mobile cache management |
| `cache-operation/` | Cache operations |
| `check-alerts/` | Alert checking |

## Shared Utilities

| Directory | Description |
|-----------|-------------|
| `_shared/` | Common utilities (CORS, Supabase client, email service) |

## JWT Verification Settings

Most functions require JWT authentication (`verify_jwt = true`). Exceptions:

- `telegram-bot-foodshare/` - Webhook (no JWT)
- `whatsapp-bot-foodshare/` - Webhook (no JWT)
- `email/` - Service-to-service (no JWT)
- `health/` - Public endpoint (no JWT)
