-- Add Sentry DSN to Supabase Vault
-- This allows Edge Functions to access the Sentry DSN for error tracking
-- Run this in your Supabase SQL Editor: https://app.supabase.com/project/***REMOVED***/sql

SELECT vault.create_secret(
  'https://cb2c2402c09c57446d2c2dfb127b0377@o4504219038318592.ingest.us.sentry.io/4509901020594176',
  'SENTRY_DSN',
  'Sentry DSN for error tracking in web app and edge functions'
);

-- Verify the secret was created successfully
SELECT 
  name, 
  description, 
  created_at,
  updated_at
FROM vault.secrets 
WHERE name = 'SENTRY_DSN';

-- Expected output:
-- name        | description                                              | created_at           | updated_at
-- SENTRY_DSN  | Sentry DSN for error tracking in web app and edge functions | 2026-01-15 06:xx:xx | 2026-01-15 06:xx:xx
