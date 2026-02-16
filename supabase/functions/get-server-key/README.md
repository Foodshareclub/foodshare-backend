# Server Encryption Key Setup

## Overview

The app uses hybrid encryption (X25519 + AES-256-GCM) for sensitive payloads. The server's public key is fetched from an Edge Function.

## Setup Instructions

### 1. Generate Server Keypair

```bash
# Generate X25519 keypair (requires libsodium or similar)
# Public key: Share via Edge Function
# Private key: Store securely in server environment

# Example using Node.js with tweetnacl
node -e "
const nacl = require('tweetnacl');
const keypair = nacl.box.keyPair();
console.log('Public Key (base64):', Buffer.from(keypair.publicKey).toString('base64'));
console.log('Private Key (base64):', Buffer.from(keypair.secretKey).toString('base64'));
"
```

### 2. Deploy Edge Function

```bash
cd supabase/functions
supabase functions deploy get-server-key
```

### 3. Set Environment Variables

```bash
# Set in Supabase Dashboard > Edge Functions > get-server-key > Secrets
SERVER_PUBLIC_KEY=<your-base64-public-key>
SERVER_KEY_ID=prod-v1
```

### 4. Store Private Key Securely

- Store in AWS Secrets Manager, HashiCorp Vault, or similar
- Never commit to git
- Rotate annually

### 5. Test

```bash
curl https://api.foodshare.club/functions/v1/get-server-key
```

## Key Rotation

1. Generate new keypair
2. Update SERVER_PUBLIC_KEY and SERVER_KEY_ID
3. Keep old private key for 30 days to decrypt old payloads
4. Update minAppVersion to force old clients to update

## Security Notes

- Public key is cached for 1 hour
- Private key never leaves server
- Keys should be rotated annually
- Monitor key fetch failures
