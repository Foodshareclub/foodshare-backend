# API Consolidation Scripts

Automated deployment and testing for the consolidated API refactor.

## Scripts

### 1. `deploy-consolidated-apis.sh`
Deploy all 4 consolidated APIs to Supabase.

```bash
cd foodshare-backend
./scripts/deploy-consolidated-apis.sh
```

**Deploys:**
- `api-v1-search` (replaces 3 search endpoints)
- `api-v1-profile` (enhanced with dashboard)
- `api-v1-listings` (enhanced with feed)
- `api-v1-chat` (enhanced with aggregation)

### 2. `test-consolidated-apis.sh`
Test all new endpoints are responding correctly.

```bash
./scripts/test-consolidated-apis.sh
```

**Tests:**
- Search modes (semantic, text, hybrid, fuzzy)
- Profile endpoints
- Listings feed
- Chat aggregation

### 3. `deprecate-old-apis.sh`
Add deprecation warnings to old endpoints (Week 2).

```bash
./scripts/deprecate-old-apis.sh
```

**Creates deprecation wrapper** that returns HTTP 410 Gone with migration instructions.

### 4. `delete-old-apis.sh`
**⚠️ DESTRUCTIVE** - Delete old functions after migration (Week 3+).

```bash
./scripts/delete-old-apis.sh
```

**Deletes:**
- `foodshare-search`
- `search-functions`
- `bff`

Archives to `functions/_archived/` before deletion.

## Migration Timeline

| Week | Action | Script |
|------|--------|--------|
| 1 | Deploy new APIs | `deploy-consolidated-apis.sh` |
| 1 | Test endpoints | `test-consolidated-apis.sh` |
| 2 | Update mobile clients | Manual |
| 2 | Add deprecation warnings | `deprecate-old-apis.sh` |
| 3+ | Delete old functions | `delete-old-apis.sh` |

## Environment Setup

Ensure `.env` has:
```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_PROJECT_REF=your-project-ref
```

## Rollback

If issues arise:
```bash
# Rollback BFF deprecation
mv functions/bff/index.ts.backup functions/bff/index.ts
supabase functions deploy bff

# Old functions remain deployed for 3 weeks
```

## Monitoring

After deployment, monitor:
- Error rates in Supabase dashboard
- Response times (should improve)
- Client logs for migration issues

## Questions?

See `API_CONSOLIDATION.md` for full migration guide.
