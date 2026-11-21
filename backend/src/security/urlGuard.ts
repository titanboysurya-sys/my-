import path from 'node:path';
import net from 'node:net';

const ALLOWED_MEDIA_HOST_SUFFIXES = [
  'pexels.com',
  'pixabay.com',
  'wikimedia.org',
  'wikipedia.org',
  'nasa.gov',
  'googleapis.com',
  'supabase.co',
  'supabase.in',
];

const ALLOWED_RSS_HOST_SUFFIXES = [
  'feeds.bbci.co.uk',
  'rss.nytimes.com',
  'feeds.reuters.com',
  'techcrunch.com',
  'theverge.com',
  'arstechnica.com',
  'sciencedaily.com',
  'nasa.gov',
  'news.google.com',
  'feeds.npr.org',
];

function isPrivateOrLoopbackIp(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    normalized === 'localhost' ||
    normalized === '0.0.0.0' ||
    normalized === '::1' ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal')
  ) {
    return true;
  }

  if (net.isIPv4(normalized)) {
    const parts = normalized.split('.').map(Number);
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true; // cloud metadata 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }

  if (net.isIPv6(normalized)) {
    if (normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80')) {
      return true;
    }
  }
  return false;
}

function matchesSuffix(hostname: string, allowlist: string[]): boolean {
  const lower = hostname.toLowerCase();
  return allowlist.some((suffix) => lower === suffix || lower.endsWith(`.${suffix}`));
}

/**
 * Validates outbound media or RSS URLs against HTTPS scheme, private-IP blocking,
 * and strict host allowlists to prevent SSRF attacks.
 */
export function assertSafeExternalUrl(rawUrl: string, kind: 'media' | 'rss' = 'media'): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Malformed external URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`Blocked non-HTTPS URL scheme: ${parsed.protocol}`);
  }

  if (isPrivateOrLoopbackIp(parsed.hostname)) {
    throw new Error(`Blocked private or loopback address: ${parsed.hostname}`);
  }

  const allowlist = kind === 'media' ? ALLOWED_MEDIA_HOST_SUFFIXES : ALLOWED_RSS_HOST_SUFFIXES;
  if (!matchesSuffix(parsed.hostname, allowlist)) {
    throw new Error(`Host not in ${kind} allowlist: ${parsed.hostname}`);
  }

  return parsed;
}

/**
 * Confines any dynamically constructed file path strictly within a base directory
 * to prevent path traversal attacks.
 */
export function resolveConfinedPath(baseDir: string, ...segments: string[]): string {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, ...segments);
  const expectedPrefix = resolvedBase.endsWith(path.sep)
    ? resolvedBase
    : `${resolvedBase}${path.sep}`;

  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(expectedPrefix)) {
    throw new Error('Path traversal attempt blocked');
  }
  return resolvedTarget;
}
