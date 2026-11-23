import crypto from 'node:crypto';

export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

const MODEL_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DISCOVERY_TIMEOUT_MS = 8000;

interface CachedModelList {
  fetchedAt: number;
  models: string[];
  failedModels: Set<string>;
}

const groqCache = new Map<string, CachedModelList>();
const geminiTextCache = new Map<string, CachedModelList>();
const geminiTtsCache = new Map<string, CachedModelList>();

const GROQ_STATIC_FALLBACK = [
  'openai/gpt-oss-120b',
  'llama-3.3-70b-versatile',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'qwen/qwen3-32b',
  'openai/gpt-oss-20b',
  'llama-3.1-8b-instant',
];

const GEMINI_TEXT_STATIC_FALLBACK = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-2.5-pro',
];

const GEMINI_TTS_STATIC_FALLBACK = [
  'gemini-2.5-flash-preview-tts',
  'gemini-2.5-pro-preview-tts',
];

function keyFingerprint(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey.trim()).digest('hex').slice(0, 16);
}

export interface GroqRawModel {
  id?: string;
  active?: boolean;
  context_window?: number;
}

export interface GeminiRawModel {
  name?: string;
  supportedGenerationMethods?: string[];
}

const GROQ_EXCLUDE_PATTERN =
  /(whisper|tts|orpheus|playai|guard|safeguard|embed|rerank|moderation|speech|audio|vision-preview|compound|allam)/i;

/**
 * Pure ranking function for live Groq chat/JSON models.
 * Automatically scores future model generations (Llama 4/5, GPT-OSS, Qwen 3+, etc.)
 * so newly launched active models are adopted seamlessly when older models retire.
 */
export function rankGroqChatModels(
  rawModels: GroqRawModel[],
  preference: string = 'auto'
): string[] {
  const pref = (preference || 'auto').trim();
  const prefLower = pref.toLowerCase();
  const preferFast = prefLower === 'fast' || prefLower === 'high_limit';

  const activeIds = rawModels
    .filter((m) => m.id && m.active !== false && !GROQ_EXCLUDE_PATTERN.test(m.id))
    .map((m) => String(m.id).trim());

  const uniqueIds = Array.from(new Set(activeIds));

  const scoreModel = (id: string): number => {
    const lower = id.toLowerCase();
    let score = 0;

    // Detect lightweight/high-throughput models (8b, 20b, instant, scout, mini, lite)
    const isLight =
      /(?<![0-9])(8b|7b|9b|17b|20b)\b|\b(instant|mini|lite|scout|small)\b/i.test(lower);
    const isLarge =
      /(?<![0-9])(120b|70b|72b|90b|405b|32b)\b|\b(maverick|versatile)\b/i.test(lower);

    if (preferFast) {
      if (isLight) score += 60;
      if (lower.includes('instant')) score += 25;
      if (lower.includes('gpt-oss-20b')) score += 20;
      if (isLarge) score += 25;
    } else {
      if (isLarge) score += 65;
      if (isLight) score += 30;
    }

    // Prefer major production model families & newer versions dynamically
    if (lower.includes('gpt-oss-120b')) score += 45;
    else if (lower.includes('gpt-oss-20b')) score += 38;
    else if (lower.includes('gpt-oss')) score += 35;

    const llamaMatch = lower.match(/llama[-_]?(\d+)(?:\.(\d+))?/);
    if (llamaMatch) {
      const ver = Number(llamaMatch[1]) + Number(llamaMatch[2] || 0) / 10;
      score += Math.round(ver * 12); // llama-4 -> 48, llama-3.3 -> 40, llama-3.1 -> 37
      if (lower.includes('maverick')) score += 12;
      if (lower.includes('versatile')) score += 10;
      if (lower.includes('instruct')) score += 5;
    }

    const qwenMatch = lower.match(/qwen[-_]?(\d+)(?:\.(\d+))?/);
    if (qwenMatch) {
      const ver = Number(qwenMatch[1]) + Number(qwenMatch[2] || 0) / 10;
      score += Math.round(ver * 11);
    }

    if (lower.includes('kimi') || lower.includes('deepseek')) score += 25;

    // Slightly penalize experimental/preview/specdec variants unless no stable equivalent exists
    if (/(preview|exp|beta|specdec|tool-use)/i.test(lower)) {
      score -= 8;
    }

    return score;
  };

  uniqueIds.sort((a, b) => scoreModel(b) - scoreModel(a));

  // If user explicitly requested a specific model ID and it is STILL active, put it first.
  // If Groq deprecated/removed that model, it won't be in uniqueIds, so we seamlessly skip it!
  if (
    prefLower !== 'auto' &&
    prefLower !== 'best' &&
    prefLower !== 'fast' &&
    prefLower !== 'high_limit'
  ) {
    const exact = uniqueIds.find((id) => id.toLowerCase() === prefLower);
    if (exact) {
      return [exact, ...uniqueIds.filter((id) => id !== exact)];
    }
  }

  return uniqueIds;
}

const GEMINI_TEXT_EXCLUDE_PATTERN =
  /(embedding|aqa|imagen|veo|lyria|tts|audio|live|robotics|computer-use|deep-research|learnlm|gemma|bison|gecko|vision-only)/i;

/**
 * Pure ranking function for live Google Gemini text/JSON models.
 * Automatically prefers the newest active Flash generation (e.g. 3.x / 4.x when launched),
 * with Flash-Lite and Pro as high-resilience backups.
 */
export function rankGeminiTextModels(
  rawModels: GeminiRawModel[],
  preferredModel?: string
): string[] {
  const candidates: string[] = [];
  for (const m of rawModels) {
    if (!m.name) continue;
    const methods = m.supportedGenerationMethods || [];
    if (methods.length > 0 && !methods.includes('generateContent')) continue;
    const id = m.name.replace(/^models\//, '').trim();
    if (!/^gemini-/i.test(id)) continue;
    if (GEMINI_TEXT_EXCLUDE_PATTERN.test(id)) continue;
    candidates.push(id);
  }

  const uniqueIds = Array.from(new Set(candidates));

  const scoreModel = (id: string): number => {
    const lower = id.toLowerCase();
    let score = 0;

    // Extract generation version dynamically (e.g., gemini-3.5-flash -> 3.5, gemini-2.5-flash -> 2.5)
    const verMatch = lower.match(/^gemini-(\d+)(?:\.(\d+))?/);
    if (verMatch) {
      const ver = Number(verMatch[1]) + Number(verMatch[2] || 0) / 10;
      score += Math.round(ver * 30); // 4.0 -> 120, 3.5 -> 105, 3.0 -> 90, 2.5 -> 75, 2.0 -> 60
      if (ver < 2.0) score -= 60; // Strongly deprioritize legacy 1.x models
    }

    // Prefer Flash (fast + generous free quota) -> Flash-Lite (very high quota) -> Pro
    if (lower.includes('flash-lite')) {
      score += 24;
    } else if (lower.includes('flash')) {
      score += 32;
    } else if (lower.includes('pro')) {
      score += 14;
    }

    // Prefer stable aliases over dated snapshots, previews, or experimental tags
    if (/(exp|experimental)/i.test(lower)) score -= 18;
    else if (/(preview|beta)/i.test(lower)) score -= 7;
    if (/-\d{3,4}$/.test(lower) || /-\d{2}-\d{2,4}/.test(lower)) score -= 4;
    if (lower.endsWith('-latest')) score += 4;

    return score;
  };

  uniqueIds.sort((a, b) => scoreModel(b) - scoreModel(a));

  if (preferredModel) {
    const prefClean = preferredModel.replace(/^models\//, '').trim();
    const exact = uniqueIds.find((id) => id.toLowerCase() === prefClean.toLowerCase());
    if (exact) {
      return [exact, ...uniqueIds.filter((id) => id !== exact)];
    }
  }

  return uniqueIds;
}

/**
 * Pure ranking function for live Google Gemini TTS audio models.
 */
export function rankGeminiTtsModels(rawModels: GeminiRawModel[]): string[] {
  const candidates: string[] = [];
  for (const m of rawModels) {
    if (!m.name) continue;
    const methods = m.supportedGenerationMethods || [];
    if (methods.length > 0 && !methods.includes('generateContent')) continue;
    const id = m.name.replace(/^models\//, '').trim();
    if (/^gemini-.*tts/i.test(id)) {
      candidates.push(id);
    }
  }

  const uniqueIds = Array.from(new Set(candidates));

  const scoreTts = (id: string): number => {
    const lower = id.toLowerCase();
    let score = 0;
    const verMatch = lower.match(/^gemini-(\d+)(?:\.(\d+))?/);
    if (verMatch) {
      const ver = Number(verMatch[1]) + Number(verMatch[2] || 0) / 10;
      score += Math.round(ver * 30);
    }
    if (lower.includes('flash')) score += 25;
    else if (lower.includes('pro')) score += 12;
    if (!lower.includes('preview') && !lower.includes('exp')) score += 10;
    return score;
  };

  uniqueIds.sort((a, b) => scoreTts(b) - scoreTts(a));
  return uniqueIds;
}

/**
 * Detects errors indicating a model was deprecated, retired, decommissioned, or removed.
 */
export function isModelRetiredOrUnsupportedError(status: number, errorText: string): boolean {
  const lower = (errorText || '').toLowerCase();
  if (status === 404 || status === 410) return true;
  if (status === 400 || status === 422) {
    return (
      lower.includes('decommission') ||
      lower.includes('deprecated') ||
      lower.includes('retired') ||
      lower.includes('no longer supported') ||
      lower.includes('model_not_found') ||
      lower.includes('not found') ||
      lower.includes('does not exist') ||
      lower.includes('is not supported for generatecontent') ||
      lower.includes('unsupported model') ||
      lower.includes('invalid model')
    );
  }
  return false;
}

/**
 * Live-discovers active Groq chat models for the user's API key (cached 30 min).
 */
export async function resolveActiveGroqModels(
  apiKey: string,
  preference: string = 'auto',
  forceRefresh = false
): Promise<string[]> {
  const fp = `${keyFingerprint(apiKey)}:${(preference || 'auto').toLowerCase()}`;
  const cached = groqCache.get(fp);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < MODEL_CACHE_TTL_MS) {
    const filtered = cached.models.filter((m) => !cached.failedModels.has(m));
    if (filtered.length > 0) return filtered;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const res = await fetch(`${GROQ_BASE_URL}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (res.ok) {
      const payload = (await res.json()) as { data?: GroqRawModel[] };
      const ranked = rankGroqChatModels(payload.data || [], preference);
      if (ranked.length > 0) {
        const failedSet = forceRefresh ? new Set<string>() : cached?.failedModels || new Set<string>();
        groqCache.set(fp, {
          fetchedAt: Date.now(),
          models: ranked,
          failedModels: failedSet,
        });
        const available = ranked.filter((m) => !failedSet.has(m));
        return available.length > 0 ? available : ranked;
      }
    }
  } catch {
    // Fall back to static list if discovery endpoint temporarily times out
  } finally {
    clearTimeout(timer);
  }

  return GROQ_STATIC_FALLBACK;
}

export function markGroqModelRetired(apiKey: string, modelId: string): void {
  const prefix = `${keyFingerprint(apiKey)}:`;
  for (const [cacheKey, entry] of groqCache.entries()) {
    if (cacheKey.startsWith(prefix)) {
      entry.failedModels.add(modelId);
    }
  }
}

async function fetchGeminiRawModels(apiKey: string): Promise<GeminiRawModel[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?pageSize=100&key=${encodeURIComponent(
        apiKey
      )}`,
      { method: 'GET', signal: controller.signal }
    );
    if (!res.ok) return null;
    const payload = (await res.json()) as { models?: GeminiRawModel[] };
    return Array.isArray(payload.models) ? payload.models : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Live-discovers active Gemini text/JSON models for the user's API key (cached 30 min).
 */
export async function resolveActiveGeminiTextModels(
  apiKey: string,
  preferredModel?: string,
  forceRefresh = false
): Promise<string[]> {
  const fp = `${keyFingerprint(apiKey)}:${(preferredModel || 'auto').toLowerCase()}`;
  const cached = geminiTextCache.get(fp);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < MODEL_CACHE_TTL_MS) {
    const filtered = cached.models.filter((m) => !cached.failedModels.has(m));
    if (filtered.length > 0) return filtered;
  }

  const rawModels = await fetchGeminiRawModels(apiKey);
  if (rawModels && rawModels.length > 0) {
    const rankedText = rankGeminiTextModels(rawModels, preferredModel);
    const rankedTts = rankGeminiTtsModels(rawModels);

    if (rankedTts.length > 0) {
      geminiTtsCache.set(keyFingerprint(apiKey), {
        fetchedAt: Date.now(),
        models: rankedTts,
        failedModels: new Set<string>(),
      });
    }

    if (rankedText.length > 0) {
      const failedSet = forceRefresh ? new Set<string>() : cached?.failedModels || new Set<string>();
      geminiTextCache.set(fp, {
        fetchedAt: Date.now(),
        models: rankedText,
        failedModels: failedSet,
      });
      const available = rankedText.filter((m) => !failedSet.has(m));
      return available.length > 0 ? available : rankedText;
    }
  }

  return GEMINI_TEXT_STATIC_FALLBACK;
}

export function markGeminiTextModelRetired(apiKey: string, modelId: string): void {
  const prefix = `${keyFingerprint(apiKey)}:`;
  for (const [cacheKey, entry] of geminiTextCache.entries()) {
    if (cacheKey.startsWith(prefix)) {
      entry.failedModels.add(modelId);
    }
  }
}

/**
 * Live-discovers active Gemini TTS models for the user's API key (cached 30 min).
 */
export async function resolveActiveGeminiTtsModels(
  apiKey: string,
  forceRefresh = false
): Promise<string[]> {
  const fp = keyFingerprint(apiKey);
  const cached = geminiTtsCache.get(fp);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < MODEL_CACHE_TTL_MS) {
    const filtered = cached.models.filter((m) => !cached.failedModels.has(m));
    if (filtered.length > 0) return filtered;
  }

  const rawModels = await fetchGeminiRawModels(apiKey);
  if (rawModels && rawModels.length > 0) {
    const rankedTts = rankGeminiTtsModels(rawModels);
    if (rankedTts.length > 0) {
      const failedSet = forceRefresh ? new Set<string>() : cached?.failedModels || new Set<string>();
      geminiTtsCache.set(fp, {
        fetchedAt: Date.now(),
        models: rankedTts,
        failedModels: failedSet,
      });
      const available = rankedTts.filter((m) => !failedSet.has(m));
      return available.length > 0 ? available : rankedTts;
    }
  }

  return GEMINI_TTS_STATIC_FALLBACK;
}

export function markGeminiTtsModelRetired(apiKey: string, modelId: string): void {
  const entry = geminiTtsCache.get(keyFingerprint(apiKey));
  if (entry) {
    entry.failedModels.add(modelId);
  }
}
