import { config, sanitizeErrorMessage } from '../config/env.js';
import { getSupabaseAdmin } from '../db/supabase.js';
import { decryptSecret, encryptSecret, maskApiKey } from '../security/crypto.js';

export type SupportedProvider =
  | 'gemini'
  | 'openai_compatible'
  | 'elevenlabs'
  | 'pexels'
  | 'pixabay';

export type CredentialStatus =
  | 'not_connected'
  | 'validating'
  | 'connected'
  | 'invalid_key'
  | 'rate_limited'
  | 'provider_unavailable';

export interface ValidationResult {
  valid: boolean;
  status: CredentialStatus;
  message: string;
  usageInfo?: Record<string, unknown>;
}

export interface MaskedCredentialRecord {
  provider: SupportedProvider;
  status: CredentialStatus;
  maskedKey: string | null;
  lastValidatedAt: string | null;
  lastError: string | null;
  usageInfo: Record<string, unknown>;
  providerConfig: Record<string, unknown>;
  docsUrl: string;
}

export const PROVIDER_DOCS: Record<SupportedProvider, string> = {
  gemini: 'https://aistudio.google.com/apikey',
  openai_compatible: 'https://platform.openai.com/api-keys',
  elevenlabs: 'https://elevenlabs.io/app/settings/api-keys',
  pexels: 'https://www.pexels.com/api/',
  pixabay: 'https://pixabay.com/api/docs/',
};

/**
 * Validates a raw API key directly against the real provider endpoint without logging the key.
 */
export async function validateProviderKey(
  provider: SupportedProvider,
  rawKey: string,
  providerConfig: Record<string, unknown> = {}
): Promise<ValidationResult> {
  const key = rawKey.trim();
  if (key.length < 8) {
    return { valid: false, status: 'invalid_key', message: 'API key is too short.' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    switch (provider) {
      case 'gemini': {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?pageSize=5&key=${encodeURIComponent(key)}`,
          { method: 'GET', signal: controller.signal }
        );
        if (res.ok) {
          const data = (await res.json()) as { models?: Array<{ name?: string }> };
          return {
            valid: true,
            status: 'connected',
            message: 'Gemini API key verified.',
            usageInfo: { availableModelsSample: data.models?.length ?? 0 },
          };
        }
        return mapHttpStatusToValidation(res.status, 'Gemini');
      }

      case 'openai_compatible': {
        const baseUrl = String(providerConfig.base_url || 'https://api.openai.com/v1').replace(/\/$/, '');
        if (!baseUrl.startsWith('https://')) {
          return {
            valid: false,
            status: 'invalid_key',
            message: 'OpenAI-compatible base URL must use HTTPS.',
          };
        }
        const res = await fetch(`${baseUrl}/models`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${key}` },
          signal: controller.signal,
        });
        if (res.ok) {
          return { valid: true, status: 'connected', message: 'OpenAI-compatible API key verified.' };
        }
        return mapHttpStatusToValidation(res.status, 'OpenAI-compatible');
      }

      case 'elevenlabs': {
        const res = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
          method: 'GET',
          headers: { 'xi-api-key': key },
          signal: controller.signal,
        });
        if (res.ok) {
          const sub = (await res.json()) as {
            tier?: string;
            character_count?: number;
            character_limit?: number;
          };
          return {
            valid: true,
            status: 'connected',
            message: 'ElevenLabs API key verified.',
            usageInfo: {
              tier: sub.tier ?? 'standard',
              characterCount: sub.character_count ?? 0,
              characterLimit: sub.character_limit ?? 0,
            },
          };
        }
        return mapHttpStatusToValidation(res.status, 'ElevenLabs');
      }

      case 'pexels': {
        const res = await fetch('https://api.pexels.com/videos/search?query=nature&per_page=1', {
          method: 'GET',
          headers: { Authorization: key },
          signal: controller.signal,
        });
        if (res.ok) {
          const remaining = res.headers.get('X-Ratelimit-Remaining');
          const limit = res.headers.get('X-Ratelimit-Limit');
          return {
            valid: true,
            status: 'connected',
            message: 'Pexels API key verified.',
            usageInfo: {
              rateLimitRemaining: remaining ? Number(remaining) : undefined,
              rateLimitTotal: limit ? Number(limit) : undefined,
            },
          };
        }
        return mapHttpStatusToValidation(res.status, 'Pexels');
      }

      case 'pixabay': {
        const res = await fetch(
          `https://pixabay.com/api/videos/?key=${encodeURIComponent(key)}&q=nature&per_page=3`,
          { method: 'GET', signal: controller.signal }
        );
        if (res.ok) {
          const remaining = res.headers.get('X-RateLimit-Remaining');
          return {
            valid: true,
            status: 'connected',
            message: 'Pixabay API key verified.',
            usageInfo: {
              rateLimitRemaining: remaining ? Number(remaining) : undefined,
            },
          };
        }
        return mapHttpStatusToValidation(res.status, 'Pixabay');
      }
    }
  } catch (err) {
    return {
      valid: false,
      status: 'provider_unavailable',
      message: `Unable to reach ${provider}: ${sanitizeErrorMessage(err)}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function mapHttpStatusToValidation(httpStatus: number, label: string): ValidationResult {
  if (httpStatus === 401 || httpStatus === 403 || httpStatus === 400) {
    return {
      valid: false,
      status: 'invalid_key',
      message: `${label} rejected the API key (HTTP ${httpStatus}).`,
    };
  }
  if (httpStatus === 429) {
    return {
      valid: false,
      status: 'rate_limited',
      message: `${label} rate limit exceeded (HTTP 429). Try again later.`,
    };
  }
  return {
    valid: false,
    status: 'provider_unavailable',
    message: `${label} service temporarily unavailable (HTTP ${httpStatus}).`,
  };
}

/**
 * Lists all supported BYOK providers with ONLY masked keys & statuses for the user.
 */
export async function listUserCredentials(userId: string): Promise<MaskedCredentialRecord[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('api_credentials')
    .select('provider, masked_key, key_status, last_validated_at, last_error, usage_info, provider_config')
    .eq('user_id', userId);

  if (error) {
    throw new Error(`Failed to fetch credentials: ${error.message}`);
  }

  const byProvider = new Map(
    (data || []).map((row) => [row.provider as SupportedProvider, row])
  );

  const orderedProviders: SupportedProvider[] = [
    'gemini',
    'elevenlabs',
    'pexels',
    'pixabay',
    'openai_compatible',
  ];

  return orderedProviders.map((provider) => {
    const row = byProvider.get(provider);
    return {
      provider,
      status: (row?.key_status as CredentialStatus) || 'not_connected',
      maskedKey: row?.masked_key ?? null,
      lastValidatedAt: row?.last_validated_at ?? null,
      lastError: row?.last_error ?? null,
      usageInfo: (row?.usage_info as Record<string, unknown>) || {},
      providerConfig: (row?.provider_config as Record<string, unknown>) || {},
      docsUrl: PROVIDER_DOCS[provider],
    };
  });
}

/**
 * Validates, encrypts (AES-256-GCM), and stores a user's BYOK credential.
 */
export async function upsertUserCredential(
  userId: string,
  provider: SupportedProvider,
  rawKey: string,
  providerConfig: Record<string, unknown> = {},
  skipValidation = false
): Promise<{ record: MaskedCredentialRecord; validation: ValidationResult }> {
  const validation = skipValidation
    ? { valid: true, status: 'connected' as CredentialStatus, message: 'Saved without validation' }
    : await validateProviderKey(provider, rawKey, providerConfig);

  if (!validation.valid && !skipValidation) {
    return {
      validation,
      record: {
        provider,
        status: validation.status,
        maskedKey: maskApiKey(rawKey),
        lastValidatedAt: new Date().toISOString(),
        lastError: validation.message,
        usageInfo: validation.usageInfo || {},
        providerConfig,
        docsUrl: PROVIDER_DOCS[provider],
      },
    };
  }

  const encrypted = encryptSecret(
    rawKey.trim(),
    config.credentialEncryptionKeyHex,
    `${userId}:${provider}`
  );
  const masked = maskApiKey(rawKey);
  const now = new Date().toISOString();

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from('api_credentials').upsert(
    {
      user_id: userId,
      provider,
      encrypted_key: encrypted.ciphertext,
      key_iv: encrypted.iv,
      key_auth_tag: encrypted.authTag,
      masked_key: masked,
      key_status: validation.status,
      provider_config: providerConfig,
      usage_info: validation.usageInfo || {},
      last_validated_at: now,
      last_error: validation.valid ? null : validation.message,
    },
    { onConflict: 'user_id,provider' }
  );

  if (error) {
    throw new Error(`Failed to save encrypted credential: ${error.message}`);
  }

  return {
    validation,
    record: {
      provider,
      status: validation.status,
      maskedKey: masked,
      lastValidatedAt: now,
      lastError: validation.valid ? null : validation.message,
      usageInfo: validation.usageInfo || {},
      providerConfig,
      docsUrl: PROVIDER_DOCS[provider],
    },
  };
}

/**
 * Deletes a user's stored BYOK credential for the given provider.
 */
export async function deleteUserCredential(
  userId: string,
  provider: SupportedProvider
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from('api_credentials')
    .delete()
    .eq('user_id', userId)
    .eq('provider', provider);
  if (error) {
    throw new Error(`Failed to remove credential: ${error.message}`);
  }
}

/**
 * Decrypts a user's BYOK key strictly on the backend for worker execution.
 * Falls back to optional platform default key ONLY if configured by the server operator.
 */
export async function resolveUserProviderKey(
  userId: string,
  provider: SupportedProvider
): Promise<{ apiKey: string; providerConfig: Record<string, unknown> } | null> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from('api_credentials')
    .select('encrypted_key, key_iv, key_auth_tag, provider_config, key_status')
    .eq('user_id', userId)
    .eq('provider', provider)
    .maybeSingle();

  if (data?.encrypted_key && data.key_iv && data.key_auth_tag) {
    const apiKey = decryptSecret(
      {
        ciphertext: data.encrypted_key,
        iv: data.key_iv,
        authTag: data.key_auth_tag,
      },
      config.credentialEncryptionKeyHex,
      `${userId}:${provider}`
    );
    return {
      apiKey,
      providerConfig: (data.provider_config as Record<string, unknown>) || {},
    };
  }

  const fallbackMap: Partial<Record<SupportedProvider, string | undefined>> = {
    gemini: config.optionalPlatformKeys.gemini,
    pexels: config.optionalPlatformKeys.pexels,
    pixabay: config.optionalPlatformKeys.pixabay,
    elevenlabs: config.optionalPlatformKeys.elevenlabs,
  };
  const fallbackKey = fallbackMap[provider];
  if (fallbackKey) {
    return { apiKey: fallbackKey, providerConfig: {} };
  }
  return null;
}
