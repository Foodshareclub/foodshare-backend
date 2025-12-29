# Geolocate User - Before User Created Hook

This edge function captures the user's approximate location from their IP address during signup using the Supabase `before-user-created` auth hook.

## Overview

When a user signs up, this hook:
1. Receives the signup request with the user's IP address
2. Calls ip-api.com to get geolocation data
3. Returns the location data to be stored in `user_metadata.signup_location`
4. The database trigger then extracts this and stores it in `profiles.location`

## Setup

### 1. Deploy the Edge Function

```bash
npx supabase functions deploy geolocate-user --no-verify-jwt
```

Note: `--no-verify-jwt` is required because auth hooks run before a JWT is issued.

### 2. Set the Webhook Secret

Generate a secret in the Supabase Dashboard (Authentication > Hooks) or use an existing one:

```bash
npx supabase secrets set BEFORE_USER_CREATED_HOOK_SECRET="v1,whsec_H1FKF4nExp13Axg51dUZ7j1G8xAc14/xoQtPiv6Jsm0="
```

### 3. Configure the Auth Hook

#### For Production (Hosted Supabase)

**⚠️ HTTP hooks must be configured via the Dashboard - the Management API does not support this.**

1. Go to: https://supabase.com/dashboard/project/***REMOVED***/auth/hooks
2. Find "Before User Created" hook
3. Select "HTTP" as the hook type
4. Set URI to: `https://***REMOVED***/functions/v1/geolocate-user`
5. Set Secret to: `v1,whsec_H1FKF4nExp13Axg51dUZ7j1G8xAc14/xoQtPiv6Jsm0=`
6. Click "Save"

#### For Local Development

The hook is already configured in `supabase/config.toml`:

```toml
[auth.hook.before_user_created]
enabled = true
uri = "http://host.docker.internal:54321/functions/v1/geolocate-user"
secrets = "env(BEFORE_USER_CREATED_HOOK_SECRET)"
```

Add the secret to `supabase/functions/.env`:

```ini
BEFORE_USER_CREATED_HOOK_SECRET='v1,whsec_H1FKF4nExp13Axg51dUZ7j1G8xAc14/xoQtPiv6Jsm0='
```

Then start local development:

```bash
npx supabase start
npx supabase functions serve geolocate-user --no-verify-jwt
```

### 4. Database Migration

The database trigger to extract location from user_metadata is already applied. It:
- Listens for new user insertions in `auth.users`
- Extracts `signup_location` from `raw_user_meta_data`
- Creates a PostGIS geography point in `profiles.location`

## How It Works

### Request Flow

```
User Signup Request
       ↓
Supabase Auth (before-user-created hook)
       ↓
geolocate-user Edge Function
       ↓
ip-api.com (IP geolocation)
       ↓
Returns user_metadata with signup_location
       ↓
User created in auth.users
       ↓
Database trigger extracts location to profiles.location
```

### Payload Example

The hook receives:
```json
{
  "metadata": {
    "uuid": "8b34dcdd-9df1-4c10-850a-b3277c653040",
    "time": "2025-04-29T13:13:24.755552-07:00",
    "name": "before-user-created",
    "ip_address": "203.0.113.42"
  },
  "user": {
    "id": "ff7fc9ae-3b1b-4642-9241-64adb9848a03",
    "email": "user@example.com",
    ...
  }
}
```

The hook returns:
```json
{
  "user_metadata": {
    "signup_location": {
      "latitude": 51.5074,
      "longitude": -0.1278,
      "city": "London",
      "region": "England",
      "country": "United Kingdom",
      "country_code": "GB",
      "source": "ip_geolocation",
      "captured_at": "2025-12-25T10:30:00.000Z"
    }
  }
}
```

## Testing

### Test the Edge Function Directly

```bash
curl -X POST https://***REMOVED***/functions/v1/geolocate-user \
  -H "Content-Type: application/json" \
  -d '{
    "metadata": {
      "ip_address": "8.8.8.8",
      "name": "before-user-created"
    },
    "user": {
      "id": "test-user-id",
      "email": "test@example.com"
    }
  }'
```

Note: Without proper webhook headers, signature verification will fail. This is expected in production.

### Test with Actual Signup

1. Enable the hook in the Dashboard
2. Create a new user via signup
3. Check the user's `raw_user_meta_data` in `auth.users`
4. Check the `location` column in `profiles`

## Error Handling

The function is designed to **never block signups**:
- If IP geolocation fails, signup proceeds without location
- If webhook verification fails, an error is returned (signup blocked for security)
- All errors are logged for debugging

## IP Geolocation Provider

Uses [ip-api.com](http://ip-api.com) (free tier):
- Rate limit: 45 requests/minute
- No API key required
- For higher volume, consider ipinfo.io or ipstack with API keys

## Security

- Webhook signature verification using Standard Webhooks
- Private/local IPs are skipped (127.0.0.1, 192.168.x.x, etc.)
- Location data is approximate (city-level, not exact address)
- No sensitive data is logged
