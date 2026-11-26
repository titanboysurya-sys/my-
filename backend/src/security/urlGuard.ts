import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';

const ALLOWED_MEDIA_HOST_SUFFIXES = [
  'pexels.com',
  'pixabay.com',
  'wikimedia.org',
  'wikipedia.org',
  'nasa.gov',
  'archive.org',
  'openverse.org',
  'lexica.art',
  'civitai.com',
  'aihorde.net',
  'stablehorde.net',
  'r2.dev',
  'r2.cloudflarestorage.com',
  'staticflickr.com',
  'unsplash.com',
  'coverr.co',
  'mixkit.co',
  'githubusercontent.com',
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

export function isPrivateOrLoopbackIp(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    normalized === 'localhost' ||
    normalized === '0.0.0.0' ||
    normalized === '::1' ||
    normalized === '::' ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal') ||
    normalized.endsWith('.localhost')
  ) {
    return true;
  }

  // Handle IPv4-mapped IPv6 addresses like ::ffff:127.0.0.1
  const mappedV4 = normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized;

  if (net.isIPv4(mappedV4)) {
    const parts = mappedV4.split('.').map(Number);
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // Carrier-grade NAT 100.64.0.0/10
    if (a === 169 && b === 254) return true; // cloud metadata 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true; // multicast / reserved
  }

  if (net.isIPv6(normalized)) {
    if (
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb') ||
      normalized.startsWith('ff')
    ) {
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
 * Use kind='user_media' for user-provided open-source direct links (HTTPS + public host only;
 * must be paired with assertSafeExternalUrlAsync before fetching).
 */
export function assertSafeExternalUrl(
  rawUrl: string,
  kind: 'media' | 'rss' | 'user_media' = 'media'
): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('Malformed external URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`Blocked non-HTTPS URL scheme: ${parsed.protocol}`);
  }

  if (parsed.username || parsed.password) {
    throw new Error('Blocked URL containing embedded credentials');
  }

  if (isPrivateOrLoopbackIp(parsed.hostname)) {
    throw new Error(`Blocked private or loopback address: ${parsed.hostname}`);
  }

  if (kind !== 'user_media') {
    const allowlist = kind === 'media' ? ALLOWED_MEDIA_HOST_SUFFIXES : ALLOWED_RSS_HOST_SUFFIXES;
    if (!matchesSuffix(parsed.hostname, allowlist)) {
      throw new Error(`Host not in ${kind} allowlist: ${parsed.hostname}`);
    }
  } else {
    // Reject bare IP literals for user-supplied links to prevent direct internal probing
    const bare = parsed.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(bare) !== 0 || !parsed.hostname.includes('.')) {
      throw new Error(`Direct IP or invalid host not permitted: ${parsed.hostname}`);
    }
  }

  return parsed;
}

/**
 * Performs syntactic URL validation PLUS DNS resolution check to guarantee the resolved
 * remote IP is public (protects against DNS rebinding SSRF for user-supplied media URLs).
 */
export async function assertSafeExternalUrlAsync(
  rawUrl: string,
  kind: 'media' | 'rss' | 'user_media' = 'media'
): Promise<URL> {
  const parsed = assertSafeExternalUrl(rawUrl, kind);
  try {
    const records = await dns.lookup(parsed.hostname, { all: true });
    if (!records.length) {
      throw new Error(`Could not resolve host: ${parsed.hostname}`);
    }
    for (const rec of records) {
      if (isPrivateOrLoopbackIp(rec.address)) {
        throw new Error(`Blocked resolved private/loopback IP for ${parsed.hostname}`);
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Blocked ')) {
      throw err;
    }
    throw new Error(`Host resolution failed for ${parsed.hostname}`);
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
