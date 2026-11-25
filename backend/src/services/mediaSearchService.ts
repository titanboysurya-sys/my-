import crypto from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { config } from '../config/env.js';
import { getSupabaseAdmin, uploadToStorageWithAutoBucket } from '../db/supabase.js';
import {
  assertSafeExternalUrl,
  assertSafeExternalUrlAsync,
  resolveConfinedPath,
} from '../security/urlGuard.js';
import { resolveUserProviderKey } from './credentialService.js';

export type MediaProviderDbKey = 'pexels' | 'pixabay' | 'wikimedia' | 'nasa' | 'user_upload';
export type MediaSourceMode = 'all' | 'open_source_only' | 'api_only';

export interface MediaCandidate {
  provider: MediaProviderDbKey;
  externalId: string;
  mediaType: 'video' | 'image';
  originalUrl: string;
  downloadUrl: string;
  width: number;
  height: number;
  durationSec: number;
  titleOrTags: string;
  authorName: string;
  licenseMetadata: Record<string, unknown>;
  isUserSuppliedUrl?: boolean;
}

export interface ScoredMediaCandidate extends MediaCandidate {
  relevanceScore: number;
  isFallback: boolean;
}

export interface SceneMediaSearchInput {
  userId: string;
  projectId: string;
  sceneId: string;
  narration?: string;
  visualDescription: string;
  primaryKeyword: string;
  alternativeKeywords: string[];
  preferredType: 'video' | 'image';
  targetDurationSec: number;
  format: '9:16' | '16:9' | '1:1';
  usedExternalIds: Set<string>;
  mediaSourceMode?: MediaSourceMode;
  customMediaUrl?: string | null;
}

/**
 * Multi-factor media relevance scorer (keyword overlap + voiceover context + orientation + resolution + duration + type).
 * Prevents assigning unrelated clips merely because a search returned results.
 */
export function scoreMediaCandidate(
  candidate: MediaCandidate,
  params: {
    keywords: string[];
    visualDescription: string;
    narration?: string;
    targetDurationSec: number;
    format: '9:16' | '16:9' | '1:1';
    preferredType: 'video' | 'image';
    alreadyUsed: boolean;
  }
): number {
  if (params.alreadyUsed) return 0;

  const targetTokens = tokenize(
    `${params.keywords.join(' ')} ${params.visualDescription} ${params.narration || ''}`
  );
  const candidateTokens = tokenize(candidate.titleOrTags);

  let overlap = 0;
  for (const token of targetTokens) {
    if (candidateTokens.has(token)) overlap++;
  }
  const keywordScore =
    targetTokens.size > 0 ? Math.min(1, overlap / Math.min(4, targetTokens.size)) : 0.4;

  // Orientation match score
  const ratio = candidate.height > 0 ? candidate.width / candidate.height : 1;
  let orientationScore = 0.6;
  if (params.format === '9:16') {
    orientationScore = ratio < 0.85 ? 1.0 : ratio <= 1.2 ? 0.68 : 0.38;
  } else if (params.format === '16:9') {
    orientationScore = ratio > 1.3 ? 1.0 : ratio >= 0.9 ? 0.68 : 0.34;
  } else {
    orientationScore = ratio >= 0.8 && ratio <= 1.25 ? 1.0 : 0.72;
  }

  // Resolution quality score
  const minDim = Math.min(candidate.width || 1280, candidate.height || 720);
  const resolutionScore = minDim >= 1080 ? 1.0 : minDim >= 720 ? 0.85 : minDim >= 480 ? 0.58 : 0.3;

  // Duration suitability (penalize ultra-short < 2.2s video clips that loop choppily)
  let durationScore = 0.8;
  if (candidate.mediaType === 'video' && candidate.durationSec > 0) {
    if (candidate.durationSec < 2.2) {
      durationScore = 0.2;
    } else if (
      candidate.durationSec >= params.targetDurationSec * 0.85 &&
      candidate.durationSec <= params.targetDurationSec * 5
    ) {
      durationScore = 1.0;
    } else if (candidate.durationSec >= 2.5) {
      durationScore = 0.75;
    } else {
      durationScore = 0.4;
    }
  }

  const typeScore = candidate.mediaType === params.preferredType ? 1.0 : 0.68;

  const weighted =
    keywordScore * 0.52 +
    orientationScore * 0.18 +
    resolutionScore * 0.12 +
    durationScore * 0.1 +
    typeScore * 0.08;

  return Math.round(Math.max(0, Math.min(1, weighted)) * 1000) / 1000;
}

function extractUrlSlugText(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    return pathname
      .replace(/\/(video|photo|videos|photos|file|details)\//gi, ' ')
      .replace(/-\d+\/?$/g, ' ')
      .replace(/[-_/]+/g, ' ')
      .trim();
  } catch {
    return '';
  }
}

function tokenize(input: string): Set<string> {
  const stopWords = new Set([
    'the',
    'and',
    'for',
    'with',
    'from',
    'that',
    'this',
    'into',
    'shot',
    'scene',
    'view',
    'video',
    'photo',
    'image',
    'pexels',
    'pixabay',
    'free',
    'stock',
    'footage',
    'showing',
    'close',
    'cinematic',
  ]);
  return new Set(
    input
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !stopWords.has(w))
  );
}

/**
 * Resolves a user-supplied open-source or direct HTTPS media link into a downloadable ScoredMediaCandidate.
 * Supports:
 * - Direct HTTPS image/video links (.mp4, .webm, .mov, .jpg, .jpeg, .png, .webp)
 * - Wikimedia Commons file pages (https://commons.wikimedia.org/wiki/File:...)
 * - Internet Archive item pages (https://archive.org/details/...)
 */
export async function resolveUserCustomMediaLink(
  rawUrl: string,
  sceneHint: string
): Promise<ScoredMediaCandidate | null> {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  const parsed = await assertSafeExternalUrlAsync(trimmed, 'user_media');
  let downloadUrl = parsed.toString();
  let mediaType: 'video' | 'image' = /\.(mp4|webm|mov|m4v)(\?|$)/i.test(parsed.pathname)
    ? 'video'
    : 'image';
  let sourceName = 'Custom Link';

  // Auto-resolve Wikimedia Commons wiki/File:... pages to direct file URL
  if (
    parsed.hostname.endsWith('wikimedia.org') &&
    /\/wiki\/File:/i.test(parsed.pathname)
  ) {
    const fileTitle = decodeURIComponent(parsed.pathname.replace(/^.*\/wiki\//i, ''));
    const apiUrl = `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(
      fileTitle
    )}&prop=imageinfo&iiprop=url|mime|size&format=json`;
    const res = await fetch(apiUrl, {
      headers: { 'User-Agent': 'AutoTubeStudio/1.0 (+https://autotubestudio.app)' },
    }).catch(() => null);
    if (res?.ok) {
      const data = (await res.json()) as {
        query?: {
          pages?: Record<string, { imageinfo?: Array<{ url?: string; mime?: string }> }>;
        };
      };
      const info = Object.values(data.query?.pages || {})[0]?.imageinfo?.[0];
      if (info?.url) {
        await assertSafeExternalUrlAsync(info.url, 'user_media');
        downloadUrl = info.url;
        mediaType = (info.mime || '').startsWith('video/') ? 'video' : 'image';
        sourceName = 'Wikimedia Commons Link';
      }
    }
  }

  // Auto-resolve Internet Archive /details/<id> pages to direct MP4/image file
  if (
    parsed.hostname.endsWith('archive.org') &&
    /^\/details\/([^/?#]+)/i.test(parsed.pathname)
  ) {
    const itemId = parsed.pathname.match(/^\/details\/([^/?#]+)/i)?.[1];
    if (itemId) {
      const metaRes = await fetch(`https://archive.org/metadata/${encodeURIComponent(itemId)}`).catch(
        () => null
      );
      if (metaRes?.ok) {
        const meta = (await metaRes.json()) as {
          files?: Array<{ name?: string; format?: string; size?: string }>;
        };
        const mp4 = (meta.files || []).find(
          (f) => f.name && /\.mp4$/i.test(f.name) && Number(f.size || 0) < config.maxDownloadBytes
        );
        const img = (meta.files || []).find((f) => f.name && /\.(jpg|jpeg|png)$/i.test(f.name));
        const chosen = mp4 || img;
        if (chosen?.name) {
          const direct = `https://archive.org/download/${encodeURIComponent(itemId)}/${encodeURIComponent(
            chosen.name
          )}`;
          await assertSafeExternalUrlAsync(direct, 'user_media');
          downloadUrl = direct;
          mediaType = mp4 ? 'video' : 'image';
          sourceName = 'Internet Archive Link';
        }
      }
    }
  }

  // If extension wasn't explicit, probe Content-Type via lightweight HEAD request
  if (!/\.(mp4|webm|mov|m4v|jpg|jpeg|png|webp)(\?|$)/i.test(new URL(downloadUrl).pathname)) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 6000);
    try {
      const head = await fetch(downloadUrl, { method: 'HEAD', signal: controller.signal });
      const ct = (head.headers.get('content-type') || '').toLowerCase();
      if (ct.startsWith('video/')) mediaType = 'video';
      else if (ct.startsWith('image/')) mediaType = 'image';
    } catch {
      // Fall back to default detection during download
    } finally {
      clearTimeout(t);
    }
  }

  const hashId = crypto.createHash('sha1').update(downloadUrl).digest('hex').slice(0, 14);
  return {
    provider: 'user_upload',
    externalId: `custom-${hashId}`,
    mediaType,
    originalUrl: trimmed,
    downloadUrl,
    width: 1280,
    height: 720,
    durationSec: mediaType === 'video' ? 8 : 0,
    titleOrTags: `${sceneHint} ${extractUrlSlugText(trimmed)}`.trim(),
    authorName: sourceName,
    licenseMetadata: { license: 'User Supplied Open-Source Link', source: sourceName },
    isUserSuppliedUrl: true,
    relevanceScore: 1.0,
    isFallback: mediaType === 'image',
  };
}

async function searchPexels(
  apiKey: string,
  query: string,
  mediaType: 'video' | 'image',
  format: '9:16' | '16:9' | '1:1'
): Promise<MediaCandidate[]> {
  const orientation = format === '9:16' ? 'portrait' : format === '16:9' ? 'landscape' : 'square';
  const url =
    mediaType === 'video'
      ? `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&orientation=${orientation}&per_page=8`
      : `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&orientation=${orientation}&per_page=8`;

  const res = await fetch(url, { headers: { Authorization: apiKey } }).catch(() => null);
  if (!res?.ok) return [];

  if (mediaType === 'video') {
    const data = (await res.json()) as {
      videos?: Array<{
        id: number;
        url: string;
        duration: number;
        width: number;
        height: number;
        user?: { name?: string };
        video_files?: Array<{ link: string; width: number; height: number; file_type: string }>;
      }>;
    };
    return (data.videos || [])
      .map((v): MediaCandidate | null => {
        const maxWidth =
          process.env.RENDER === 'true' && process.env.HIGH_MEMORY_WORKER !== 'true' ? 1280 : 1920;
        const mp4Files = (v.video_files || [])
          .filter((f) => f.file_type === 'video/mp4' && f.width <= maxWidth)
          .sort((a, b) => b.width * b.height - a.width * a.height);
        const fallbackFiles = (v.video_files || [])
          .filter((f) => f.file_type === 'video/mp4' && f.width <= 1920)
          .sort((a, b) => a.width * a.height - b.width * b.height);
        const best = mp4Files[0] || fallbackFiles[0] || v.video_files?.[0];
        if (!best?.link) return null;
        return {
          provider: 'pexels' as const,
          externalId: `pexels-v-${v.id}`,
          mediaType: 'video' as const,
          originalUrl: v.url,
          downloadUrl: best.link,
          width: best.width || v.width,
          height: best.height || v.height,
          durationSec: v.duration || 5,
          titleOrTags: extractUrlSlugText(v.url),
          authorName: v.user?.name || 'Pexels Creator',
          licenseMetadata: { license: 'Pexels License', attributionRequired: false },
        };
      })
      .filter((x): x is MediaCandidate => x !== null);
  } else {
    const data = (await res.json()) as {
      photos?: Array<{
        id: number;
        url: string;
        width: number;
        height: number;
        alt?: string;
        photographer?: string;
        src?: { large2x?: string; original?: string };
      }>;
    };
    return (data.photos || [])
      .map((p): MediaCandidate | null => {
        const dl = p.src?.large2x || p.src?.original;
        if (!dl) return null;
        return {
          provider: 'pexels' as const,
          externalId: `pexels-i-${p.id}`,
          mediaType: 'image' as const,
          originalUrl: p.url,
          downloadUrl: dl,
          width: p.width,
          height: p.height,
          durationSec: 0,
          titleOrTags: `${p.alt || ''} ${extractUrlSlugText(p.url)}`.trim(),
          authorName: p.photographer || 'Pexels Photographer',
          licenseMetadata: { license: 'Pexels License', attributionRequired: false },
        };
      })
      .filter((x): x is MediaCandidate => x !== null);
  }
}

async function searchPixabay(
  apiKey: string,
  query: string,
  mediaType: 'video' | 'image'
): Promise<MediaCandidate[]> {
  const endpoint =
    mediaType === 'video'
      ? `https://pixabay.com/api/videos/?key=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(query)}&per_page=8&safesearch=true`
      : `https://pixabay.com/api/?key=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(query)}&image_type=photo&per_page=8&safesearch=true`;

  const res = await fetch(endpoint).catch(() => null);
  if (!res?.ok) return [];

  if (mediaType === 'video') {
    const data = (await res.json()) as {
      hits?: Array<{
        id: number;
        pageURL: string;
        tags: string;
        duration: number;
        user: string;
        videos?: {
          medium?: { url: string; width: number; height: number };
          large?: { url: string; width: number; height: number };
        };
      }>;
    };
    return (data.hits || [])
      .map((h): MediaCandidate | null => {
        const stream = h.videos?.medium?.url ? h.videos.medium : h.videos?.large;
        if (!stream?.url) return null;
        return {
          provider: 'pixabay' as const,
          externalId: `pixabay-v-${h.id}`,
          mediaType: 'video' as const,
          originalUrl: h.pageURL,
          downloadUrl: stream.url,
          width: stream.width,
          height: stream.height,
          durationSec: h.duration || 5,
          titleOrTags: h.tags || '',
          authorName: h.user || 'Pixabay Creator',
          licenseMetadata: { license: 'Pixabay Content License', attributionRequired: false },
        };
      })
      .filter((x): x is MediaCandidate => x !== null);
  } else {
    const data = (await res.json()) as {
      hits?: Array<{
        id: number;
        pageURL: string;
        tags: string;
        imageWidth: number;
        imageHeight: number;
        largeImageURL: string;
        user: string;
      }>;
    };
    return (data.hits || [])
      .filter((h) => Boolean(h.largeImageURL))
      .map((h) => ({
        provider: 'pixabay' as const,
        externalId: `pixabay-i-${h.id}`,
        mediaType: 'image' as const,
        originalUrl: h.pageURL,
        downloadUrl: h.largeImageURL,
        width: h.imageWidth,
        height: h.imageHeight,
        durationSec: 0,
        titleOrTags: h.tags || '',
        authorName: h.user || 'Pixabay Contributor',
        licenseMetadata: { license: 'Pixabay Content License', attributionRequired: false },
      }));
  }
}

/**
 * Open-Source (No API Key): Wikimedia Commons high-res CC/Public Domain images
 */
async function searchWikimediaCommonsImages(query: string): Promise<MediaCandidate[]> {
  const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch=${encodeURIComponent(
    `${query} filetype:bitmap`
  )}&gsrlimit=8&prop=imageinfo&iiprop=url|size|mime|extmetadata&format=json`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'AutoTubeStudio/1.0 (+https://autotubestudio.app)' },
  }).catch(() => null);
  if (!res?.ok) return [];

  const data = (await res.json()) as {
    query?: {
      pages?: Record<
        string,
        {
          pageid: number;
          title: string;
          imageinfo?: Array<{
            url: string;
            descriptionurl: string;
            width: number;
            height: number;
            mime?: string;
            extmetadata?: {
              LicenseShortName?: { value?: string };
              Artist?: { value?: string };
              ImageDescription?: { value?: string };
            };
          }>;
        }
      >;
    };
  };

  const pages = Object.values(data.query?.pages || {});
  return pages
    .map((p): MediaCandidate | null => {
      const info = p.imageinfo?.[0];
      if (!info?.url || info.width < 640) return null;
      if (info.mime && !/^image\/(jpeg|png|webp)$/i.test(info.mime)) return null;
      const cleanTitle = p.title.replace(/^File:/i, '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
      const desc = (info.extmetadata?.ImageDescription?.value || '')
        .replace(/<[^>]+>/g, ' ')
        .slice(0, 140);
      return {
        provider: 'wikimedia' as const,
        externalId: `wiki-${p.pageid}`,
        mediaType: 'image' as const,
        originalUrl: info.descriptionurl || info.url,
        downloadUrl: info.url,
        width: info.width,
        height: info.height,
        durationSec: 0,
        titleOrTags: `${cleanTitle} ${desc}`.trim(),
        authorName: (info.extmetadata?.Artist?.value || 'Wikimedia Contributor')
          .replace(/<[^>]+>/g, '')
          .slice(0, 120),
        licenseMetadata: {
          source: 'Wikimedia Commons',
          license: info.extmetadata?.LicenseShortName?.value || 'Wikimedia Commons',
          attributionRequired: true,
        },
      };
    })
    .filter((x): x is MediaCandidate => x !== null);
}

/**
 * Open-Source (No API Key): Openverse Creative Commons curated photo index
 */
async function searchOpenverseImages(
  query: string,
  format: '9:16' | '16:9' | '1:1'
): Promise<MediaCandidate[]> {
  const aspect = format === '9:16' ? 'tall' : format === '16:9' ? 'wide' : 'square';
  const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(
    query
  )}&aspect_ratio=${aspect}&license_type=commercial&page_size=8`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'AutoTubeStudio/1.0' },
    }).catch(() => null);
    if (!res?.ok) return [];

    const data = (await res.json()) as {
      results?: Array<{
        id: string;
        title?: string;
        url?: string;
        foreign_landing_url?: string;
        width?: number;
        height?: number;
        creator?: string;
        license?: string;
        tags?: Array<{ name?: string }>;
      }>;
    };

    return (data.results || [])
      .map((r): MediaCandidate | null => {
        if (!r.url || !r.url.startsWith('https://')) return null;
        const w = r.width || 1280;
        const h = r.height || 720;
        if (w < 640 || h < 480) return null;
        // Ensure Openverse host is either in allowlist or safe public HTTPS image host
        try {
          assertSafeExternalUrl(r.url, 'user_media');
        } catch {
          return null;
        }
        const tagText = (r.tags || []).map((t) => t.name || '').join(' ');
        return {
          provider: 'wikimedia' as const, // stored under open-license provider enum
          externalId: `openverse-${r.id}`,
          mediaType: 'image' as const,
          originalUrl: r.foreign_landing_url || r.url,
          downloadUrl: r.url,
          width: w,
          height: h,
          durationSec: 0,
          titleOrTags: `${r.title || ''} ${tagText}`.trim(),
          authorName: r.creator || 'Openverse Creator',
          licenseMetadata: {
            source: 'Openverse',
            license: r.license || 'CC-BY',
            attributionRequired: true,
          },
          isUserSuppliedUrl: true, // uses DNS-verified user_media guard because Openverse links to Flickr/Wikimedia/etc.
        };
      })
      .filter((x): x is MediaCandidate => x !== null);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Open-Source (No API Key): NASA Public Domain Image Library (great for space, science, earth, tech)
 */
async function searchNasaImages(query: string): Promise<MediaCandidate[]> {
  const url = `https://images-api.nasa.gov/search?q=${encodeURIComponent(
    query
  )}&media_type=image&page_size=6`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const res = await fetch(url, { signal: controller.signal }).catch(() => null);
    if (!res?.ok) return [];

    const data = (await res.json()) as {
      collection?: {
        items?: Array<{
          data?: Array<{
            nasa_id?: string;
            title?: string;
            description?: string;
            keywords?: string[];
          }>;
          links?: Array<{ href?: string; rel?: string; render?: string }>;
        }>;
      };
    };

    return (data.collection?.items || [])
      .map((item): MediaCandidate | null => {
        const meta = item.data?.[0];
        const preview = item.links?.find((l) => l.rel === 'preview' && l.href?.startsWith('https://'));
        if (!meta?.nasa_id || !preview?.href) return null;
        return {
          provider: 'nasa' as const,
          externalId: `nasa-${meta.nasa_id}`,
          mediaType: 'image' as const,
          originalUrl: `https://images.nasa.gov/details-${meta.nasa_id}`,
          downloadUrl: preview.href,
          width: 1280,
          height: 720,
          durationSec: 0,
          titleOrTags: `${meta.title || ''} ${(meta.keywords || []).join(' ')} ${(meta.description || '').slice(0, 120)}`.trim(),
          authorName: 'NASA Public Domain',
          licenseMetadata: { source: 'NASA', license: 'Public Domain', attributionRequired: false },
        };
      })
      .filter((x): x is MediaCandidate => x !== null);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Open-Source (No API Key): Internet Archive Public Domain / Creative Commons MP4 clips
 */
async function searchInternetArchiveVideos(query: string): Promise<MediaCandidate[]> {
  const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(
    `(${query}) AND mediatype:movies AND format:"h.264"`
  )}&fl[]=identifier&fl[]=title&fl[]=description&fl[]=subject&rows=4&output=json`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const res = await fetch(url, { signal: controller.signal }).catch(() => null);
    if (!res?.ok) return [];

    const data = (await res.json()) as {
      response?: {
        docs?: Array<{
          identifier?: string;
          title?: string;
          description?: string | string[];
          subject?: string | string[];
        }>;
      };
    };

    const docs = (data.response?.docs || []).slice(0, 3);
    const out: MediaCandidate[] = [];

    for (const doc of docs) {
      if (!doc.identifier) continue;
      const metaRes = await fetch(
        `https://archive.org/metadata/${encodeURIComponent(doc.identifier)}/files`,
        { signal: controller.signal }
      ).catch(() => null);
      if (!metaRes?.ok) continue;
      const meta = (await metaRes.json()) as {
        result?: Array<{ name?: string; size?: string; length?: string; width?: string; height?: string }>;
      };
      const mp4 = (meta.result || []).find(
        (f) =>
          f.name &&
          /\.mp4$/i.test(f.name) &&
          Number(f.size || 0) > 20_000 &&
          Number(f.size || 0) < 28 * 1024 * 1024
      );
      if (!mp4?.name) continue;
      const subjects = Array.isArray(doc.subject) ? doc.subject.join(' ') : doc.subject || '';
      out.push({
        provider: 'wikimedia' as const, // open-source bucket in media_assets enum
        externalId: `ia-${doc.identifier}`,
        mediaType: 'video',
        originalUrl: `https://archive.org/details/${doc.identifier}`,
        downloadUrl: `https://archive.org/download/${encodeURIComponent(
          doc.identifier
        )}/${encodeURIComponent(mp4.name)}`,
        width: Number(mp4.width || 1280),
        height: Number(mp4.height || 720),
        durationSec: Math.min(60, Math.max(4, Number(mp4.length || 10))),
        titleOrTags: `${doc.title || ''} ${subjects}`.trim(),
        authorName: 'Internet Archive',
        licenseMetadata: {
          source: 'Internet Archive',
          license: 'Public Domain / Creative Commons',
          attributionRequired: false,
        },
      });
    }
    return out;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Executes voiceover-matched media search cascade:
 * 0. User-provided custom / open-source direct link for this scene (highest priority!)
 * 1. Pexels & Pixabay stock video + Internet Archive open-source video (when enabled)
 * 2. Stock & Open-Source high-res images (Pexels, Pixabay, Openverse, Wikimedia Commons, NASA)
 *    with strict semantic scoring against narration + visual description so visuals match voiceover!
 */
export async function findBestMediaForScene(
  input: SceneMediaSearchInput
): Promise<ScoredMediaCandidate | null> {
  // Pass 0: Exact user-supplied media link for this scene
  if (input.customMediaUrl?.trim()) {
    try {
      const resolved = await resolveUserCustomMediaLink(
        input.customMediaUrl.trim(),
        input.visualDescription || input.primaryKeyword
      );
      if (resolved) return resolved;
    } catch (err) {
      console.warn(
        `[AutoTube Media] Custom link skipped for scene ${input.sceneId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  const mode: MediaSourceMode = input.mediaSourceMode || 'all';
  const useApis = mode !== 'open_source_only';
  const useOpenSource = mode !== 'api_only';

  const pexelsCred = useApis ? await resolveUserProviderKey(input.userId, 'pexels') : null;
  const pixabayCred = useApis ? await resolveUserProviderKey(input.userId, 'pixabay') : null;

  const keywords = [input.primaryKeyword, ...input.alternativeKeywords]
    .map((k) => k.trim())
    .filter(Boolean);

  const evaluate = (candidates: MediaCandidate[], isFallback: boolean): ScoredMediaCandidate[] =>
    candidates
      .map((c) => ({
        ...c,
        isFallback,
        relevanceScore: scoreMediaCandidate(c, {
          keywords,
          visualDescription: input.visualDescription,
          narration: input.narration,
          targetDurationSec: input.targetDurationSec,
          format: input.format,
          preferredType: input.preferredType,
          alreadyUsed: input.usedExternalIds.has(c.externalId),
        }),
      }))
      .filter((c) => c.relevanceScore >= 0.34)
      .sort((a, b) => b.relevanceScore - a.relevanceScore);

  // Pass 1: Stock video search across keywords and providers
  const allVideoCandidates: ScoredMediaCandidate[] = [];
  if (useApis && (pexelsCred || pixabayCred)) {
    for (const kw of keywords.slice(0, 3)) {
      const batch: MediaCandidate[] = [];
      if (pexelsCred) {
        batch.push(...(await searchPexels(pexelsCred.apiKey, kw, 'video', input.format)));
      }
      if (pixabayCred) {
        batch.push(...(await searchPixabay(pixabayCred.apiKey, kw, 'video')));
      }
      const ranked = evaluate(batch, false);
      if (ranked.length > 0 && ranked[0].relevanceScore >= 0.72 && ranked[0].durationSec >= 2.5) {
        return ranked[0];
      }
      allVideoCandidates.push(...ranked);
    }
  }

  // Pass 1b: Open-source video search (Internet Archive) when open-source mode is enabled and no high-confidence API video yet
  if (useOpenSource && keywords.length > 0 && (!allVideoCandidates[0] || allVideoCandidates[0].relevanceScore < 0.62)) {
    const iaBatch = await searchInternetArchiveVideos(keywords[0]);
    allVideoCandidates.push(...evaluate(iaBatch, false));
  }

  allVideoCandidates.sort((a, b) => b.relevanceScore - a.relevanceScore);
  if (allVideoCandidates.length > 0 && allVideoCandidates[0].relevanceScore >= 0.52) {
    return allVideoCandidates[0];
  }

  // Pass 2: High-relevance images across BOTH stock APIs and Open-Source libraries (Openverse + Wikimedia + NASA)
  const allImageCandidates: ScoredMediaCandidate[] = [];
  for (const kw of keywords.slice(0, 2)) {
    const queries: Array<Promise<MediaCandidate[]>> = [];
    if (pexelsCred) queries.push(searchPexels(pexelsCred.apiKey, kw, 'image', input.format));
    if (pixabayCred) queries.push(searchPixabay(pixabayCred.apiKey, kw, 'image'));
    if (useOpenSource) {
      queries.push(searchWikimediaCommonsImages(kw));
      queries.push(searchOpenverseImages(kw, input.format));
      queries.push(searchNasaImages(kw));
    }
    const batches = await Promise.all(queries);
    const merged = batches.flat();
    const ranked = evaluate(merged, true);
    if (ranked.length > 0 && ranked[0].relevanceScore >= 0.72) {
      return ranked[0];
    }
    allImageCandidates.push(...ranked);
  }

  // Compare best video vs best exact-match open-source/stock image so voiceover matching wins!
  allImageCandidates.sort((a, b) => b.relevanceScore - a.relevanceScore);
  const bestVid = allVideoCandidates[0] || null;
  const bestImg = allImageCandidates[0] || null;

  if (bestVid && bestImg) {
    return bestImg.relevanceScore >= bestVid.relevanceScore + 0.14 ? bestImg : bestVid;
  }
  return bestVid || bestImg || null;
}

/**
 * Robust media downloader with SSRF protection, DNS verification, retry, file-size cap,
 * SHA-256 deduplication, and persistent storage upload to Supabase Storage `source-media`.
 */
export async function downloadAndPersistMedia(params: {
  userId: string;
  projectId: string;
  sceneId: string;
  candidate: ScoredMediaCandidate;
  workDir: string;
}): Promise<{ localFilePath: string; storagePath: string; sha256: string; sizeBytes: number }> {
  const supabase = getSupabaseAdmin();

  // Deduplication check: reuse already-persisted media for the same user & externalId
  const { data: existing } = await supabase
    .from('media_assets')
    .select('storage_path, sha256_hash, file_size_bytes')
    .eq('user_id', params.userId)
    .eq('provider', params.candidate.provider)
    .eq('external_id', params.candidate.externalId)
    .not('storage_path', 'is', null)
    .limit(1)
    .maybeSingle();

  const ext = params.candidate.mediaType === 'video' ? '.mp4' : '.jpg';
  const localFilePath = resolveConfinedPath(params.workDir, `scene_${params.sceneId}${ext}`);

  if (existing?.storage_path) {
    const { data: blob, error } = await supabase.storage
      .from('source-media')
      .download(existing.storage_path);
    if (!error && blob) {
      const buf = Buffer.from(await blob.arrayBuffer());
      await fs.writeFile(localFilePath, buf);
      return {
        localFilePath,
        storagePath: existing.storage_path,
        sha256: existing.sha256_hash || computeSha256(buf),
        sizeBytes: buf.length,
      };
    }
  }

  // Validate outbound URL (plus DNS check for user/openverse links) before streaming to disk
  const guardKind = params.candidate.isUserSuppliedUrl ? 'user_media' : 'media';
  const safeUrl = await assertSafeExternalUrlAsync(params.candidate.downloadUrl, guardKind);
  const { sha256, sizeBytes } = await downloadToFileWithRetry(
    safeUrl.toString(),
    localFilePath,
    config.maxDownloadBytes,
    3,
    guardKind
  );

  // Basic file integrity check
  if (sizeBytes < 1024) {
    throw new Error('Downloaded media file failed integrity check (too small).');
  }

  const storagePath = `${params.userId}/${params.projectId}/${sha256.slice(0, 16)}${ext}`;
  const contentType = params.candidate.mediaType === 'video' ? 'video/mp4' : 'image/jpeg';

  // Skip mirroring oversized raw clips on low-memory containers (source clips are purged after render anyway)
  const lowMem = process.env.RENDER === 'true' && process.env.HIGH_MEMORY_WORKER !== 'true';
  if (lowMem && sizeBytes > 18 * 1024 * 1024) {
    return { localFilePath, storagePath: '', sha256, sizeBytes };
  }

  const buf = await fs.readFile(localFilePath);
  const { error: uploadError } = await uploadToStorageWithAutoBucket({
    bucket: 'source-media',
    storagePath,
    data: buf,
    contentType,
    upsert: true,
  });

  if (uploadError) {
    if (/maximum allowed size|payload too large|entity too large|413/i.test(uploadError.message)) {
      console.warn(
        `[AutoTube Media] Skipping persistent mirror for oversized clip (${sizeBytes} bytes); continuing with local file.`
      );
      return { localFilePath, storagePath: '', sha256, sizeBytes };
    }
    throw new Error(`Failed to upload source media to persistent storage: ${uploadError.message}`);
  }

  return { localFilePath, storagePath, sha256, sizeBytes };
}

async function downloadToFileWithRetry(
  url: string,
  destPath: string,
  maxBytes: number,
  retries: number,
  guardKind: 'media' | 'user_media' = 'media'
): Promise<{ sha256: string; sizeBytes: number }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      let currentUrl = url;
      let res: globalThis.Response | null = null;
      // Follow up to 4 redirects safely, validating every redirect hop against SSRF guard
      for (let hop = 0; hop < 5; hop++) {
        res = await fetch(currentUrl, {
          signal: controller.signal,
          redirect: 'manual',
          headers: { 'User-Agent': 'AutoTubeStudio/1.0' },
        });
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location');
          if (!loc) throw new Error('Redirect missing Location header');
          const nextUrl = new URL(loc, currentUrl).toString();
          await assertSafeExternalUrlAsync(nextUrl, guardKind === 'user_media' ? 'user_media' : 'user_media');
          currentUrl = nextUrl;
          continue;
        }
        break;
      }

      if (!res || !res.ok) {
        throw new Error(`Media download returned HTTP ${res?.status ?? 0}`);
      }
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (ct && !ct.startsWith('image/') && !ct.startsWith('video/') && !ct.includes('octet-stream')) {
        throw new Error(`Unsupported media content-type: ${ct}`);
      }
      const contentLength = Number(res.headers.get('content-length') || 0);
      if (contentLength > maxBytes) {
        throw new Error(`Media file exceeds maximum allowed size (${maxBytes} bytes).`);
      }

      const hash = crypto.createHash('sha256');
      let total = 0;
      const reader = res.body?.getReader();
      if (!reader) {
        const arr = Buffer.from(await res.arrayBuffer());
        if (arr.length > maxBytes) throw new Error('Downloaded buffer exceeded size limit.');
        await fs.writeFile(destPath, arr);
        hash.update(arr);
        return { sha256: hash.digest('hex'), sizeBytes: arr.length };
      }

      const fileStream = createWriteStream(destPath);
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            throw new Error('Streaming download exceeded max allowed size.');
          }
          const chunk = Buffer.from(value);
          hash.update(chunk);
          if (!fileStream.write(chunk)) {
            await new Promise<void>((resolve) => fileStream.once('drain', resolve));
          }
        }
        await new Promise<void>((resolve, reject) => {
          fileStream.end(() => resolve());
          fileStream.once('error', reject);
        });
      } catch (streamErr) {
        fileStream.destroy();
        throw streamErr;
      }

      return { sha256: hash.digest('hex'), sizeBytes: total };
    } catch (err) {
      lastError = err;
      await fs.rm(destPath, { force: true }).catch(() => undefined);
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, attempt * 1500));
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Media download failed after retries');
}

function computeSha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
