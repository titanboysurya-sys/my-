import { sanitizeErrorMessage } from '../config/env.js';
import { getSupabaseAdmin } from '../db/supabase.js';
import { assertSafeExternalUrl } from '../security/urlGuard.js';
import {
  DEFAULT_GROQ_MODEL,
  GROQ_BASE_URL,
  resolveUserProviderKey,
} from './credentialService.js';
import {
  VIDEO_VISUAL_INSTRUCTIONS_END,
  VIDEO_VISUAL_INSTRUCTIONS_START,
  VOICEOVER_SCRIPT_END,
  VOICEOVER_SCRIPT_START,
  formatDelimitedScriptDocument,
  parseDelimitedScriptSections,
  sanitizeSpokenNarration,
} from './narrationSanitizer.js';
import {
  isModelRetiredOrUnsupportedError,
  markGeminiTextModelRetired,
  markGroqModelRetired,
  resolveActiveGeminiTextModels,
  resolveActiveGroqModels,
} from './modelResolver.js';

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
  visualInstructions?: string;
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
  private readonly preferredModel?: string;

  constructor(private readonly apiKey: string, model?: string) {
    const clean = (model || '').trim();
    this.preferredModel = clean && clean.toLowerCase() !== 'auto' ? clean : undefined;
  }

  async generateJson<T>(systemPrompt: string, userPrompt: string): Promise<T> {
    const candidates = (
      await resolveActiveGeminiTextModels(this.apiKey, this.preferredModel)
    ).slice(0, 4);
    const errors: string[] = [];
    let sawRateLimit = false;

    for (let i = 0; i < candidates.length; i++) {
      const model = candidates[i];
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        model
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

      if (res.ok) {
        const payload = (await res.json()) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        const rawText = payload.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!rawText) {
          errors.push(`${model}: empty response`);
          continue;
        }
        return parseJsonLoose<T>(rawText);
      }

      const errText = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 403) {
        throw new Error('Invalid Gemini API key. Update your key in API Settings.');
      }

      if (isModelRetiredOrUnsupportedError(res.status, errText)) {
        console.warn(
          `[AutoTube AI] Gemini model "${model}" retired/unsupported (${res.status}); auto-switching to next active model.`
        );
        markGeminiTextModelRetired(this.apiKey, model);
        errors.push(`${model}: retired/unsupported (${res.status})`);
        continue;
      }

      if (res.status === 429) {
        sawRateLimit = true;
        errors.push(`${model}: HTTP 429`);
        // Try another active Gemini model (e.g. flash-lite) before falling over to Groq
        if (i + 1 < candidates.length) {
          continue;
        }
        throw new Error('Gemini API quota or rate limit exceeded (HTTP 429).');
      }

      throw new Error(
        `Gemini request failed on ${model} (${res.status}): ${sanitizeErrorMessage(errText)}`
      );
    }

    if (sawRateLimit) {
      throw new Error('Gemini API quota or rate limit exceeded (HTTP 429).');
    }
    throw new Error(`Gemini request failed across active models (${errors.join('; ')})`);
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
  private readonly preference: string;

  constructor(private readonly apiKey: string, preference = DEFAULT_GROQ_MODEL) {
    this.preference = (preference || DEFAULT_GROQ_MODEL).trim();
  }

  private async requestGroqChat(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    useJsonObjectFormat: boolean
  ): Promise<Response> {
    const body: Record<string, unknown> = {
      model,
      temperature: 0.7,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    };
    if (useJsonObjectFormat) {
      body.response_format = { type: 'json_object' };
    }
    return fetch(`${GROQ_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });
  }

  async generateJson<T>(systemPrompt: string, userPrompt: string): Promise<T> {
    const ensuredSystem = /json/i.test(systemPrompt)
      ? systemPrompt
      : `${systemPrompt}\nReturn strictly valid JSON.`;
    const candidates = (await resolveActiveGroqModels(this.apiKey, this.preference)).slice(0, 5);
    const errors: string[] = [];
    let sawRateLimit = false;

    for (let i = 0; i < candidates.length; i++) {
      const model = candidates[i];
      let res = await this.requestGroqChat(model, ensuredSystem, userPrompt, true);

      // Some newly launched models occasionally reject strict response_format or fail json_validate_failed;
      // retry once without response_format and parse JSON cleanly before moving to the next model.
      if (res.status === 400) {
        const firstErr = await res.text().catch(() => '');
        if (isModelRetiredOrUnsupportedError(res.status, firstErr)) {
          console.warn(
            `[AutoTube AI] Groq model "${model}" retired/decommissioned; auto-switching to next active model.`
          );
          markGroqModelRetired(this.apiKey, model);
          errors.push(`${model}: retired (${res.status})`);
          continue;
        }
        if (/json_validate_failed|response_format/i.test(firstErr)) {
          res = await this.requestGroqChat(model, ensuredSystem, userPrompt, false);
        } else {
          errors.push(`${model}: HTTP 400 (${sanitizeErrorMessage(firstErr)})`);
          continue;
        }
      }

      if (res.ok) {
        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const rawText = data.choices?.[0]?.message?.content;
        if (!rawText) {
          errors.push(`${model}: empty completion`);
          continue;
        }
        try {
          return parseJsonLoose<T>(rawText);
        } catch {
          errors.push(`${model}: malformed JSON output`);
          continue;
        }
      }

      if (res.status === 401 || res.status === 403) {
        throw new Error('Invalid Groq API key. Update your key in API Settings.');
      }

      const errText = await res.text().catch(() => '');
      if (isModelRetiredOrUnsupportedError(res.status, errText)) {
        console.warn(
          `[AutoTube AI] Groq model "${model}" retired/unavailable (${res.status}); auto-switching to next active model.`
        );
        markGroqModelRetired(this.apiKey, model);
        errors.push(`${model}: retired (${res.status})`);
        continue;
      }

      if (res.status === 429) {
        sawRateLimit = true;
        errors.push(`${model}: HTTP 429`);
        if (i + 1 < candidates.length) {
          continue;
        }
        throw new Error('Groq API quota or rate limit exceeded (HTTP 429).');
      }

      errors.push(`${model}: HTTP ${res.status} (${sanitizeErrorMessage(errText)})`);
      if (i + 1 < candidates.length) {
        continue;
      }
      throw new Error(`Groq request failed (${res.status}): ${sanitizeErrorMessage(errText)}`);
    }

    if (sawRateLimit) {
      throw new Error('Groq API quota or rate limit exceeded (HTTP 429).');
    }
    throw new Error(`Groq request failed across active models (${errors.join('; ')})`);
  }
}

export function isFailoverEligibleError(err: unknown): boolean {
  const msg = sanitizeErrorMessage(err).toLowerCase();
  return (
    msg.includes('429') ||
    msg.includes('quota') ||
    msg.includes('rate limit') ||
    msg.includes('resource_exhausted') ||
    msg.includes('retired') ||
    msg.includes('decommission') ||
    msg.includes('deprecated') ||
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
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1)) as T;
    }
    throw new Error('Could not parse JSON from model response.');
  }
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
          typeof cred.providerConfig.model === 'string' ? cred.providerConfig.model : undefined
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
    hookStyle?: 'viral_retention' | 'story_arc' | 'standard';
    references?: ResearchReference[];
  }
): Promise<GeneratedScript> {
  const words = targetWordRangeForDuration(params.durationSeconds);
  const lang = resolveLanguageMeta(params.language);
  const hookStyle = params.hookStyle || 'viral_retention';
  const isShortForm = params.durationSeconds <= 95;

  const retentionRules =
    hookStyle === 'viral_retention'
      ? `VIRAL RETENTION ARCHITECTURE (MANDATORY):
- 0-1.5s SCROLL-STOPPER HOOK: Sentence #1 MUST be 4-10 crisp words dropping straight into conflict, a shocking verifiable contrast, or a vivid physical moment. STRICTLY FORBIDDEN openers: "Did you know", "Have you ever wondered", "In today's world", "Imagine if", "Let's dive in", "क्या आप जानते हैं", "आज हम बात करेंगे", "तो चलिए शुरू करते हैं".
- MICRO-RE-HOOKS EVERY 5-7 SECONDS: Every 2 sentences, pivot with tension/contrast ("लेकिन असली मोड़ तब आया", "मगर सच इसके उलट था", "तभी एक गलती ने सब बदल दिया", "But here is the catch", "Until one number changed everything") so viewers never swipe away.
- SHOW DON'T TELL (VISUAL-FIRST WRITING): Every single sentence MUST contain concrete physical subjects, actions, numbers, places, or emotions that can be literally shown on screen in 1-2 seconds — ZERO vague abstract lecturing.
- PUNCHY SPOKEN RHYTHM: Average 5-11 words per sentence. Conversational, natural human voice in ${lang.name} (never stiff textbook translation).${
          isShortForm
            ? `\n- SEAMLESS LOOP PAYOFF: Deliver a sharp final twist whose last words flow naturally back into the first word of the hook for effortless replay.`
            : ''
        }`
      : hookStyle === 'story_arc'
        ? `STORYTELLING ARC: Open right inside the tense turning point (no slow intro), build escalating stakes with vivid sensory details every 5 seconds, hit an unforgettable climax reveal, and close cleanly.`
        : `Write crisp, concrete, engaging spoken narration with zero fluff and vivid visual nouns in every line.`;

  const systemPrompt = `You are a top 1% YouTube retention scriptwriter and visual director whose videos achieve >85% average view duration.
CRITICAL LANGUAGE RULE: ${lang.scriptInstruction} All spoken fields (titleIdea, hook, voiceoverScript, narrationText, ending, callToAction) MUST be written in ${lang.name}. NEVER default to English if the requested language is ${lang.name}.

STRICT TWO-SECTION SEPARATION RULE (MANDATORY):
You MUST explicitly separate "Video Visual Instructions" from "Voiceover Script" using the exact delimiters below so our automated pipeline can parse them independently and NEVER send visual instructions to the Text-to-Speech audio engine:
1. Video Visual Instructions Section (${VIDEO_VISUAL_INSTRUCTIONS_START} ... ${VIDEO_VISUAL_INSTRUCTIONS_END}):
   - Contains ALL shot lists, B-roll footage ideas, camera moves (zoom/pan/cuts), SFX/music cues, timestamps, and on-screen text graphics.
   - This section is NEVER spoken aloud.
2. Voiceover Script Section (${VOICEOVER_SCRIPT_START} ... ${VOICEOVER_SCRIPT_END}):
   - Contains ONLY the pure spoken words that the voice actor will read verbatim into the microphone in ${lang.name}.
   - ZERO visual cues, ZERO camera directions, ZERO [brackets], ZERO (parenthetical stage directions), ZERO *actions*, ZERO SFX tags, ZERO timestamps, and ZERO speaker labels like "Narrator:".
${retentionRules}
Match Voiceover Script spoken word count strictly to ${words.min}-${words.max} words. Do not fabricate facts. Return strictly valid JSON.`;

  const userPrompt = JSON.stringify({
    topic: params.topic,
    niche: params.niche,
    targetLanguageCode: lang.code,
    targetLanguageName: lang.name,
    languageRequirement: lang.scriptInstruction,
    contentStyle: params.contentStyle,
    hookStyle,
    tone: params.tone || 'high-energy engaging',
    durationSeconds: params.durationSeconds,
    targetWordRange: words,
    verifiedReferences: params.references || [],
    sectionDelimiters: {
      videoVisualInstructionsStart: VIDEO_VISUAL_INSTRUCTIONS_START,
      videoVisualInstructionsEnd: VIDEO_VISUAL_INSTRUCTIONS_END,
      voiceoverScriptStart: VOICEOVER_SCRIPT_START,
      voiceoverScriptEnd: VOICEOVER_SCRIPT_END,
    },
    requiredJsonSchema: {
      titleIdea: `string (in ${lang.name})`,
      hook: `string (first 1.5 seconds ultra-punchy spoken hook ONLY, pure speech, no brackets/visual notes, in ${lang.name})`,
      videoVisualInstructions: `string (MUST begin with "${VIDEO_VISUAL_INSTRUCTIONS_START}" and end with "${VIDEO_VISUAL_INSTRUCTIONS_END}"; put ALL scene-by-scene shot cues, camera movements, B-roll ideas, SFX, and overlays ONLY here)`,
      voiceoverScript: `string (MUST begin with "${VOICEOVER_SCRIPT_START}" and end with "${VOICEOVER_SCRIPT_END}"; 100% pure spoken words ONLY in ${lang.name}; ZERO visual instructions, ZERO brackets [], ZERO parentheses (), ZERO labels)`,
      narrationText: `string (exact same pure spoken words as inside voiceoverScript without delimiters, in ${lang.name})`,
      fullScript: `string (production sheet containing BOTH "${VIDEO_VISUAL_INSTRUCTIONS_START}\\n...\\n${VIDEO_VISUAL_INSTRUCTIONS_END}\\n\\n${VOICEOVER_SCRIPT_START}\\n...\\n${VOICEOVER_SCRIPT_END}")`,
      ending: `string (pure spoken closing line in ${lang.name})`,
      callToAction: `string (brief 4-7 word pure spoken CTA in ${lang.name})`,
    },
  });

  const raw = await ai.generateJson<
    Omit<GeneratedScript, 'wordCount'> & {
      voiceoverScript?: string;
      videoVisualInstructions?: string;
    }
  >(systemPrompt, userPrompt);

  // Independently parse each section using explicit delimiters so visual instructions never leak into TTS audio
  const parsedFromFull = parseDelimitedScriptSections(raw.fullScript || '');
  const parsedFromVoiceover = parseDelimitedScriptSections(raw.voiceoverScript || '');
  const parsedFromNarration = parseDelimitedScriptSections(raw.narrationText || '');
  const parsedFromVisualField = parseDelimitedScriptSections(
    raw.videoVisualInstructions
      ? `${VIDEO_VISUAL_INSTRUCTIONS_START}\n${raw.videoVisualInstructions}\n${VIDEO_VISUAL_INSTRUCTIONS_END}`
      : ''
  );

  const visualInstructions =
    parsedFromVisualField.videoVisualInstructions ||
    parsedFromFull.videoVisualInstructions ||
    parsedFromVoiceover.videoVisualInstructions ||
    parsedFromNarration.videoVisualInstructions ||
    '';

  const narration =
    (parsedFromVoiceover.hasExplicitDelimiters && parsedFromVoiceover.voiceoverScript) ||
    (parsedFromFull.hasExplicitDelimiters && parsedFromFull.voiceoverScript) ||
    parsedFromVoiceover.voiceoverScript ||
    parsedFromNarration.voiceoverScript ||
    parsedFromFull.voiceoverScript ||
    '';

  const cleanHook = sanitizeSpokenNarration(raw.hook || '');
  const cleanEnding = sanitizeSpokenNarration(raw.ending || '');
  const wordCount = narration.split(/\s+/).filter(Boolean).length;

  return {
    titleIdea: (raw.titleIdea || params.topic).trim(),
    hook: cleanHook,
    narrationText: narration,
    fullScript: formatDelimitedScriptDocument(narration, visualInstructions),
    visualInstructions,
    ending: cleanEnding,
    callToAction: sanitizeSpokenNarration(raw.callToAction || ''),
    wordCount,
  };
}

/**
 * Deterministic post-breakdown pacing guard: guarantees no scene sits on a static shot for 5-8s
 * when rapid 1-2s micro-beats are requested. Splits overly long multi-clause scenes cleanly at
 * punctuation or word boundaries while varying search keywords so every cut gets a fresh visual.
 */
export function enforceMicroBeatScenePacing(
  scenes: GeneratedScene[],
  pace: 'viral_fast' | 'balanced' | 'cinematic',
  maxTotalScenes = 45
): GeneratedScene[] {
  if (scenes.length === 0) return [];
  const maxWordsPerBeat = pace === 'viral_fast' ? 8 : pace === 'balanced' ? 12 : 18;
  const minSubBeatWords = 3;
  const out: GeneratedScene[] = [];

  for (const scene of scenes) {
    const cleanNar = sanitizeSpokenNarration(scene.narration || scene.subtitleText || '');
    const words = cleanNar.split(/\s+/).filter(Boolean);

    if (words.length <= maxWordsPerBeat || out.length >= maxTotalScenes - 1) {
      out.push({
        ...scene,
        narration: cleanNar,
        subtitleText: sanitizeSpokenNarration(scene.subtitleText || '') || cleanNar,
      });
      continue;
    }

    // First try splitting along natural clause punctuation (., !, ?, ;, :, ।, ,)
    const rawClauses = cleanNar
      .split(/(?<=[.!?।,;:])\s+/)
      .map((c) => c.trim())
      .filter(Boolean);

    const chunks: string[] = [];
    if (rawClauses.length >= 2) {
      let acc: string[] = [];
      for (const clause of rawClauses) {
        const cWords = clause.split(/\s+/).filter(Boolean);
        if (acc.length > 0 && acc.length + cWords.length > maxWordsPerBeat) {
          chunks.push(acc.join(' '));
          acc = [...cWords];
        } else {
          acc.push(...cWords);
        }
      }
      if (acc.length > 0) {
        if (acc.length < minSubBeatWords && chunks.length > 0) {
          chunks[chunks.length - 1] = `${chunks[chunks.length - 1]} ${acc.join(' ')}`;
        } else {
          chunks.push(acc.join(' '));
        }
      }
    }

    // If still too long (single long sentence), split evenly into balanced micro-beats
    const finalChunks: string[] = [];
    for (const chunk of chunks.length > 0 ? chunks : [cleanNar]) {
      const cWords = chunk.split(/\s+/).filter(Boolean);
      if (cWords.length <= maxWordsPerBeat) {
        finalChunks.push(chunk);
        continue;
      }
      const numParts = Math.min(4, Math.max(2, Math.ceil(cWords.length / maxWordsPerBeat)));
      const step = Math.ceil(cWords.length / numParts);
      for (let i = 0; i < cWords.length; i += step) {
        const slice = cWords.slice(i, i + step);
        if (slice.length < minSubBeatWords && finalChunks.length > 0) {
          finalChunks[finalChunks.length - 1] = `${finalChunks[finalChunks.length - 1]} ${slice.join(' ')}`;
        } else {
          finalChunks.push(slice.join(' '));
        }
      }
    }

    const totalSubDur = Math.max(1.0 * finalChunks.length, scene.estimatedDuration);
    const totalWords = Math.max(1, words.length);
    const alts = [scene.primaryKeyword, ...(scene.alternativeKeywords || [])].filter(Boolean);

    finalChunks.forEach((subText, subIdx) => {
      if (out.length >= maxTotalScenes) return;
      const subWords = subText.split(/\s+/).filter(Boolean).length;
      const rotatedPrimary = alts[subIdx % Math.max(1, alts.length)] || scene.primaryKeyword;
      const rotatedAlts = alts.filter((k) => k !== rotatedPrimary);
      out.push({
        sceneNumber: out.length + 1,
        narration: subText,
        estimatedDuration: Math.max(1.0, Math.round(((subWords / totalWords) * totalSubDur) * 10) / 10),
        visualDescription: scene.visualDescription,
        primaryKeyword: rotatedPrimary,
        alternativeKeywords: rotatedAlts,
        mediaTypePreference: scene.mediaTypePreference,
        transition: subIdx === 0 ? scene.transition : subIdx % 2 === 1 ? 'cut' : 'punch',
        subtitleText: subText,
      });
    });
  }

  return out.map((s, idx) => ({ ...s, sceneNumber: idx + 1 }));
}

export async function generateSceneBreakdownWithAI(
  ai: AIProviderClient,
  params: {
    narrationText: string;
    visualInstructions?: string;
    topic: string;
    niche: string;
    language: string;
    durationSeconds: number;
    format: '9:16' | '16:9' | '1:1';
    editingPace?: 'viral_fast' | 'balanced' | 'cinematic';
  }
): Promise<GeneratedScene[]> {
  const parsedVoiceover = parseDelimitedScriptSections(params.narrationText);
  const cleanScript =
    parsedVoiceover.voiceoverScript || sanitizeSpokenNarration(params.narrationText) || params.narrationText;
  const visualContext =
    (params.visualInstructions || '').trim() || parsedVoiceover.videoVisualInstructions;

  const pace = params.editingPace || (params.format === '9:16' ? 'viral_fast' : 'balanced');
  const secPerScene = pace === 'viral_fast' ? 1.65 : pace === 'cinematic' ? 3.4 : 2.3;
  const targetWordsPerBeat = pace === 'viral_fast' ? 5 : pace === 'cinematic' ? 10 : 7;
  const minScenes = 3;
  const maxScenes = pace === 'viral_fast' ? 45 : pace === 'balanced' ? 32 : 24;

  const spokenWordsCount = cleanScript.split(/\s+/).filter(Boolean).length;
  const estDurationFromWords = spokenWordsCount > 0 ? spokenWordsCount / 2.35 : params.durationSeconds;
  const effectiveDuration = Math.max(8, spokenWordsCount >= 12 ? estDurationFromWords : params.durationSeconds);

  const byWords = spokenWordsCount >= 12 ? Math.round(spokenWordsCount / targetWordsPerBeat) : 0;
  const byDuration = Math.round(effectiveDuration / secPerScene);
  const recommendedScenes = Math.max(
    minScenes,
    Math.min(maxScenes, byWords > 0 ? Math.max(byWords, Math.min(maxScenes, byDuration)) : byDuration)
  );
  const lang = resolveLanguageMeta(params.language);

  const systemPrompt = `You are a precision documentary & YouTube Shorts video editor breaking a pure Voiceover Script into rapid, tightly synchronized 1-2 second micro-scenes where EVERY SINGLE CUT literally depicts the exact phrase/words spoken at that exact moment.
RULES:
1. VERBATIM 1:1 WORD-FOR-WORD COVERAGE: Split voiceoverScript sequentially from start to finish into ~${recommendedScenes} rapid micro-beats (~${secPerScene.toFixed(1)}s and ~${targetWordsPerBeat} words each; NEVER lump long multi-sentence paragraphs into one scene!) so concatenating all scenes[].narration reproduces 100% of voiceoverScript in exact chronological order without skipping, summarizing, adding, or translating a single word.
2. SPOKEN-ONLY SUBTITLES: Both scenes[].narration and scenes[].subtitleText MUST contain ONLY the exact spoken words from voiceoverScript in ${lang.name} — NEVER copy anything from videoVisualInstructionsContext, [Scene], [Visual], camera notes, or labels into narration or subtitleText.
3. MICRO-BEAT LITERAL VISUAL QUERIES (SENTENCE-BY-SENTENCE & WORD-BY-WORD MATCH):
   - Every single scene's visualDescription, primaryKeyword (2-4 concrete English words), and alternativeKeywords MUST depict the SPECIFIC literal subject, person, animal, object, number, or action spoken inside THAT exact 1-2 second beat — NEVER repeat the same generic query across consecutive scenes!
   - If the narration is in Hindi, Hinglish, or another non-English language, accurately translate the literal subject and action of THAT beat into clear English for visualDescription, primaryKeyword, and alternativeKeywords.
   - NEVER search abstract nouns or literalized metaphors/idioms (e.g. NEVER search "storm", "time bomb", "secret", "danger", "facts", "future", "success", "concept", "motivation", "problem" unless the narrator is literally talking about weather or explosives!). Instead depict the real concrete scene (e.g. for "Nvidia credit rating crisis", use "nvidia microchip circuit board", "stock market red chart", "corporate skyscraper finance").
4. SMART MEDIA TYPE ROUTING:
   - Use mediaTypePreference: "image" whenever the beat mentions a SPECIFIC named real-world person, CEO, politician, company, brand, logo, landmark, historical figure/artifact (e.g. "Jensen Huang", "Nvidia", "Taj Mahal", "Albert Einstein") OR a cartoon / animated / fictional storybook character — so real Wikimedia/Openverse photos or Lexica/AI Horde illustrations match accurately.
   - Use mediaTypePreference: "video" for concrete filmable stock actions and real-world scenes (e.g. "engineer soldering microchip", "stock ticker red screen", "doctor examining xray", "rocket launch pad fire").
   - Use snappy transitions from ["punch", "flash", "cut", "slide", "zoom"].
Return strictly valid JSON.`;

  const userPrompt = JSON.stringify({
    topic: params.topic,
    niche: params.niche,
    narrationLanguageCode: lang.code,
    narrationLanguageName: lang.name,
    format: params.format,
    editingPace: pace,
    targetTotalDurationSeconds: Math.round(effectiveDuration),
    spokenWordCount: spokenWordsCount,
    recommendedSceneCount: recommendedScenes,
    maxWordsPerSceneBeat: pace === 'viral_fast' ? 8 : pace === 'balanced' ? 12 : 16,
    voiceoverScript: cleanScript,
    videoVisualInstructionsContext: visualContext || undefined,
    requiredJsonSchema: {
      scenes: [
        {
          sceneNumber: 1,
          narration: `exact verbatim short spoken beat (${targetWordsPerBeat} words) from voiceoverScript in ${lang.name} (NEVER visual cues)`,
          estimatedDuration: secPerScene,
          visualDescription: 'concrete literal physical visual scene depicting the exact words spoken in this 1-2s beat (in English)',
          primaryKeyword: 'concrete 2-4 word english visual search query specific to this beat',
          alternativeKeywords: ['concrete english alt query 1', 'concrete english alt query 2'],
          mediaTypePreference: 'video or image (image for named people/brands/landmarks/cartoons)',
          transition: 'punch',
          subtitleText: `exact verbatim spoken words in ${lang.name} matching narration`,
        },
      ],
    },
  });

  const result = await ai.generateJson<{ scenes: GeneratedScene[] }>(systemPrompt, userPrompt);
  const rawScenes = Array.isArray(result.scenes) ? result.scenes : [];
  if (rawScenes.length === 0) {
    throw new Error('Scene breakdown produced zero scenes.');
  }
  const normalized = rawScenes.map((s, idx) => {
    const cleanNar = sanitizeSpokenNarration(s.narration || '');
    const cleanSub = sanitizeSpokenNarration(s.subtitleText || '') || cleanNar;
    return {
      sceneNumber: idx + 1,
      narration: cleanNar,
      estimatedDuration: Math.max(1.0, Number(s.estimatedDuration || secPerScene)),
      visualDescription: (s.visualDescription || params.topic).trim(),
      primaryKeyword: (s.primaryKeyword || params.niche).trim(),
      alternativeKeywords: Array.isArray(s.alternativeKeywords) ? s.alternativeKeywords : [],
      mediaTypePreference: s.mediaTypePreference === 'image' ? 'image' : 'video',
      transition: s.transition || (idx === 0 ? 'punch' : 'cut'),
      subtitleText: cleanSub,
    } satisfies GeneratedScene;
  });

  return enforceMicroBeatScenePacing(normalized, pace, maxScenes);
}

export interface SceneVisualCandidateSummary {
  idx: number;
  mediaType: 'video' | 'image';
  provider: string;
  description: string;
  lexicalScore: number;
}

export interface SceneVisualVerificationDecision {
  sceneNumber: number;
  selectedIdx: number | null;
  confidence: number;
  refinedQuery?: string;
  imagePrompt?: string;
}

/**
 * Single-call batch semantic verifier that checks every scene's candidate visuals against the
 * EXACT spoken voiceover beat. Rejects generic/off-topic stock clips (e.g. random people, dust,
 * homonyms) and supplies a refined search query + concrete image generation prompt when needed.
 */
export async function verifySceneVisualMatchesWithAI(
  ai: AIProviderClient,
  params: {
    topic: string;
    niche: string;
    isCartoon: boolean;
    scenes: Array<{
      sceneNumber: number;
      narration: string;
      visualDescription: string;
      primaryKeyword: string;
      candidates: SceneVisualCandidateSummary[];
    }>;
  }
): Promise<Map<number, SceneVisualVerificationDecision>> {
  const decisions = new Map<number, SceneVisualVerificationDecision>();
  if (params.scenes.length === 0) return decisions;

  const systemPrompt = `You are a strict visual continuity director verifying that EVERY video scene's visual literally matches the exact spoken voiceover narration for that beat.
RULES:
1. For each scene, read its spoken "narration" (may be English, Hindi, or Hinglish), its "visualDescription", and its candidate list.
2. Pick "selectedIdx" ONLY if that candidate genuinely and unmistakably depicts the literal subject/action of THAT spoken beat.
3. REJECT generic filler or mismatches (e.g. random man walking stairs, close-up eye, abstract dust particles, unrelated studio anchors, or homonyms like "Fox News studio" when narration is about a forest fox).
4. Give an honest "confidence" score (0-100):
   - 75-100: Direct literal match to what is being spoken.
   - 55-74: Clear topical match that fits naturally on screen.
   - 0-54: Mismatch, vague filler, or wrong subject -> MUST set "selectedIdx": null.
5. Whenever "selectedIdx" is null (or confidence < 60), provide:
   - "refinedQuery": a sharper 2-4 word concrete English search query (no metaphors, no stop words).
   - "imagePrompt": a vivid 10-18 word concrete English visual prompt describing the exact subject, action, setting, and lighting for AI image generation${params.isCartoon ? ' (in colorful 3D cartoon style)' : ''}.
Return strictly valid JSON.`;

  const userPrompt = JSON.stringify({
    topic: params.topic,
    niche: params.niche,
    isCartoon: params.isCartoon,
    scenes: params.scenes.map((s) => ({
      sceneNumber: s.sceneNumber,
      narration: s.narration.slice(0, 220),
      visualDescription: s.visualDescription.slice(0, 180),
      primaryKeyword: s.primaryKeyword,
      candidates: s.candidates.map((c) => ({
        idx: c.idx,
        mediaType: c.mediaType,
        provider: c.provider,
        description: c.description.slice(0, 160),
        lexicalScore: c.lexicalScore,
      })),
    })),
    requiredJsonSchema: {
      decisions: [
        {
          sceneNumber: 1,
          selectedIdx: 0,
          confidence: 88,
          refinedQuery: 'optional 2-4 word concrete english query if selectedIdx is null',
          imagePrompt: 'optional 10-18 word vivid literal visual prompt if selectedIdx is null',
        },
      ],
    },
  });

  try {
    const raw = await ai.generateJson<{
      decisions?: Array<{
        sceneNumber?: number;
        selectedIdx?: number | null;
        confidence?: number;
        refinedQuery?: string;
        imagePrompt?: string;
      }>;
    }>(systemPrompt, userPrompt);

    const validSceneMap = new Map(params.scenes.map((s) => [s.sceneNumber, s]));
    for (const item of raw.decisions || []) {
      const sn = Number(item.sceneNumber);
      const scene = validSceneMap.get(sn);
      if (!scene) continue;

      const rawIdx = item.selectedIdx;
      const validIdx =
        typeof rawIdx === 'number' &&
        Number.isInteger(rawIdx) &&
        scene.candidates.some((c) => c.idx === rawIdx)
          ? rawIdx
          : null;
      const conf = Math.max(0, Math.min(100, Math.round(Number(item.confidence ?? (validIdx !== null ? 70 : 20)))));
      decisions.set(sn, {
        sceneNumber: sn,
        selectedIdx: conf >= 55 ? validIdx : null,
        confidence: conf,
        refinedQuery: typeof item.refinedQuery === 'string' && item.refinedQuery.trim()
          ? item.refinedQuery.trim().slice(0, 80)
          : undefined,
        imagePrompt: typeof item.imagePrompt === 'string' && item.imagePrompt.trim()
          ? item.imagePrompt.trim().slice(0, 240)
          : undefined,
      });
    }
  } catch (err) {
    console.warn(
      `[AutoTube AI] Batch visual verification skipped (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  return decisions;
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

  const systemPrompt = `You are a YouTube CTR & SEO growth strategist.
CRITICAL LANGUAGE RULE: ${lang.scriptInstruction} Write title, description, tags, and thumbnailHeadline strictly in ${lang.name} to match the video's spoken language.
Generate high-CTR, accurate, curiosity-driven metadata matching the actual video narration. Include 3-5 concise hashtags and a punchy 2-4 word high-contrast thumbnailHeadline (curiosity/shock trigger). Return strictly valid JSON.`;

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
