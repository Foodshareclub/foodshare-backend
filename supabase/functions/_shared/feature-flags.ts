// Feature flags system - control feature rollout without redeployment
// Usage: if (await isFeatureEnabled('new-chat-ui', userId)) { ... }

interface FeatureFlag {
  enabled: boolean;
  rolloutPercent?: number; // 0-100
  allowedUsers?: string[];
  allowedRoles?: string[];
}

const FLAGS: Record<string, FeatureFlag> = {
  "enhanced-notifications": { enabled: true, rolloutPercent: 100 },
  "new-chat-ui": { enabled: true, rolloutPercent: 10 },
  "ai-recommendations": { enabled: false },
};

export async function isFeatureEnabled(
  flag: string,
  userId?: string,
): Promise<boolean> {
  const config = FLAGS[flag];
  if (!config || !config.enabled) return false;

  // Check user allowlist
  if (config.allowedUsers?.length && userId) {
    return config.allowedUsers.includes(userId);
  }

  // Rollout percentage (deterministic based on userId)
  if (config.rolloutPercent !== undefined && config.rolloutPercent < 100) {
    if (!userId) return false;
    const hash = await hashUserId(userId);
    return (hash % 100) < config.rolloutPercent;
  }

  return true;
}

async function hashUserId(userId: string): Promise<number> {
  const encoder = new TextEncoder();
  const data = encoder.encode(userId);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  return hashArray[0];
}
