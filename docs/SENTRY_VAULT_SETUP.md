# Sentry DSN in Supabase Vault

## Quick Start

Run this SQL in your [Supabase SQL Editor](https://app.supabase.com/project/***REMOVED***/sql):

```sql
SELECT vault.create_secret(
  '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',
  'SENTRY_DSN',
  'Sentry DSN for error tracking'
);

-- Verify
SELECT name, description, created_at FROM vault.secrets WHERE name = 'SENTRY_DSN';
```

## Set Environment Variable

Go to [Edge Functions Settings](https://app.supabase.com/project/***REMOVED***/settings/functions) and add:

- **Name**: `SENTRY_DSN`
- **Value**: `{{vault.SENTRY_DSN}}`

Or use CLI:
```bash
supabase secrets set SENTRY_DSN="{{vault.SENTRY_DSN}}"
```

## Usage in Edge Functions

```typescript
import { initSentry, captureException } from "../_shared/sentry.ts";

initSentry({ release: "1.0.0" });

Deno.serve(async (req) => {
  try {
    return new Response("OK");
  } catch (error) {
    await captureException(error);
    throw error;
  }
});
```

Done! Edge Functions will now send errors to Sentry.
