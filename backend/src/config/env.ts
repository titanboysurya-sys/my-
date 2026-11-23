import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

export interface AppConfig {
  nodeEnv: string;
  port: number;
  corsAllowedOrigins: string[];
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
  credentialEncryptionKeyHex: string;
  oauthStateSecret: string;
  googleClientId: string;
  googleClientSecret: string;
  youtubeOAuthRedirectUri: string;
  androidOAuthCallbackUri: string;
  optionalPlatformKeys: {
    gemini?: string;
    groq?: string;
    pexels?: string;
    pixabay?: string;
    elevenlabs?: string;
  };
  workerPollIntervalMs: number;
  workerHeartbeatIntervalMs: number;
  workerStaleJobSeconds: number;
  maxDownloadBytes: number;
  ffmpegPath: string;
  ffprobePath: string;
  tempWorkDir: string;
}

const ephemeralFallbackSecret = crypto.randomBytes(32).toString('hex');

export function loadConfig(): AppConfig {
  const encryptionKey = process.env.CREDENTIAL_ENCRYPTION_KEY?.trim() || '';
  const originsRaw = process.env.CORS_ALLOWED_ORIGINS?.trim() || '';
  const corsAllowedOrigins = originsRaw
    ? originsRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  const renderExternalUrl = process.env.RENDER_EXTERNAL_URL?.trim().replace(/\/+$/, '') || '';
  const rawRedirectUri =
    process.env.YOUTUBE_OAUTH_REDIRECT_URI?.trim() ||
    (renderExternalUrl ? `${renderExternalUrl}/api/youtube/oauth/callback` : '');

  return {
    nodeEnv: process.env.NODE_ENV || 'development',
    port: Number(process.env.PORT || 8080),
    corsAllowedOrigins,
    supabaseUrl: process.env.SUPABASE_URL?.trim().replace(/\/+$/, '') || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY?.trim() || '',
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || '',
    credentialEncryptionKeyHex: encryptionKey,
    oauthStateSecret: encryptionKey || ephemeralFallbackSecret,
    googleClientId: process.env.GOOGLE_CLIENT_ID?.trim() || '',
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim() || '',
    youtubeOAuthRedirectUri: rawRedirectUri.replace(/\/+$/, ''),
    androidOAuthCallbackUri:
      process.env.ANDROID_OAUTH_CALLBACK_URI?.trim() || 'autotubestudio://oauth/youtube',
    optionalPlatformKeys: {
      gemini: process.env.GOOGLE_GEMINI_API_KEY?.trim() || undefined,
      groq: process.env.GROQ_API_KEY?.trim() || undefined,
      pexels: process.env.PEXELS_API_KEY?.trim() || undefined,
      pixabay: process.env.PIXABAY_API_KEY?.trim() || undefined,
      elevenlabs: process.env.ELEVENLABS_API_KEY?.trim() || undefined,
    },
    workerPollIntervalMs: Math.max(1000, Number(process.env.WORKER_POLL_INTERVAL_MS || 4000)),
    workerHeartbeatIntervalMs: Math.max(
      5000,
      Number(process.env.WORKER_HEARTBEAT_INTERVAL_MS || 20000)
    ),
    workerStaleJobSeconds: Math.max(60, Number(process.env.WORKER_STALE_JOB_SECONDS || 180)),
    maxDownloadBytes: Number(process.env.MAX_DOWNLOAD_BYTES || 150 * 1024 * 1024),
    ffmpegPath: process.env.FFMPEG_PATH?.trim() || 'ffmpeg',
    ffprobePath: process.env.FFPROBE_PATH?.trim() || 'ffprobe',
    tempWorkDir: path.resolve(
      process.env.TEMP_WORK_DIR?.trim() || path.join(os.tmpdir(), 'autotube-worker')
    ),
  };
}

export const config = loadConfig();

/**
 * Redacts potential secrets/tokens before persisting errors or writing logs.
 */
export function sanitizeErrorMessage(input: unknown): string {
  const raw = input instanceof Error ? input.message : String(input ?? 'Unknown error');
  return raw
    .replace(/AIza[0-9A-Za-z\-_]{20,}/g, '[REDACTED_GOOGLE_KEY]')
    .replace(/gsk_[0-9A-Za-z\-_]{16,}/g, '[REDACTED_GROQ_KEY]')
    .replace(/sk-[0-9A-Za-z\-_]{16,}/g, '[REDACTED_API_KEY]')
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
    .replace(/(key|token|secret|password)=([^&\s]+)/gi, '$1=[REDACTED]')
    .slice(0, 800);
}
