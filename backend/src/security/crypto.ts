import crypto from 'node:crypto';

export interface EncryptedPayload {
  ciphertext: string; // base64
  iv: string; // base64 (12-byte GCM nonce)
  authTag: string; // base64 (16-byte GCM tag)
}

function deriveKeyBuffer(hexOrPassphrase: string): Buffer {
  if (!hexOrPassphrase) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY is not configured on the server.');
  }
  const trimmed = hexOrPassphrase.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  // Deterministically stretch non-hex key material to 32 bytes via SHA-256
  return crypto.createHash('sha256').update(trimmed, 'utf8').digest();
}

/**
 * Encrypts sensitive BYOK API keys or OAuth refresh tokens with AES-256-GCM.
 * Uses userId as Additional Authenticated Data (AAD) to bind ciphertexts to their owner.
 */
export function encryptSecret(
  plaintext: string,
  encryptionKeyHex: string,
  aadContext: string
): EncryptedPayload {
  if (!plaintext) {
    throw new Error('Cannot encrypt empty credential');
  }
  const key = deriveKeyBuffer(encryptionKeyHex);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aadContext, 'utf8'));

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

/**
 * Decrypts AES-256-GCM ciphertext strictly on the backend, verifying both tag and owner AAD.
 */
export function decryptSecret(
  payload: EncryptedPayload,
  encryptionKeyHex: string,
  aadContext: string
): string {
  const key = deriveKeyBuffer(encryptionKeyHex);
  const iv = Buffer.from(payload.iv, 'base64');
  const authTag = Buffer.from(payload.authTag, 'base64');
  const ciphertext = Buffer.from(payload.ciphertext, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aadContext, 'utf8'));
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Produces a safe masked display string for UI presentation. Full keys are NEVER returned.
 */
export function maskApiKey(rawKey: string): string {
  const cleaned = rawKey.trim();
  if (cleaned.length <= 8) {
    return '••••••••';
  }
  const prefix = cleaned.slice(0, 4);
  const suffix = cleaned.slice(-4);
  return `${prefix}••••••••${suffix}`;
}

export interface SignedOAuthState {
  userId: string;
  nonce: string;
  exp: number;
}

/**
 * Signs an OAuth 2.0 state token with HMAC-SHA256 to prevent CSRF on OAuth callbacks.
 */
export function createSignedOAuthState(userId: string, secret: string, ttlSeconds = 900): string {
  const payload: SignedOAuthState = {
    userId,
    nonce: crypto.randomBytes(12).toString('hex'),
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

/**
 * Verifies an HMAC-signed OAuth state token using constant-time comparison.
 */
export function verifySignedOAuthState(state: string, secret: string): SignedOAuthState {
  const parts = state.split('.');
  if (parts.length !== 2) {
    throw new Error('Invalid OAuth state format');
  }
  const [encoded, receivedSig] = parts;
  const expectedSig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');

  const a = Buffer.from(receivedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('OAuth state signature verification failed');
  }

  const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SignedOAuthState;
  if (!parsed.userId || !parsed.exp || parsed.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('OAuth state expired');
  }
  return parsed;
}
