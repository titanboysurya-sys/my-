import { sanitizeErrorMessage } from '../config/env.js';
import { assertSafeExternalUrl } from '../security/urlGuard.js';
import { resolveUserProviderKey } from './credentialService.js';

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

export function parseJsonLoose<T>(text: string): T {
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '');
  return JSON.parse(cleaned) as T;
}

export async function createAIProviderForUser(
  userId: string,
  preferred: 'gemini' | 'openai_compatible' = 'gemini'
): Promise<AIProviderClient> {
  const primary = await resolveUserProviderKey(userId, preferred);
  if (primary) {
    if (preferred === 'openai_compatible') {
      return new OpenAICompatibleProvider(
        primary.apiKey,
        String(primary.providerConfig.base_url || 'https://api.openai.com/v1'),
        String(primary.providerConfig.model || 'gpt-4o-mini')
      );
    }
    return new GeminiAIProvider(
      primary.apiKey,
      String(primary.providerConfig.model || 'gemini-2.5-flash')
    );
  }

  // Fallback to alternate configured provider
  const alt = preferred === 'gemini' ? 'openai_compatible' : 'gemini';
  const secondary = await resolveUserProviderKey(userId, alt);
  if (secondary) {
    if (alt === 'openai_compatible') {
      return new OpenAICompatibleProvider(secondary.apiKey);
    }
    return new GeminiAIProvider(secondary.apiKey);
  }

  throw new Error(
    'No AI provider key configured. Add your Gemini API key in Settings -> AI Providers & API Keys.'
  );
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
  const rssItems =
    input.topicType === 'news' || input.topicType === 'trending' || input.niche === 'AI News'
      ? await fetchVerifiedRssItems(input.niche, 8)
      : [];

  const systemPrompt = `You are a factual YouTube content strategist. Never invent breaking news, statistics, or dates. When source headlines are supplied, base news topics strictly on those verified sources and include their exact URLs and publication dates. Return strictly valid JSON.`;

  const userPrompt = JSON.stringify({
    task: 'Suggest high-retention YouTube video topics',
    niche: input.niche,
    language: input.language,
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
          topic: 'string',
          angle: 'string',
          whyNow: 'string',
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

  const systemPrompt = `You are an elite YouTube scriptwriter. Write original, natural, punchy spoken narration in the requested language with zero filler greetings ("Hey guys welcome back"). Match the spoken word count strictly to the target duration (${words.min}-${words.max} spoken words). Do not fabricate facts. Return strictly valid JSON.`;

  const userPrompt = JSON.stringify({
    topic: params.topic,
    niche: params.niche,
    language: params.language,
    contentStyle: params.contentStyle,
    tone: params.tone || 'engaging',
    durationSeconds: params.durationSeconds,
    targetWordRange: words,
    verifiedReferences: params.references || [],
    requiredJsonSchema: {
      titleIdea: 'string',
      hook: 'string (first 3 seconds spoken hook)',
      narrationText: 'string (complete spoken narration from hook to ending, ready for TTS)',
      fullScript: 'string (formatted script with section markers)',
      ending: 'string',
      callToAction: 'string',
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
  const recommendedScenes = Math.max(4, Math.min(18, Math.round(params.durationSeconds / 5)));

  const systemPrompt = `You are a documentary video director breaking a narration script into visual scenes for stock footage assembly (Pexels / Pixabay). Every scene's search keywords MUST be concise English visual search queries (2-4 words) that return high-relevance real stock footage, regardless of the narration language. Return strictly valid JSON.`;

  const userPrompt = JSON.stringify({
    topic: params.topic,
    niche: params.niche,
    narrationLanguage: params.language,
    format: params.format,
    targetTotalDurationSeconds: params.durationSeconds,
    recommendedSceneCount: recommendedScenes,
    narrationText: params.narrationText,
    requiredJsonSchema: {
      scenes: [
        {
          sceneNumber: 1,
          narration: 'exact narration segment in original language',
          estimatedDuration: 5.5,
          visualDescription: 'detailed visual description',
          primaryKeyword: 'english stock footage query',
          alternativeKeywords: ['english alt query 1', 'english alt query 2'],
          mediaTypePreference: 'video',
          transition: 'fade',
          subtitleText: 'clean subtitle text matching narration segment',
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
    estimatedDuration: Math.max(2, Number(s.estimatedDuration || 5)),
    visualDescription: (s.visualDescription || params.topic).trim(),
    primaryKeyword: (s.primaryKeyword || params.topic).trim(),
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
  const systemPrompt = `You are a YouTube SEO specialist. Generate accurate, non-misleading metadata matching the actual video narration. Include 3-5 concise hashtags and a crisp 2-4 word thumbnail headline with high readability. Return strictly valid JSON.`;

  const userPrompt = JSON.stringify({
    topic: params.topic,
    niche: params.niche,
    language: params.language,
    format: params.format,
    narrationSummary: params.narrationText.slice(0, 2000),
    references: params.references || [],
    requiredJsonSchema: {
      title: 'string (<= 95 chars, compelling & accurate)',
      description: 'string (engaging description with key takeaways and references if provided)',
      tags: ['tag1', 'tag2'],
      hashtags: ['#tag1', '#tag2'],
      categoryId: '27 (YouTube numeric category ID as string, e.g. 27 Education, 28 Science & Tech)',
      thumbnailHeadline: 'string (2-4 bold words)',
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
