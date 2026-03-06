# Supabase Self-Hosted Migration Progress

**Started**: 2026-02-07  
**Server**: 152.53.136.84 (6-core ARM64, 8GB RAM)  
**Goal**: Migrate from Supabase Cloud to self-hosted to eliminate Edge Functions quota limits

---

## ✅ COMPLETED TASKS

### Task 1: Bootstrap Self-Hosted Supabase ✅
**Status**: Complete  
**What was done**:
- Installed Supabase CLI v2.72.7 on VPS
- Initialized Supabase project structure
- Started all services via `supabase start`
- Services running:
  - Studio: http://127.0.0.1:54323
  - API: http://127.0.0.1:54321
  - Database: postgresql://postgres:postgres@127.0.0.1:54322/postgres
  - Edge Functions: http://127.0.0.1:54321/functions/v1

**Files created**:
- `/home/organic/dev/foodshare-backend/` (VPS)
- `scripts/bootstrap-selfhosted.sh`

---

### Task 2: GitHub Actions Secrets Documentation ✅
**Status**: Complete  
**What was done**:
- Documented all 14 required secrets for CI/CD
- Created setup instructions for GitHub CLI and web interface
- Listed VPS, Supabase, and Edge Function secrets

**Files created**:
- `docs/github-secrets.md`

**Secrets needed** (not yet configured in GitHub):
1. VPS_HOST, VPS_USER, VPS_SSH_KEY
2. SUPABASE_DB_PASSWORD, SUPABASE_JWT_SECRET, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
3. GROQ_API_KEY, RESEND_API_KEY, UPSTASH_REDIS_URL, etc.

---

### Task 4: Export Data from Supabase Cloud ✅
**Status**: Complete  
**What was done**:
- Linked to cloud project: api.foodshare.club (migrated from ***REMOVED***)
- Exported full schema: 41,474 lines (~1.5MB)
- Exported all data: 450,051 lines
- **Cloud instance remains fully operational** ✅

**Files created** (on VPS):
- `exports/cloud-schema.sql` (schema only)
- `exports/schema-clean.sql` (cleaned version)
- `exports/cloud-data.sql` (data only)
- `exports/data-clean.sql` (cleaned version)

---

### Task 5: Import Data to Self-Hosted ✅
**Status**: Complete  
**What was done**:
- Imported schema: All tables, functions, triggers, RLS policies
- Imported data: 70,000+ rows across multiple tables
- Verified row counts match cloud
- Top tables: email_provider_health_history (70k), languages (25k), translation_change_log (11k)

**Database status**: Fully migrated and operational

---

## ⏳ IN PROGRESS / BLOCKED

### Task 6: Deploy Edge Functions ✅
**Status**: Complete
**Issues resolved**:
1. deno.lock version 5 incompatible with edge-runtime-1.70.0 (Deno v2.1.4) — installed Deno 2.1.4 on VPS, regenerated v4 lock file
2. JSR imports in deno.json caused boot hangs — removed all unused import map entries (entire map was unused, all functions use pinned URLs)
3. `export default createAPIHandler()` pattern not supported by self-hosted edge runtime — changed all 25 API functions to `Deno.serve(createAPIHandler())`
4. Supabase CLI upgraded from v2.72.7 → v2.75.0

**All 27 functions verified booting and responding:**
- api-v1-health (200), api-v1-auth (200), api-v1-admin (200), api-v1-ai (200)
- api-v1-alerts (200), api-v1-attestation (200), api-v1-geocoding (200)
- api-v1-images (200), api-v1-validation (200), api-v1-search (400 — needs query)
- api-v1-profile (401 — needs auth), api-v1-chat (401), api-v1-sync (401)
- api-v1-products (500), api-v1-feature-flags (500), api-v1-metrics (500) — runtime config errors (expected, needs env vars)
- telegram-bot-foodshare (500), whatsapp-bot-foodshare (500) — expected without webhook config
- All remaining functions: boot and respond (various expected status codes)

**Files modified**:
- `supabase/functions/deno.json` — emptied unused imports map
- `supabase/functions/deno.lock` — regenerated v4 on VPS with Deno 2.1.4
- All 25 `api-v1-*/index.ts` — `export default createAPIHandler(` → `Deno.serve(createAPIHandler(`
- `.env.selfhosted` (environment variables for local functions)

---

## 📋 REMAINING TASKS

### Task 3: Create Comprehensive CI/CD Workflow ❌
**Status**: Not started  
**What needs to be done**:
1. Create `.github/workflows/ci.yml` in foodshare-backend
2. Add jobs: lint, type-check, test, validate, deploy, verify
3. Configure SSH deployment to VPS
4. Add health checks for all services
5. Test workflow by pushing to develop/main

**Files to create**:
- `.github/workflows/ci.yml`

---

### Task 7: Integrate Deployment into CI/CD ❌
**Status**: Not started (depends on Task 3 & 6)  
**What needs to be done**:
1. Add deploy-supabase job to workflow
2. SSH to VPS, pull code, run migrations
3. Deploy Edge Functions automatically
4. Restart services if needed
5. Add rollback capability
6. Configure Slack/Discord notifications

---

### Task 8: Configure Cloudflare Tunnel ❌
**Status**: Not started  
**What needs to be done**:
1. Update Cloudflare tunnel config to expose Kong (port 8000)
2. Configure DNS: api-selfhosted.foodshare.club
3. Create `.env.selfhosted` in foodshare-web with new URL
4. Add SUPABASE_MODE environment variable (cloud|selfhosted)
5. Update iOS app with dual configuration
6. Update Android app with dual configuration

**Files to create/update**:
- Cloudflare tunnel config
- `foodshare-web/.env.selfhosted`
- iOS app config
- Android app config

---

### Task 9: Cutover and Validation ❌
**Status**: Not started (final step)  
**What needs to be done**:
1. Set SUPABASE_MODE=selfhosted in production
2. Monitor logs: `supabase logs --tail 100`
3. Verify all 27 Edge Functions respond without WORKER_LIMIT errors
4. Test critical flows: signup, login, create post, upload image
5. Monitor GitHub Actions for deployment health
6. If issues: set SUPABASE_MODE=cloud (instant rollback)
7. After 48h stability: document cloud as emergency backup

---

## 🎯 IMMEDIATE NEXT STEPS

1. **Complete Task 6**: Get Edge Functions running locally
   - Use `supabase functions serve` instead of `deploy`
   - Test each function endpoint
   - Document any issues

2. **Start Task 3**: Create CI/CD workflow
   - Base it on foodshare-web/.github/workflows/ci.yml
   - Add Supabase-specific deployment steps

3. **Configure Task 8**: Set up Cloudflare tunnel
   - Expose self-hosted Supabase externally
   - Test from outside the VPS

---

## 📊 CURRENT STATUS

| Component | Status | Location |
|-----------|--------|----------|
| Self-Hosted Supabase | ✅ Running | 152.53.136.84 |
| Database | ✅ Migrated | Local (70k+ rows) |
| Edge Functions | ✅ Running | All 27 boot successfully |
| CI/CD | ❌ Not started | - |
| Cloudflare Tunnel | ❌ Not configured | - |
| Production Traffic | ☁️ Still on cloud | As planned |

---

## 🔐 SECURITY NOTES

- Cloud instance remains untouched (emergency fallback)
- All secrets documented but not yet in GitHub
- VPS accessible via SSH key: `~/.ssh/id_rsa_gitlab`
- Self-hosted uses default JWT secrets (change for production)

---

## 📝 COMMANDS REFERENCE

**On VPS**:
```bash
ssh -i ~/.ssh/id_rsa_gitlab organic@152.53.136.84
cd /home/organic/dev/foodshare-backend
supabase status                    # Check services
supabase functions list            # List functions
supabase functions serve <name>    # Run function locally
supabase logs                      # View logs
```

**Local**:
```bash
cd /Users/organic/dev/work/foodshare/foodshare-backend
rsync -avz -e "ssh -i ~/.ssh/id_rsa_gitlab" supabase/ organic@152.53.136.84:/home/organic/dev/foodshare-backend/supabase/
```

---

**Last Updated**: 2026-02-08 00:15 PST
