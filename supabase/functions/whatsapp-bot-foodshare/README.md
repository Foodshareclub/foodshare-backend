# FoodShare WhatsApp Bot

WhatsApp bot for the FoodShare platform - enabling users to share and find surplus food via WhatsApp.

## Features

- **Share Food** - Post surplus food with photo, description, and location
- **Find Food** - Search for available food
- **Nearby Food** - Find food near your location
- **User Profiles** - Link WhatsApp account via email verification
- **Impact Tracking** - View environmental impact statistics
- **Multi-language** - Supports English, Russian, and German
- **Leaderboard** - See top contributors

## Architecture

```
whatsapp-bot-foodshare/
├── index.ts              # Main entry point (Deno.serve)
├── config.toml           # Supabase function config
├── config/
│   ├── index.ts          # Environment config
│   └── constants.ts      # App constants
├── types/
│   └── index.ts          # TypeScript definitions
├── lib/
│   ├── i18n.ts           # Internationalization
│   ├── interactive.ts    # Button/list builders
│   └── emojis.ts         # Emoji constants
├── locales/
│   ├── en.ts             # English translations
│   ├── ru.ts             # Russian translations
│   └── de.ts             # German translations
├── services/
│   ├── supabase.ts       # Database client
│   ├── whatsapp-api.ts   # WhatsApp Cloud API
│   ├── profile.ts        # User profile management
│   ├── email.ts          # Email verification
│   ├── user-state.ts     # Conversation state
│   ├── geocoding.ts      # Location services
│   ├── impact.ts         # Impact calculations
│   └── rate-limiter.ts   # Rate limiting
├── handlers/
│   ├── messages.ts       # Text/photo/location handlers
│   ├── interactive.ts    # Button/list reply handlers
│   └── auth.ts           # Email verification flow
└── utils/
    ├── validation.ts     # Input validation
    ├── errors.ts         # Error handling
    ├── timeout.ts        # Async timeouts
    └── circuit-breaker.ts # Fault tolerance
```

## Deployment

### Prerequisites

1. Meta Business account with WhatsApp Business API access
2. Supabase CLI installed
3. Project linked: `supabase link --project-ref <project-id>`

### Environment Variables

Set these secrets in Supabase:

```bash
supabase secrets set WHATSAPP_ACCESS_TOKEN=EAAxxxxxx
supabase secrets set WHATSAPP_PHONE_NUMBER_ID=12345678
supabase secrets set WHATSAPP_VERIFY_TOKEN=my-secret-token
supabase secrets set WHATSAPP_BUSINESS_ACCOUNT_ID=98765
supabase secrets set SUPABASE_URL=https://xxx.supabase.co
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=eyJxxx
supabase secrets set APP_URL=https://foodshare.club
```

### Deploy

```bash
supabase functions deploy whatsapp-bot-foodshare
```

### Setup Webhook

1. Go to Meta Developer Console > WhatsApp > Configuration
2. Set Webhook URL: `https://<project-id>.supabase.co/functions/v1/whatsapp-bot-foodshare`
3. Set Verify Token: Same as `WHATSAPP_VERIFY_TOKEN`
4. Subscribe to: `messages`

### Health Check

```bash
curl "https://<project-id>.supabase.co/functions/v1/whatsapp-bot-foodshare"
```

## User Flow

### New User Registration

1. User sends any message (e.g., "hi")
2. Bot asks for email
3. User enters email
4. Bot sends 6-digit verification code
5. User enters code
6. Account linked, menu buttons appear

### Sharing Food

1. User taps "Share" button
2. Choose: Web form (recommended) or Chat
3. If Chat: Send photo → description → location
4. Post created and published

### Finding Food

1. User taps "Find" button
2. Bot shows available food items
3. User can view details or claim

## Key Differences from Telegram Bot

| Feature        | Telegram                   | WhatsApp                  |
| -------------- | -------------------------- | ------------------------- |
| User ID        | `telegram_id` (number)     | `whatsapp_phone` (string) |
| Commands       | `/start`, `/share`, etc.   | Button-based menu         |
| Keyboards      | Inline buttons (unlimited) | Max 3 buttons or list     |
| Webhook verify | None                       | GET with hub.challenge    |
| Response time  | Flexible                   | Must respond <5 seconds   |

## Database Tables

The bot uses these additional tables:

- `profiles.whatsapp_phone` - WhatsApp phone number
- `whatsapp_user_states` - Conversation state management
- `whatsapp_rate_limits` - Rate limiting

## Security

- `verify_jwt = false` in config.toml (required for webhooks)
- Email verification required for posting
- Rate limiting on requests (30/min per phone)
- Phone number privacy (partial logging)
- Input validation on all user inputs

## Version

**v1.0.0** - Initial release with full feature parity to Telegram bot
