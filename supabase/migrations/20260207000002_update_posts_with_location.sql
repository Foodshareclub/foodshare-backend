-- Migration: Update posts_with_location view to include fridge-specific columns
-- Purpose: Expose metadata, fridge_id, has_pantry, available_hours, location_type, condition
-- These columns exist in posts but were not previously selected by the view

CREATE OR REPLACE VIEW public.posts_with_location WITH (security_invoker='true') AS
 SELECT p.id,
    p.post_name,
    p.post_description,
    p.post_type,
    p.post_address,
    p.post_stripped_address,
    p.quantity,
    p.pickup_time,
    p.is_active,
    p.is_arranged,
    p.created_at,
    p.updated_at,
    p.profile_id,
    p.images,
    p.post_views,
    p.location,
    p.location_json,
    extensions.st_y((p.location)::extensions.geometry) AS latitude,
    extensions.st_x((p.location)::extensions.geometry) AS longitude,
    p.category_id,
    p.tags,
    -- Fridge/metadata columns (new)
    p.metadata,
    p.fridge_id,
    p.has_pantry,
    p.available_hours,
    p.location_type,
    p.condition
   FROM public.posts p
  WHERE (p.is_active = true);
