#!/bin/bash
#
# Subscription Cron Script
#
# Run this every 5 minutes via:
# - cron-job.org (recommended)
# - Local crontab: */5 * * * * /path/to/subscription-cron.sh
# - Render.com cron jobs
# - Any external scheduler
#

set -e

CRON_SECRET="${CRON_SECRET:-631ae35a04d30ab33cc611a94accd64fe4b58421b9c2daed953ce6d0459bd6a8}"
CRON_ENDPOINT="https://***REMOVED***/functions/v1/subscription-cron"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Starting subscription cron..."

RESPONSE=$(curl -s -w "\n%{http_code}" \
  --max-time 120 \
  -X POST \
  -H "Content-Type: application/json" \
  -H "X-Cron-Secret: $CRON_SECRET" \
  "$CRON_ENDPOINT")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
  echo "[SUCCESS] HTTP $HTTP_CODE"
  echo "$BODY" | jq -r '
    "  DLQ Processed: \(.result.dlq.processed // 0)",
    "  DLQ Pending: \(.result.dlq.pending // 0)",
    "  Metrics Updated: \(.result.metrics.updated // false)",
    "  Duration: \(.durationMs // 0)ms"
  ' 2>/dev/null || echo "$BODY"
  exit 0
else
  echo "[FAILED] HTTP $HTTP_CODE"
  echo "$BODY"
  exit 1
fi
