# FoodShare Telegram Bot

Telegram bot for the FoodShare platform - enabling users to share and find surplus food via Telegram.

## Features

- **Share Food** - Post surplus food with photo, description, and location
- **Find Food** - Search for available food nearby
- **User Profiles** - Link Telegram account to FoodShare profile via email verification
- **Impact Tracking** - View environmental impact statistics
- **Multi-language** - Supports English, Russian, and German
- **Leaderboard** - See top contributors

## Commands

| Command         | Description                      |
| --------------- | -------------------------------- |
| `/start`        | Start the bot and register/login |
| `/share`        | Share surplus food               |
| `/find [query]` | Search for food                  |
| `/nearby`       | Find food near your location     |
| `/profile`      | View your profile                |
| `/impact`       | View your environmental impact   |
| `/stats`        | View your activity statistics    |
| `/leaderboard`  | See top contributors             |
| `/language`     | Change bot language              |
| `/help`         | Show all commands                |
| `/cancel`       | Cancel current action            |
| `/resend`       | Resend verification code         |

## Architecture

```
telegram-bot-foodshare/
├── index.ts              # Main entry point (Deno.serve)
├── config.toml           # Supabase function config
├── config/
│   ├── index.ts          # Environment config
│   └── constants.ts      # App constants
├── types/
│   └── index.ts          # TypeScript definitions
├── lib/
│   ├── i18n.ts           # Internationalization
│   ├── keyboards.ts      # Telegram keyboard builders
│   ├── messages.ts       # Message formatting
│   └── emojis.ts         # Emoji constants
├── locales/
│   ├── en.ts             # English translations
│   ├── ru.ts             # Russian translations
│   └── de.ts             # German translations
├── services/
│   ├── supabase.ts       # Database client
│   ├── telegram-api.ts   # Telegram Bot API
│   ├── telegram-files.ts # File upload handling
│   ├── profile.ts        # User profile management
│   ├── email.ts          # Email verification
│   ├── user-state.ts     # Conversation state
│   ├── geocoding.ts      # Location services
│   ├── impact.ts         # Impact calculations
│   ├── tracking.ts       # Activity tracking
│   ├── cache.ts          # In-memory caching
│   └── rate-limiter.ts   # Rate limiting
├── handlers/
│   ├── commands.ts       # Command handlers
│   ├── messages.ts       # Text/photo/location handlers
│   ├── callbacks.ts      # Inline button handlers
│   └── auth.ts           # Email verification flow
└── utils/
    ├── validation.ts     # Input validation
    ├── errors.ts         # Error handling
    ├── timeout.ts        # Async timeouts
    └── circuit-breaker.ts # Fault tolerance
```

## Deployment

### Prerequisites

- Supabase CLI installed
- Project linked: `supabase link --project-ref <project-id>`

### Environment Variables

Set these secrets in Supabase:

```bash
supabase secrets set BOT_TOKEN=<telegram-bot-token>
supabase secrets set SUPABASE_URL=<supabase-url>
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
supabase secrets set APP_URL=https://foodshare.club
```

### Deploy

```bash
supabase functions deploy telegram-bot-foodshare
```

### Setup Webhook

After deployment, set the Telegram webhook:

```bash
curl "https://<project-id>.supabase.co/functions/v1/telegram-bot-foodshare/setup-webhook?url=https://<project-id>.supabase.co/functions/v1/telegram-bot-foodshare"
```

### Health Check

```bash
curl "https://<project-id>.supabase.co/functions/v1/telegram-bot-foodshare/health"
```

## User Flow

### New User Registration

1. User sends `/start`
2. Bot asks for email
3. User enters email
4. Bot sends 6-digit verification code
5. User enters code
6. Profile linked, menu buttons appear

### Existing User Sign-In

1. User sends `/start`
2. Bot detects existing email, asks to verify
3. User enters verification code
4. Telegram account linked to existing profile

### Sharing Food

1. User clicks "Share" or sends `/share`
2. Bot asks for photo
3. User sends photo
4. Bot asks for description
5. User enters description
6. Bot asks for location (GPS or address)
7. Post created and published

## Database Requirements

The `profiles` table must have:

- `id` (uuid, primary key)
- `telegram_id` (bigint, nullable, unique)
- `email` (text)
- `email_verified` (boolean)
- `first_name` (text)
- `nickname` (text)
- `verification_code` (text)
- `verification_code_expires_at` (timestamptz)
- `language` (text)
- `location` (geography/point)

## Security

- `verify_jwt = false` in config.toml (required for Telegram webhooks)
- Email verification required for posting
- Rate limiting on requests
- Location privacy (200m approximation for shared locations)
- Input validation on all user inputs

## Troubleshooting

### Bot not responding

1. Check webhook: `curl .../health`
2. Verify BOT_TOKEN is set correctly
3. Check function logs in Supabase dashboard

### Menu buttons not working

1. User needs to complete email verification
2. Send `/cancel` to clear stuck state
3. Send `/start` to re-register

### Verification emails not arriving

1. Check Resend edge function is deployed
2. Verify RESEND_API_KEY is set
3. Check spam folder

## Version

**v3.1** - Modular architecture with email verification
