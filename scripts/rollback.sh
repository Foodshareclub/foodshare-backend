#!/bin/bash
set -e

echo "=== Rollback Script ==="
echo "This will rollback consolidated functions to previous versions"
echo ""

read -p "Are you sure you want to rollback? (yes/no): " confirm

if [ "$confirm" != "yes" ]; then
    echo "Rollback cancelled"
    exit 0
fi

echo "Rolling back functions..."

# Rollback consolidated functions
supabase functions deploy api-v1-images --version previous
supabase functions deploy api-v1-notifications --version previous
supabase functions deploy api-v1-engagement --version previous
supabase functions deploy api-v1-metrics --version previous

echo "✅ Rollback complete"
echo ""
echo "Verify with: supabase functions list"
