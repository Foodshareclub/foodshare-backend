# FoodShare Backend Documentation

## 📁 Documentation Structure

### [AI](./ai/)
AI services, chat completions, embeddings, and structured generation.

- **[AI_SERVICES.md](./ai/AI_SERVICES.md)** - Production AI API with Groq, z.ai, OpenRouter
  - Multi-provider fallback
  - Chat completions with streaming
  - Text embeddings (1536d)
  - Structured JSON generation
  - Circuit breakers & rate limiting

### [Images](./images/)
Image processing, compression, and upload system documentation.

- **[IMAGE_SYSTEM_REFACTORING.md](./images/IMAGE_SYSTEM_REFACTORING.md)** - Complete enterprise image system refactoring (2026-02-06)
  - Unified API architecture
  - Compression pipeline (TinyPNG/Cloudinary)
  - EXIF extraction, thumbnails, AI detection
  - Rate limiting & metrics
  - 85% code reduction

### [Translations](./translations/)
LLM-powered translation system via Groq and z.ai.

- **[LLM_TRANSLATION_DEPLOYMENT.md](./translations/LLM_TRANSLATION_DEPLOYMENT.md)** - Deployment guide
- **[LLM_TRANSLATION_SUMMARY.md](./translations/LLM_TRANSLATION_SUMMARY.md)** - Feature summary
- **[TRANSLATION_ENHANCEMENT_INVESTIGATION.md](./translations/TRANSLATION_ENHANCEMENT_INVESTIGATION.md)** - Enhancement research

### [Security](./security/)
Security, monitoring, and error tracking documentation.

- **[SENTRY_VAULT_SETUP.md](./security/SENTRY_VAULT_SETUP.md)** - Sentry integration with Supabase Vault

---

## 🚀 Quick Links

### Recent Updates
- **2026-02-06**: AI API v1 deployed (see [ai/](./ai/))
- **2026-02-06**: Image system refactoring complete (see [images/](./images/))

### Key Features
- **Image Processing**: Unified API with smart compression
- **Translations**: LLM-powered multi-language support
- **Security**: Sentry error tracking with Vault secrets

---

## 📝 Contributing

When adding new documentation:
1. Place in appropriate category folder
2. Update this README with link
3. Use descriptive filenames (UPPERCASE_WITH_UNDERSCORES.md)
4. Include date in document header

---

**Last Updated**: 2026-02-06
