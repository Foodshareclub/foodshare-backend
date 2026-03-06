---
name: bot-development
description: Telegram and WhatsApp bot patterns for Foodshare backend. Use when building or modifying bot webhook handlers, implementing circuit breakers, or handling message flows. Covers webhook verification, always-200 responses, and bot-specific patterns.
---

<objective>
Build reliable bot integrations that handle webhooks correctly, verify message authenticity, and never cause retry storms.
</objective>

<essential_principles>
## Core Rules

1. **Always return 200** - Even on errors. Non-200 responses cause Telegram/WhatsApp to retry, creating storms
2. **Verify webhooks** - Telegram: `X-Telegram-Bot-Api-Secret-Token`. WhatsApp/Meta: HMAC `X-Hub-Signature-256`
3. **Circuit breakers** - Wrap all external service calls with `withCircuitBreaker()`
4. **JWT disabled** - Bot webhooks must have `verify_jwt = false` in `config.toml`
5. **Structured logging** - All bot actions logged with context for debugging

## Bot Functions

| Bot | Directory | Webhook |
|-----|-----------|---------|
| Telegram | `telegram-bot-foodshare/` | Secret token header |
| WhatsApp | `whatsapp-bot-foodshare/` | HMAC signature |

## Webhook Verification

### Telegram
```typescript
function verifyTelegramWebhook(req: Request): boolean {
  const secretToken = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
  return secretToken === Deno.env.get("TELEGRAM_WEBHOOK_SECRET");
}
```

### WhatsApp/Meta
```typescript
import { timingSafeEqual } from "../_shared/utils.ts";

function verifyMetaWebhook(req: Request, body: string): boolean {
  const signature = req.headers.get("X-Hub-Signature-256");
  if (!signature) return false;

  const secret = Deno.env.get("META_WEBHOOK_SECRET")!;
  const expectedSig = `sha256=${hmac(secret, body)}`;
  return timingSafeEqual(signature, expectedSig);
}
```

## Always-200 Pattern

```typescript
Deno.serve(createAPIHandler({
  functionName: "telegram-bot-foodshare",
  routes: {
    "POST /": handleWebhook,
    "GET /health": handleHealth,
    "POST /setup-webhook": handleSetupWebhook,
  },
}));

async function handleWebhook(req: Request) {
  try {
    if (!verifyTelegramWebhook(req)) {
      logger.warn("Invalid webhook secret");
      return ok({ status: "ignored" });  // Still 200!
    }

    const update = await req.json();
    await processUpdate(update);
    return ok({ status: "processed" });
  } catch (error) {
    logger.error("Webhook processing failed", { error });
    return ok({ status: "error" });  // Still 200!
  }
}
```

## Circuit Breakers

```typescript
import { withCircuitBreaker } from "../_shared/circuit-breaker.ts";

// Wrap external calls
const result = await withCircuitBreaker("telegram-api", async () => {
  return await sendTelegramMessage(chatId, text);
}, {
  threshold: 5,        // Open after 5 failures
  timeout: 30_000,     // Try half-open after 30s
  resetTimeout: 60_000 // Full reset after 60s
});

// States: CLOSED -> OPEN (after threshold) -> HALF_OPEN (after timeout) -> CLOSED
```

## Health & Setup Endpoints

```typescript
// Health check
async function handleHealth(req: Request) {
  return ok({
    status: "healthy",
    bot: "telegram",
    circuitBreaker: getCircuitBreakerStatus("telegram-api"),
  });
}

// Register webhook with Telegram
async function handleSetupWebhook(req: Request) {
  const webhookUrl = `${Deno.env.get("API_URL")}/functions/v1/telegram-bot-foodshare`;
  await registerTelegramWebhook(webhookUrl);
  return ok({ status: "registered", url: webhookUrl });
}
```
</essential_principles>

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Bot not responding | Check health: `curl <bot-url>/health` |
| 401 errors | Verify `verify_jwt = false` in config.toml |
| Duplicate messages | Check circuit breaker status, verify webhook idempotency |
| Webhook not receiving | Re-register via `/setup-webhook` endpoint |

<success_criteria>
Bot implementation is correct when:
- [ ] Webhook verification implemented (Telegram or Meta)
- [ ] All responses return 200 (even errors)
- [ ] Circuit breakers wrap external API calls
- [ ] Health endpoint available
- [ ] Webhook setup endpoint available
- [ ] Structured logging for all actions
- [ ] JWT disabled in config.toml
</success_criteria>
