#!/bin/bash
# Deprecate old endpoints (add warnings)
# Run from: foodshare-backend/

set -e

echo "⚠️  Adding deprecation warnings to old endpoints..."
echo ""

# Add deprecation wrapper to BFF
cat > functions/bff/index.ts.deprecated << 'EOF'
// DEPRECATED: This endpoint will be removed on 2026-02-27
// Use the new consolidated APIs instead

import { getCorsHeadersWithMobile } from "../_shared/cors.ts";

const DEPRECATION_MESSAGE = {
  deprecated: true,
  message: "This BFF endpoint is deprecated. Use the new consolidated APIs.",
  sunset_date: "2026-02-27",
  migrations: {
    "/bff/feed": "GET /api-v1-listings?mode=feed",
    "/bff/dashboard": "GET /api-v1-profile?action=dashboard",
    "/bff/search": "GET /api-v1-search?mode=hybrid&aggregate=true",
    "/bff/profile": "GET /api-v1-profile",
    "/bff/notifications": "GET /api-v1-notifications?mode=aggregate",
    "/bff/messages": "GET /api-v1-chat?mode=aggregate",
  },
  docs: "https://github.com/your-org/foodshare/blob/main/functions/API_CONSOLIDATION.md"
};

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeadersWithMobile(req);
  
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  return new Response(JSON.stringify({
    success: false,
    error: DEPRECATION_MESSAGE,
  }), {
    status: 410, // Gone
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Sunset": "Fri, 27 Feb 2026 00:00:00 GMT",
      "Deprecation": "true",
    },
  });
});
EOF

echo "✓ Created deprecation wrapper for BFF"
echo ""
echo "To activate deprecation:"
echo "  1. Backup: mv functions/bff/index.ts functions/bff/index.ts.backup"
echo "  2. Activate: mv functions/bff/index.ts.deprecated functions/bff/index.ts"
echo "  3. Deploy: supabase functions deploy bff"
echo ""
echo "To rollback:"
echo "  mv functions/bff/index.ts.backup functions/bff/index.ts"
