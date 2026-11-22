import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/env.js';
import { getSupabaseAdmin, uploadToStorageWithAutoBucket } from '../db/supabase.js';
import { assertSafeExternalUrl, resolveConfinedPath } from '../security/urlGuard.js';
import { resolveUserProviderKey } from './credentialService.js';

export interface MediaCandidate {
  provider: 'pexels' | 'pixabay' | 'wikimedia';
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
}

export interface ScoredMediaCandidate extends MediaCandidate {
  relevanceScore: number;
  isFallback: boolean;
}

export interface SceneMediaSearchInput {
  userId: string;
  projectId: string;
  sceneId: string;
  visualDescription: string;
  primaryKeyword: string;
  alternativeKeywords: string[];
  preferredType: 'video' | 'image';
  targetDurationSec: number;
  format: '9:16' | '16:9' | '1:1';
  usedExternalIds: Set<string>;
}

/**
 * Multi-factor media relevance scorer (keyword overlap + orientation + resolution + duration + type).
 * Prevents assigning unrelated clips merely because a search returned results.
 */
export function scoreMediaCandidate(
  candidate: MediaCandidate,
  params: {
    keywords: string[];
    visualDescription: string;
    targetDurationSec: number;
    format: '9:16' | '16:9' | '1:1';
    preferredType: 'video' | 'image';
    alreadyUsed: boolean;
  }
): number {
  if (params.alreadyUsed) return 0;

  const targetTokens = tokenize(`${params.keywords.join(' ')} ${params.visualDescription}`);
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
    orientationScore = ratio < 0.85 ? 1.0 : ratio <= 1.2 ? 0.65 : 0.35;
  } else if (params.format === '16:9') {
    orientationScore = ratio > 1.3 ? 1.0 : ratio >= 0.9 ? 0.65 : 0.3;
  } else {
    orientationScore = ratio >= 0.8 && ratio <= 1.25 ? 1.0 : 0.7;
  }

  // Resolution quality score
  const minDim = Math.min(candidate.width, candidate.height);
  const resolutionScore = minDim >= 1080 ? 1.0 : minDim >= 720 ? 0.85 : minDim >= 480 ? 0.55 : 0.25;

  // Duration suitability (for videos)
  let durationScore = 0.8;
  if (candidate.mediaType === 'video' && candidate.durationSec > 0) {
    if (candidate.durationSec >= params.targetDurationSec && candidate.durationSec <= params.targetDurationSec * 4) {
      durationScore = 1.0;
    } else if (candidate.durationSec >= params.targetDurationSec * 0.6) {
      durationScore = 0.75;
    } else {
      durationScore = 0.4;
    }
  }

  const typeScore = candidate.mediaType === params.preferredType ? 1.0 : 0.65;

  const weighted =
    keywordScore * 0.42 +
    orientationScore * 0.22 +
    resolutionScore * 0.16 +
    durationScore * 0.12 +
    typeScore * 0.08;

  return Math.round(Math.max(0, Math.min(1, weighted)) * 1000) / 1000;
}

function tokenize(input: string): Set<string> {
  const stopWords = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'shot', 'scene', 'view']);
  return new Set(
    input
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !stopWords.has(w))
  );
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

  const res = await fetch(url, { headers: { Authorization: apiKey } });
  if (!res.ok) return [];

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
        const mp4Files = (v.video_files || [])
          .filter((f) => f.file_type === 'video/mp4' && f.width <= 1920)
          .sort((a, b) => b.width * b.height - a.width * a.height);
        const best = mp4Files[0] || v.video_files?.[0];
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
          titleOrTags: `${query} ${v.url}`,
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
          titleOrTags: `${query} ${p.alt || ''}`,
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

  const res = await fetch(endpoint);
  if (!res.ok) return [];

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
          titleOrTags: `${query} ${h.tags || ''}`,
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
        titleOrTags: `${query} ${h.tags || ''}`,
        authorName: h.user || 'Pixabay Contributor',
        licenseMetadata: { license: 'Pixabay Content License', attributionRequired: false },
      }));
  }
}

async function searchWikimediaCommonsImages(query: string): Promise<MediaCandidate[]> {
  const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch=${encodeURIComponent(
    `${query} filetype:bitmap`
  )}&gsrlimit=6&prop=imageinfo&iiprop=url|size|extmetadata&format=json`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'AutoTubeStudio/1.0 (+https://autotubestudio.app)' },
  });
  if (!res.ok) return [];

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
            extmetadata?: {
              LicenseShortName?: { value?: string };
              Artist?: { value?: string };
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
      return {
        provider: 'wikimedia' as const,
        externalId: `wiki-${p.pageid}`,
        mediaType: 'image' as const,
        originalUrl: info.descriptionurl || info.url,
        downloadUrl: info.url,
        width: info.width,
        height: info.height,
        durationSec: 0,
        titleOrTags: `${query} ${p.title}`,
        authorName: (info.extmetadata?.Artist?.value || 'Wikimedia Contributor').replace(/<[^>]+>/g, '').slice(0, 120),
        licenseMetadata: {
          license: info.extmetadata?.LicenseShortName?.value || 'Wikimedia Commons',
          attributionRequired: true,
        },
      };
    })
    .filter((x): x is MediaCandidate => x !== null);
}

/**
 * Executes ordered media search cascade:
 * 1. Primary + alternative keywords on Pexels & Pixabay (video)
 * 2. Fallback to Pexels & Pixabay image search (for Ken Burns motion)
 * 3. Fallback to Wikimedia Commons public-domain/CC images
 */
export async function findBestMediaForScene(
  input: SceneMediaSearchInput
): Promise<ScoredMediaCandidate | null> {
  const pexelsCred = await resolveUserProviderKey(input.userId, 'pexels');
  const pixabayCred = await resolveUserProviderKey(input.userId, 'pixabay');

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
          targetDurationSec: input.targetDurationSec,
          format: input.format,
          preferredType: input.preferredType,
          alreadyUsed: input.usedExternalIds.has(c.externalId),
        }),
      }))
      .filter((c) => c.relevanceScore >= 0.35)
      .sort((a, b) => b.relevanceScore - a.relevanceScore);

  // Pass 1: Stock video search across keywords and providers
  for (const kw of keywords) {
    const batch: MediaCandidate[] = [];
    if (pexelsCred) {
      batch.push(...(await searchPexels(pexelsCred.apiKey, kw, 'video', input.format)));
    }
    if (pixabayCred) {
      batch.push(...(await searchPixabay(pixabayCred.apiKey, kw, 'video')));
    }
    const ranked = evaluate(batch, false);
    if (ranked.length > 0 && ranked[0].relevanceScore >= 0.48) {
      return ranked[0];
    }
  }

  // Pass 2: Stock image fallback (will be animated with Ken Burns zoom/pan in FFmpeg)
  for (const kw of keywords) {
    const batch: MediaCandidate[] = [];
    if (pexelsCred) {
      batch.push(...(await searchPexels(pexelsCred.apiKey, kw, 'image', input.format)));
    }
    if (pixabayCred) {
      batch.push(...(await searchPixabay(pixabayCred.apiKey, kw, 'image')));
    }
    const ranked = evaluate(batch, true);
    if (ranked.length > 0) {
      return ranked[0];
    }
  }

  // Pass 3: Wikimedia Commons open-license image fallback
  for (const kw of keywords.slice(0, 2)) {
    const wikiBatch = await searchWikimediaCommonsImages(kw);
    const ranked = evaluate(wikiBatch, true);
    if (ranked.length > 0) {
      return ranked[0];
    }
  }

  return null;
}

/**
 * Robust media downloader with SSRF protection, retry, file-size cap, SHA-256 deduplication,
 * and persistent storage upload to Supabase Storage `source-media`.
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

  // Validate outbound URL before downloading
  const safeUrl = assertSafeExternalUrl(params.candidate.downloadUrl, 'media');
  const buf = await downloadWithRetry(safeUrl.toString(), config.maxDownloadBytes, 3);

  // Basic file integrity check
  if (buf.length < 1024) {
    throw new Error('Downloaded media file failed integrity check (too small).');
  }

  const sha256 = computeSha256(buf);
  const storagePath = `${params.userId}/${params.projectId}/${sha256.slice(0, 16)}${ext}`;
  const contentType = params.candidate.mediaType === 'video' ? 'video/mp4' : 'image/jpeg';

  await fs.writeFile(localFilePath, buf);

  const { error: uploadError } = await uploadToStorageWithAutoBucket({
    bucket: 'source-media',
    storagePath,
    data: buf,
    contentType,
    upsert: true,
  });

  if (uploadError) {
    // If a single high-bitrate clip exceeds Supabase Free Tier's 50 MB upload cap,
    // keep rendering from the verified local file (source clips are purged after render anyway).
    if (/maximum allowed size|payload too large|entity too large|413/i.test(uploadError.message)) {
      console.warn(
        `[AutoTube Media] Skipping persistent mirror for oversized clip (${buf.length} bytes); continuing with local file.`
      );
      return { localFilePath, storagePath: '', sha256, sizeBytes: buf.length };
    }
    throw new Error(`Failed to upload source media to persistent storage: ${uploadError.message}`);
  }

  return { localFilePath, storagePath, sha256, sizeBytes: buf.length };
}

async function downloadWithRetry(url: string, maxBytes: number, retries: number): Promise<Buffer> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`Media download returned HTTP ${res.status}`);
      }
      const contentLength = Number(res.headers.get('content-length') || 0);
      if (contentLength > maxBytes) {
        throw new Error(`Media file exceeds maximum allowed size (${maxBytes} bytes).`);
      }

      const chunks: Buffer[] = [];
      let total = 0;
      const reader = res.body?.getReader();
      if (!reader) {
        const arr = Buffer.from(await res.arrayBuffer());
        if (arr.length > maxBytes) throw new Error('Downloaded buffer exceeded size limit.');
        return arr;
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          throw new Error('Streaming download exceeded max allowed size.');
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks);
    } catch (err) {
      lastError = err;
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
