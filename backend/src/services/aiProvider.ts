import { sanitizeErrorMessage } from '../config/env.js';
import { getSupabaseAdmin } from '../db/supabase.js';
import { assertSafeExternalUrl } from '../security/urlGuard.js';
import {
  DEFAULT_GROQ_MODEL,
  GROQ_BASE_URL,
  resolveUserProviderKey,
} from './credentialService.js';

export type LLMProviderName = 'gemini' | 'groq' | 'openai_compatible';

export interface TopicResearchInput {
  niche: string;
  language: string;
  audienceCountry: string;
  contentStyle: string;
  durationSeconds: number;
  topicType: 'evergreen' | 'trending' | 'news';
  count: number;
  avoidedTopics?: string[];
  preferredTopics?: string[];
}

export interface ResearchReference {
  title: string;
  source: string;
  url: string;
  publishedAt: string;
}

export interface TopicSuggestion {
  topic: string;
  angle: string;
  whyNow: string;
  references: ResearchReference[];
}

export interface GeneratedScript {
  titleIdea: string;
  hook: string;
  narrationText: string;
  fullScript: string;
  ending: string;
  callToAction: string;
  wordCount: number;
}

export interface GeneratedScene {
  sceneNumber: number;
  narration: string;
  estimatedDuration: number;
  visualDescription: string;
  primaryKeyword: string;
  alternativeKeywords: string[];
  mediaTypePreference: 'video' | 'image';
  transition: string;
  subtitleText: string;
}

export interface GeneratedSeoMetadata {
  title: string;
  description: string;
  tags: string[];
  hashtags: string[];
  categoryId: string;
  thumbnailHeadline: string;
  thumbnailVisualPrompt: string;
}

export interface AIProviderClient {
  readonly name: string;
  generateJson<T>(systemPrompt: string, userPrompt: string): Promise<T>;
}

const NICHE_RSS_FEEDS: Record<string, string[]> = {
  'AI News': [
    'https://techcrunch.com/category/artificial-intelligence/feed/',
    'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml',
  ],
  Technology: [
    'https://feeds.arstechnica.com/arstechnica/technology-lab',
    'https://techcrunch.com/feed/',
  ],
  Science: [
    'https://www.sciencedaily.com/rss/top/science.xml',
    'https://www.nasa.gov/rss/dyn/breaking_news.rss',
  ],
  Business: ['https://feeds.bbci.co.uk/news/business/rss.xml'],
  Finance: ['https://feeds.bbci.co.uk/news/business/rss.xml'],
  default: [
    'https://feeds.bbci.co.uk/news/world/rss.xml',
    'https://feeds.npr.org/1001/rss.xml',
  ],
};

/**
 * Fetches verified RSS headlines + dates + links so news/trending research never hallucinates facts.
 */
export async function fetchVerifiedRssItems(
  niche: string,
  maxItems = 8
): Promise<ResearchReference[]> {
  const feeds = NICHE_RSS_FEEDS[niche] || NICHE_RSS_FEEDS.default;
  const collected: ResearchReference[] = [];

  for (const feedUrl of feeds) {
    try {
      const safeUrl = assertSafeExternalUrl(feedUrl, 'rss');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(safeUrl.toString(), {
        headers: { 'User-Agent': 'AutoTubeStudio/1.0 (+https://autotubestudio.app)' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) continue;

      const xml = await res.text();
      const itemRegex = /<(?:item|entry)[\s\S]*?<\/(?:item|entry)>/gi;
      const matches = xml.match(itemRegex) || [];

      for (const block of matches.slice(0, maxItems)) {
        const title = extractXmlTag(block, 'title');
        const link = extractXmlTag(block, 'link') || extractHrefAttr(block);
        const pubDate =
          extractXmlTag(block, 'pubDate') ||
          extractXmlTag(block, 'updated') ||
          new Date().toISOString();

        if (title && link && link.startsWith('https://')) {
          collected.push({
            title: cleanXmlText(title),
            source: safeUrl.hostname,
            url: link.trim(),
            publishedAt: pubDate.trim(),
          });
        }
        if (collected.length >= maxItems) break;
      }
    } catch {
      // Continue with other feeds if one feed times out
    }
    if (collected.length >= maxItems) break;
  }

  return collected;
}

function extractXmlTag(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = xml.match(regex);
  return match?.[1] || '';
}

function extractHrefAttr(xml: string): string {
  const match = xml.match(/<link[^>]*href=["'](https:\/\/[^"']+)["']/i);
  return match?.[1] || '';
}

function cleanXmlText(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

class GeminiAIProvider implements AIProviderClient {
  readonly name = 'gemini';
  private readonly model: string;

  constructor(private readonly apiKey: string, model = 'gemini-2.5-flash') {
    this.model = model;
  }

  async generateJson<T>(systemPrompt: string, userPrompt: string): Promise<T> {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      this.model
    )}:generateContent?key=${encodeURIComponent(this.apiKey)}`;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0.7,
          responseMimeType: 'application/json',
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 429) {
        throw new Error('Gemini API quota or rate limit exceeded (HTTP 429).');
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error('Invalid Gemini API key. Update your key in API Settings.');
      }
      throw new Error(`Gemini request failed (${res.status}): ${sanitizeErrorMessage(errText)}`);
    }

    const payload = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const rawText = payload.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
      throw new Error('Gemini returned an empty response.');
    }
    return parseJsonLoose<T>(rawText);
  }
}

class OpenAICompatibleProvider implements AIProviderClient {
  readonly name = 'openai_compatible';
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(
    private readonly apiKey: string,
    baseUrl = 'https://api.openai.com/v1',
    model = 'gpt-4o-mini'
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
  }

  async generateJson<T>(systemPrompt: string, userPrompt: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.7,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });

    if (!res.ok) {
      if (res.status === 429) {
        throw new Error('AI provider rate limit exceeded (HTTP 429).');
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error('Invalid AI provider API key.');
      }
      throw new Error(`AI provider error (${res.status})`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const rawText = data.choices?.[0]?.message?.content;
    if (!rawText) {
      throw new Error('AI provider returned empty completion.');
    }
    return parseJsonLoose<T>(rawText);
  }
}

class GroqAIProvider implements AIProviderClient {
  readonly name = 'groq';
  private readonly models: string[];

  constructor(private readonly apiKey: string, model = DEFAULT_GROQ_MODEL) {
    const preferredModel = (model || DEFAULT_GROQ_MODEL).trim();
    const candidates = [preferredModel, DEFAULT_GROQ_MODEL, 'llama-3.1-8b-instant'];
    this.models = Array.from(new Set(candidates.filter(Boolean)));
  }

  async generateJson<T>(systemPrompt: string, userPrompt: string): Promise<T> {
    const ensuredSystem = /json/i.test(systemPrompt)
      ? systemPrompt
      : `${systemPrompt}\nReturn strictly valid JSON.`;
    const errors: string[] = [];

    for (let i = 0; i < this.models.length; i++) {
      const model = this.models[i];
      const res = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0.7,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: ensuredSystem },
            { role: 'user', content: userPrompt },
          ],
        }),
      });

      if (res.ok) {
        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const rawText = data.choices?.[0]?.message?.content;
        if (!rawText) {
          errors.push(`${model}: empty completion`);
          continue;
        }
        return parseJsonLoose<T>(rawText);
      }

      if (res.status === 401 || res.status === 403) {
        throw new Error('Invalid Groq API key. Update your key in API Settings.');
      }

      const errText = await res.text().catch(() => '');
      if (res.status === 429) {
        errors.push(`${model}: HTTP 429`);
        // Try fast fallback Groq model (e.g., llama-3.1-8b-instant) before giving up
        if (i + 1 < this.models.length) {
          continue;
        }
        throw new Error('Groq API quota or rate limit exceeded (HTTP 429).');
      }

      if (res.status === 404 && i + 1 < this.models.length) {
        errors.push(`${model}: model unavailable (404)`);
        continue;
      }

      throw new Error(`Groq request failed (${res.status}): ${sanitizeErrorMessage(errText)}`);
    }

    throw new Error(`Groq request failed (${errors.join('; ')})`);
  }
}

export function isFailoverEligibleError(err: unknown): boolean {
  const msg = sanitizeErrorMessage(err).toLowerCase();
  return (
    msg.includes('429') ||
    msg.includes('quota') ||
    msg.includes('rate limit') ||
    msg.includes('resource_exhausted') ||
    msg.includes('temporarily unavailable') ||
    msg.includes('empty response') ||
    msg.includes('empty completion') ||
    msg.includes('(500)') ||
    msg.includes('(502)') ||
    msg.includes('(503)') ||
    msg.includes('(504)') ||
    msg.includes('timeout')
  );
}

/**
 * Wraps multiple configured AI providers so HTTP 429 / quota exhaustion on one provider
 * (e.g., Gemini Free Tier after 3-4 videos) seamlessly fails over to the next configured provider
 * (e.g., Groq) without aborting the pipeline.
 */
export class FallbackAIProvider implements AIProviderClient {
  readonly name: string;

  constructor(private readonly providers: AIProviderClient[]) {
    this.name = providers.map((p) => p.name).join('>');
  }

  async generateJson<T>(systemPrompt: string, userPrompt: string): Promise<T> {
    const errors: string[] = [];
    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i];
      try {
        return await provider.generateJson<T>(systemPrompt, userPrompt);
      } catch (err) {
        const msg = sanitizeErrorMessage(err);
        errors.push(`${provider.name}: ${msg}`);
        const hasNext = i + 1 < this.providers.length;
        if (hasNext && isFailoverEligibleError(err)) {
          console.warn(
            `[AutoTube AI] ${provider.name} hit limit/transient error (${msg}); failing over to ${this.providers[i + 1].name}.`
          );
          continue;
        }
        throw err;
      }
    }
    throw new Error(`All configured AI providers failed (${errors.join(' | ')})`);
  }
}

export function parseJsonLoose<T>(text: string): T {
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '');
  return JSON.parse(cleaned) as T;
}

async function resolvePreferredLLMFromProfile(userId: string): Promise<LLMProviderName | null> {
  try {
    const supabase = getSupabaseAdmin();
    const { data } = await supabase
      .from('profiles')
      .select('preferences')
      .eq('user_id', userId)
      .maybeSingle();
    const prefs = (data?.preferences as Record<string, unknown>) || {};
    const pref = String(prefs.script_provider || prefs.research_provider || '').trim().toLowerCase();
    if (pref === 'groq' || pref === 'gemini' || pref === 'openai_compatible') {
      return pref;
    }
  } catch {
    // Non-fatal: fall back to default provider priority
  }
  return null;
}

export async function createAIProviderForUser(
  userId: string,
  preferred?: LLMProviderName
): Promise<AIProviderClient> {
  const selectedPrimary = preferred || (await resolvePreferredLLMFromProfile(userId)) || 'gemini';
  const defaultOrder: LLMProviderName[] = ['groq', 'gemini', 'openai_compatible'];
  const ordered: LLMProviderName[] = [
    selectedPrimary,
    ...defaultOrder.filter((p) => p !== selectedPrimary),
  ];

  const resolvedClients: AIProviderClient[] = [];
  for (const name of ordered) {
    const cred = await resolveUserProviderKey(userId, name);
    if (!cred) continue;
    if (name === 'groq') {
      resolvedClients.push(
        new GroqAIProvider(cred.apiKey, String(cred.providerConfig.model || DEFAULT_GROQ_MODEL))
      );
    } else if (name === 'openai_compatible') {
      resolvedClients.push(
        new OpenAICompatibleProvider(
          cred.apiKey,
          String(cred.providerConfig.base_url || 'https://api.openai.com/v1'),
          String(cred.providerConfig.model || 'gpt-4o-mini')
        )
      );
    } else {
      resolvedClients.push(
        new GeminiAIProvider(
          cred.apiKey,
          String(cred.providerConfig.model || 'gemini-2.5-flash')
        )
      );
    }
  }

  if (resolvedClients.length === 1) {
    return resolvedClients[0];
  }
  if (resolvedClients.length > 1) {
    return new FallbackAIProvider(resolvedClients);
  }

  throw new Error(
    'No AI provider key configured. Add your Groq or Gemini API key in Settings -> AI Providers & API Keys.'
  );
}

export interface LanguageMeta {
  code: string;
  name: string;
  ttsName: string;
  scriptInstruction: string;
}

const LANGUAGE_MAP: Record<string, LanguageMeta> = {
  en: {
    code: 'en',
    name: 'English',
    ttsName: 'English',
    scriptInstruction: 'Write strictly in natural, fluent English.',
  },
  hi: {
    code: 'hi',
    name: 'Hindi (Devanagari)',
    ttsName: 'Hindi',
    scriptInstruction:
      'Write strictly in natural spoken Hindi using Devanagari script (हिंदी). Do NOT write sentences in English; only keep unavoidable brand/tech names.',
  },
  hinglish: {
    code: 'hinglish',
    name: 'Hinglish (Hindi in Roman script)',
    ttsName: 'Hindi',
    scriptInstruction:
      'Write strictly in natural conversational Hindi written in Roman/Latin script (Hinglish, e.g. "Aaj hum janenge ki..."). Do NOT write pure English and do NOT use Devanagari characters.',
  },
  es: {
    code: 'es',
    name: 'Spanish',
    ttsName: 'Spanish',
    scriptInstruction: 'Write strictly in natural, engaging Spanish (Español). Do NOT write in English.',
  },
  fr: {
    code: 'fr',
    name: 'French',
    ttsName: 'French',
    scriptInstruction: 'Write strictly in natural, engaging French (Français). Do NOT write in English.',
  },
  de: {
    code: 'de',
    name: 'German',
    ttsName: 'German',
    scriptInstruction: 'Write strictly in natural, engaging German (Deutsch). Do NOT write in English.',
  },
  ja: {
    code: 'ja',
    name: 'Japanese',
    ttsName: 'Japanese',
    scriptInstruction: 'Write strictly in natural Japanese (日本語). Do NOT write in English.',
  },
  pt: {
    code: 'pt',
    name: 'Portuguese',
    ttsName: 'Portuguese',
    scriptInstruction: 'Write strictly in natural Portuguese (Português). Do NOT write in English.',
  },
};

export function resolveLanguageMeta(rawCode: string): LanguageMeta {
  const normalized = (rawCode || 'en').trim().toLowerCase();
  if (LANGUAGE_MAP[normalized]) return LANGUAGE_MAP[normalized];
  if (normalized.startsWith('hi') && normalized.includes('inglish')) return LANGUAGE_MAP.hinglish;
  if (normalized.startsWith('hi') || normalized.includes('hindi')) return LANGUAGE_MAP.hi;
  if (normalized.startsWith('es') || normalized.includes('span')) return LANGUAGE_MAP.es;
  if (normalized.startsWith('fr') || normalized.includes('fren')) return LANGUAGE_MAP.fr;
  if (normalized.startsWith('de') || normalized.includes('germ')) return LANGUAGE_MAP.de;
  if (normalized.startsWith('ja') || normalized.includes('japan')) return LANGUAGE_MAP.ja;
  if (normalized.startsWith('pt') || normalized.includes('portug')) return LANGUAGE_MAP.pt;
  if (normalized.startsWith('en') || normalized.includes('engl')) return LANGUAGE_MAP.en;
  return {
    code: normalized,
    name: rawCode.trim() || 'English',
    ttsName: rawCode.trim() || 'English',
    scriptInstruction: `Write strictly in natural ${rawCode.trim() || 'English'}. Do NOT switch to another language.`,
  };
}

/**
 * Calculates target spoken word count range based on video duration (~2.3 words/sec).
 */
export function targetWordRangeForDuration(durationSeconds: number): { min: number; max: number } {
  const min = Math.max(35, Math.round(durationSeconds * 2.1));
  const max = Math.max(min + 15, Math.round(durationSeconds * 2.75));
  return { min, max };
}

export async function researchTopicsWithAI(
  ai: AIProviderClient,
  input: TopicResearchInput
): Promise<{ suggestions: TopicSuggestion[]; verifiedReferences: ResearchReference[] }> {
  const lang = resolveLanguageMeta(input.language);
  const rssItems =
    input.topicType === 'news' || input.topicType === 'trending' || input.niche === 'AI News'
      ? await fetchVerifiedRssItems(input.niche, 8)
      : [];

  const systemPrompt = `You are a factual YouTube content strategist.
CRITICAL LANGUAGE RULE: ${lang.scriptInstruction} All suggested topic titles, angles, and whyNow explanations MUST be written in ${lang.name} (even if RSS reference headlines are in English).
Never invent breaking news, statistics, or dates. When source headlines are supplied, base news topics strictly on those verified sources and include their exact URLs and publication dates. Return strictly valid JSON.`;

  const userPrompt = JSON.stringify({
    task: 'Suggest high-retention YouTube video topics',
    niche: input.niche,
    targetLanguageCode: lang.code,
    targetLanguageName: lang.name,
    languageRequirement: lang.scriptInstruction,
    audienceCountry: input.audienceCountry,
    contentStyle: input.contentStyle,
    durationSeconds: input.durationSeconds,
    topicType: input.topicType,
    count: Math.min(Math.max(1, input.count), 10),
    preferredTopics: input.preferredTopics || [],
    avoidedTopics: input.avoidedTopics || [],
    verifiedNewsSources: rssItems,
    requiredJsonSchema: {
      suggestions: [
        {
          topic: `string (MUST be in ${lang.name})`,
          angle: `string (MUST be in ${lang.name})`,
          whyNow: `string (MUST be in ${lang.name})`,
          references: [{ title: 'string', source: 'string', url: 'string', publishedAt: 'string' }],
        },
      ],
    },
  });

  const result = await ai.generateJson<{ suggestions: TopicSuggestion[] }>(systemPrompt, userPrompt);
  return {
    suggestions: Array.isArray(result.suggestions) ? result.suggestions : [],
    verifiedReferences: rssItems,
  };
}

export async function generateScriptWithAI(
  ai: AIProviderClient,
  params: {
    topic: string;
    niche: string;
    language: string;
    contentStyle: string;
    durationSeconds: number;
    tone?: string;
    references?: ResearchReference[];
  }
): Promise<GeneratedScript> {
  const words = targetWordRangeForDuration(params.durationSeconds);
  const lang = resolveLanguageMeta(params.language);

  const systemPrompt = `You are an elite YouTube scriptwriter.
CRITICAL LANGUAGE RULE: ${lang.scriptInstruction} Every single field (titleIdea, hook, narrationText, fullScript, ending, callToAction) MUST be written in ${lang.name}. NEVER default to English if the requested language is ${lang.name}.
Write original, natural, punchy spoken narration with zero filler greetings ("Hey guys welcome back") and zero stage directions/brackets inside narrationText. Match the spoken word count strictly to the target duration (${words.min}-${words.max} spoken words). Do not fabricate facts. Return strictly valid JSON.`;

  const userPrompt = JSON.stringify({
    topic: params.topic,
    niche: params.niche,
    targetLanguageCode: lang.code,
    targetLanguageName: lang.name,
    languageRequirement: lang.scriptInstruction,
    contentStyle: params.contentStyle,
    tone: params.tone || 'engaging',
    durationSeconds: params.durationSeconds,
    targetWordRange: words,
    verifiedReferences: params.references || [],
    requiredJsonSchema: {
      titleIdea: `string (in ${lang.name})`,
      hook: `string (first 3 seconds spoken hook in ${lang.name})`,
      narrationText: `string (complete continuous spoken narration in ${lang.name} from hook to ending, ready for TTS, no stage brackets or markdown)`,
      fullScript: `string (formatted script in ${lang.name})`,
      ending: `string (in ${lang.name})`,
      callToAction: `string (in ${lang.name})`,
    },
  });

  const raw = await ai.generateJson<Omit<GeneratedScript, 'wordCount'>>(systemPrompt, userPrompt);
  const narration = (raw.narrationText || raw.fullScript || '').trim();
  const wordCount = narration.split(/\s+/).filter(Boolean).length;

  return {
    titleIdea: raw.titleIdea || params.topic,
    hook: raw.hook || '',
    narrationText: narration,
    fullScript: raw.fullScript || narration,
    ending: raw.ending || '',
    callToAction: raw.callToAction || '',
    wordCount,
  };
}

export async function generateSceneBreakdownWithAI(
  ai: AIProviderClient,
  params: {
    narrationText: string;
    topic: string;
    niche: string;
    language: string;
    durationSeconds: number;
    format: '9:16' | '16:9' | '1:1';
  }
): Promise<GeneratedScene[]> {
  const recommendedScenes = Math.max(4, Math.min(18, Math.round(params.durationSeconds / 4.5)));
  const lang = resolveLanguageMeta(params.language);

  const systemPrompt = `You are a documentary video director breaking a spoken narration script into tightly synchronized visual scenes for stock footage assembly (Pexels / Pixabay).
RULES:
1. VERBATIM NARRATION COVERAGE: Split narrationText sequentially from start to finish so concatenating all scenes[].narration reproduces 100% of narrationText in exact order without skipping, summarizing, or translating a single sentence.
2. SUBTITLE LANGUAGE: Both narration and subtitleText MUST stay strictly in ${lang.name} (matching narrationText verbatim).
3. FILMABLE ENGLISH VISUAL QUERIES: primaryKeyword and alternativeKeywords MUST be concise, concrete, literally filmable English stock-video queries (2-3 words) depicting the exact physical subject or action spoken in that scene (e.g. "smartphone screen hand", "server room glowing", "doctor examining xray", "rocket launch fire"). NEVER use abstract words like "facts", "secret", "future", "success", "concept", "motivation", or the full sentence.
4. DYNAMIC FOOTAGE: Prefer "video" for mediaTypePreference on almost all scenes so clips have natural motion without frozen frames.
Return strictly valid JSON.`;

  const userPrompt = JSON.stringify({
    topic: params.topic,
    niche: params.niche,
    narrationLanguageCode: lang.code,
    narrationLanguageName: lang.name,
    format: params.format,
    targetTotalDurationSeconds: params.durationSeconds,
    recommendedSceneCount: recommendedScenes,
    narrationText: params.narrationText,
    requiredJsonSchema: {
      scenes: [
        {
          sceneNumber: 1,
          narration: `exact verbatim segment from narrationText in ${lang.name}`,
          estimatedDuration: 4.5,
          visualDescription: 'concrete physical visual scene matching what is being said right now',
          primaryKeyword: 'concrete 2-3 word english stock footage query',
          alternativeKeywords: ['concrete english alt query 1', 'concrete english alt query 2'],
          mediaTypePreference: 'video',
          transition: 'fade',
          subtitleText: `exact verbatim subtitle text in ${lang.name} matching narration`,
        },
      ],
    },
  });

  const result = await ai.generateJson<{ scenes: GeneratedScene[] }>(systemPrompt, userPrompt);
  const scenes = Array.isArray(result.scenes) ? result.scenes : [];
  if (scenes.length === 0) {
    throw new Error('Scene breakdown produced zero scenes.');
  }
  return scenes.map((s, idx) => ({
    sceneNumber: idx + 1,
    narration: (s.narration || '').trim(),
    estimatedDuration: Math.max(2, Number(s.estimatedDuration || 4.5)),
    visualDescription: (s.visualDescription || params.topic).trim(),
    primaryKeyword: (s.primaryKeyword || params.niche).trim(),
    alternativeKeywords: Array.isArray(s.alternativeKeywords) ? s.alternativeKeywords : [],
    mediaTypePreference: s.mediaTypePreference === 'image' ? 'image' : 'video',
    transition: s.transition || 'fade',
    subtitleText: (s.subtitleText || s.narration || '').trim(),
  }));
}

export async function generateSeoMetadataWithAI(
  ai: AIProviderClient,
  params: {
    topic: string;
    niche: string;
    language: string;
    format: string;
    narrationText: string;
    references?: ResearchReference[];
  }
): Promise<GeneratedSeoMetadata> {
  const lang = resolveLanguageMeta(params.language);

  const systemPrompt = `You are a YouTube SEO specialist.
CRITICAL LANGUAGE RULE: ${lang.scriptInstruction} Write title, description, tags, and thumbnailHeadline strictly in ${lang.name} to match the video's spoken language.
Generate accurate, non-misleading metadata matching the actual video narration. Include 3-5 concise hashtags and a crisp 2-4 word thumbnail headline with high readability. Return strictly valid JSON.`;

  const userPrompt = JSON.stringify({
    topic: params.topic,
    niche: params.niche,
    targetLanguageCode: lang.code,
    targetLanguageName: lang.name,
    languageRequirement: lang.scriptInstruction,
    format: params.format,
    narrationSummary: params.narrationText.slice(0, 2000),
    references: params.references || [],
    requiredJsonSchema: {
      title: `string (<= 95 chars, compelling & accurate, in ${lang.name})`,
      description: `string (engaging description in ${lang.name} with key takeaways and references if provided)`,
      tags: ['tag1', 'tag2'],
      hashtags: ['#tag1', '#tag2'],
      categoryId: '27 (YouTube numeric category ID as string, e.g. 27 Education, 28 Science & Tech)',
      thumbnailHeadline: `string (2-4 bold words in ${lang.name})`,
      thumbnailVisualPrompt: 'string',
    },
  });

  const seo = await ai.generateJson<GeneratedSeoMetadata>(systemPrompt, userPrompt);
  return {
    title: (seo.title || params.topic).slice(0, 100),
    description: seo.description || params.topic,
    tags: Array.isArray(seo.tags) ? seo.tags.slice(0, 25) : [],
    hashtags: Array.isArray(seo.hashtags) ? seo.hashtags.slice(0, 8) : [],
    categoryId: /^\d+$/.test(String(seo.categoryId || '')) ? String(seo.categoryId) : '27',
    thumbnailHeadline: (seo.thumbnailHeadline || params.topic.split(' ').slice(0, 4).join(' ')).slice(0, 36),
    thumbnailVisualPrompt: seo.thumbnailVisualPrompt || params.topic,
  };
}
