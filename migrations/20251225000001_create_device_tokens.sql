-- Create device_tokens table for APNs push notification tokens
-- This table stores device tokens for sending push notifications to users

CREATE TABLE IF NOT EXISTS device_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Each user can only have one token per platform
  UNIQUE(profile_id, platform)
);

-- Create index for faster lookups by profile
CREATE INDEX idx_device_tokens_profile_id ON device_tokens(profile_id);

-- Create index for token lookups (useful for cleanup of invalid tokens)
CREATE INDEX idx_device_tokens_token ON device_tokens(token);

-- Enable Row Level Security
ALTER TABLE device_tokens ENABLE ROW LEVEL SECURITY;

-- Policy: Users can view their own device tokens
CREATE POLICY "Users can view own device tokens"
  ON device_tokens
  FOR SELECT
  USING (auth.uid() = profile_id);

-- Policy: Users can insert their own device tokens
CREATE POLICY "Users can insert own device tokens"
  ON device_tokens
  FOR INSERT
  WITH CHECK (auth.uid() = profile_id);

-- Policy: Users can update their own device tokens
CREATE POLICY "Users can update own device tokens"
  ON device_tokens
  FOR UPDATE
  USING (auth.uid() = profile_id)
  WITH CHECK (auth.uid() = profile_id);

-- Policy: Users can delete their own device tokens
CREATE POLICY "Users can delete own device tokens"
  ON device_tokens
  FOR DELETE
  USING (auth.uid() = profile_id);

-- Policy: Service role can manage all tokens (for Edge Functions)
CREATE POLICY "Service role can manage all tokens"
  ON device_tokens
  FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role');

-- Trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_device_tokens_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER device_tokens_updated_at
  BEFORE UPDATE ON device_tokens
  FOR EACH ROW
  EXECUTE FUNCTION update_device_tokens_updated_at();

-- Add comment for documentation
COMMENT ON TABLE device_tokens IS 'Stores device push notification tokens for iOS (APNs), Android (FCM), and Web';
COMMENT ON COLUMN device_tokens.token IS 'The device token received from APNs/FCM';
COMMENT ON COLUMN device_tokens.platform IS 'The platform: ios, android, or web';
