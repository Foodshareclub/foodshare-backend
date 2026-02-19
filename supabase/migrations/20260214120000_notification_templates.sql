-- Notification Templates Table
-- Stores reusable notification templates with variable interpolation support.

CREATE TABLE IF NOT EXISTS notification_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'system_announcement',
  title_template TEXT NOT NULL,
  body_template TEXT NOT NULL,
  channels TEXT[] NOT NULL DEFAULT ARRAY['push', 'in_app'],
  priority TEXT NOT NULL DEFAULT 'normal',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast lookup by name + active
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notification_templates_name_active
  ON notification_templates (name) WHERE is_active = TRUE;

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_notification_templates_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_notification_templates_updated_at
  BEFORE UPDATE ON notification_templates
  FOR EACH ROW
  EXECUTE FUNCTION update_notification_templates_updated_at();

-- RLS
ALTER TABLE notification_templates ENABLE ROW LEVEL SECURITY;

-- Roles may not exist in CI bare Postgres, wrap in DO block
DO $$
BEGIN
  -- Authenticated users can read active templates
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE POLICY "Authenticated users can read active templates"
      ON notification_templates FOR SELECT
      TO authenticated
      USING (is_active = TRUE);
  END IF;

  -- Service role can do everything
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE POLICY "Service role full access"
      ON notification_templates FOR ALL
      TO service_role
      USING (TRUE)
      WITH CHECK (TRUE);
  END IF;
END;
$$;

-- Seed data
INSERT INTO notification_templates (name, type, title_template, body_template, channels, priority) VALUES
  (
    'welcome',
    'welcome',
    'Welcome to FoodShare, {{username}}!',
    'Hi {{username}}, thanks for joining FoodShare! Start sharing food with your community today.',
    ARRAY['push', 'email', 'in_app'],
    'normal'
  ),
  (
    'new_message',
    'new_message',
    'New message from {{sender_name}}',
    '{{sender_name}} sent you a message: "{{message_preview}}"',
    ARRAY['push', 'in_app'],
    'high'
  ),
  (
    'listing_nearby',
    'new_listing_nearby',
    'New listing near you!',
    '{{poster_name}} just posted "{{listing_title}}" {{distance}} away.',
    ARRAY['push', 'in_app'],
    'normal'
  )
ON CONFLICT (name) DO NOTHING;
