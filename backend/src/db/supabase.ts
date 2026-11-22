import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config/env.js';

let cachedAdminClient: SupabaseClient | null = null;

/**
 * Returns the server-side Supabase service-role client.
 * Every query MUST explicitly filter by authenticated `user_id` to preserve tenant isolation.
 */
export function getSupabaseAdmin(): SupabaseClient {
  if (cachedAdminClient) {
    return cachedAdminClient;
  }
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    throw new Error(
      'Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in environment.'
    );
  }
  cachedAdminClient = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  return cachedAdminClient;
}

export const CORE_STORAGE_BUCKETS = [
  'source-media',
  'voice-audio',
  'thumbnails',
  'rendered-videos',
  'subtitles',
  'music-tracks',
] as const;

const verifiedBuckets = new Set<string>();

/**
 * Idempotently ensures a private Supabase Storage bucket exists so pipelines never
 * fail with "Bucket not found" even if SQL migration 002 was not run manually.
 */
export async function ensureStorageBucket(bucket: string): Promise<void> {
  if (verifiedBuckets.has(bucket)) return;
  const supabase = getSupabaseAdmin();

  const { data: existing, error: getErr } = await supabase.storage.getBucket(bucket);
  if (!getErr && existing) {
    verifiedBuckets.add(bucket);
    return;
  }

  const { error: createErr } = await supabase.storage.createBucket(bucket, {
    public: false,
  });

  if (createErr && !/already exists|duplicate/i.test(createErr.message || '')) {
    throw new Error(`Could not auto-create storage bucket "${bucket}": ${createErr.message}`);
  }
  verifiedBuckets.add(bucket);
}

/**
 * Ensures all 6 core AutoTube Studio private buckets exist (safe to call on startup).
 */
export async function ensureAllCoreBuckets(): Promise<void> {
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) return;
  for (const bucket of CORE_STORAGE_BUCKETS) {
    try {
      await ensureStorageBucket(bucket);
    } catch (err) {
      console.warn(
        `[AutoTube Storage] Startup bucket check warning (${bucket}): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
}

/**
 * Uploads binary content to Supabase Storage, automatically provisioning the bucket
 * on demand if missing and retrying once on "Bucket not found".
 */
export async function uploadToStorageWithAutoBucket(params: {
  bucket: string;
  storagePath: string;
  data: Buffer;
  contentType: string;
  upsert?: boolean;
}): Promise<{ error: { message: string } | null }> {
  const supabase = getSupabaseAdmin();
  await ensureStorageBucket(params.bucket);

  const attemptUpload = () =>
    supabase.storage.from(params.bucket).upload(params.storagePath, params.data, {
      contentType: params.contentType,
      upsert: params.upsert ?? true,
    });

  let result = await attemptUpload();
  if (result.error && /bucket not found/i.test(result.error.message || '')) {
    verifiedBuckets.delete(params.bucket);
    await ensureStorageBucket(params.bucket);
    result = await attemptUpload();
  }

  return { error: result.error ? { message: result.error.message } : null };
}

/**
 * Generates a short-lived signed URL for private Supabase Storage objects.
 */
export async function createSignedStorageUrl(
  bucket: string,
  storagePath: string | null | undefined,
  expiresInSeconds = 3600
): Promise<string | null> {
  if (!storagePath) return null;
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(storagePath, expiresInSeconds);
  if (error || !data?.signedUrl) {
    return null;
  }
  return data.signedUrl;
}
