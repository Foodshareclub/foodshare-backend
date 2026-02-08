-- Migration: Add metadata JSONB column to posts table
-- Purpose: Store fridge-specific fields (and future post-type-specific data) in a flexible JSONB column
-- Part of: Community Fridges → Posts consolidation

ALTER TABLE posts ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

-- GIN index for JSONB containment queries (e.g. metadata @> '{"status": "Active"}')
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_metadata_gin ON posts USING GIN (metadata);

-- Partial index for fridge post type queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_fridge_type ON posts (post_type) WHERE post_type = 'fridge';

COMMENT ON COLUMN posts.metadata IS 'Flexible JSONB for post-type-specific fields (fridge status, check-ins, etc.)';
COMMENT ON COLUMN posts.post_type IS 'Type: food, non-food, request, fridge, etc.';
