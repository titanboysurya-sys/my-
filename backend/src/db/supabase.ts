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
