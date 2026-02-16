# Security Notice

## Old Supabase Cloud Project

This repository previously contained references to a Supabase Cloud project (`***REMOVED***`).

**That project has been migrated to self-hosted infrastructure and is no longer in use.**

If you still have access to the old cloud project:
1. Go to https://supabase.com/dashboard/project/***REMOVED***/settings/general
2. Delete or pause the project
3. Any old JWT tokens in git history are now invalid

## Current Infrastructure

- Self-hosted Supabase on VPS (152.53.136.84)
- API: https://api.foodshare.club
- Studio: https://studio.foodshare.club

All secrets are managed via GitHub Secrets and VPS environment variables.
