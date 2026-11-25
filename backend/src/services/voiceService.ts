import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import { config, sanitizeErrorMessage } from '../config/env.js';
import { uploadToStorageWithAutoBucket } from '../db/supabase.js';
import { resolveConfinedPath } from '../security/urlGuard.js';
import { resolveLanguageMeta } from './aiProvider.js';
import { resolveUserProviderKey } from './credentialService.js';
import {
  isModelRetiredOrUnsupportedError,
  markGeminiTtsModelRetired,
  resolveActiveGeminiTtsModels,
} from './modelResolver.js';

const execFileAsync = promisify(execFile);

export type VoiceProviderName = 'gemini_tts' | 'elevenlabs';

export interface StudioVoiceProfile {
  id: string;
  displayName: string;
  label: string;
  gender: 'male' | 'female';
  tone: string;
  style: string;
  geminiVoiceName: string;
  elevenLabsVoiceId: string;
}

/**
 * Full 30-voice official Gemini TTS prebuilt catalog (16 Male + 14 Female) mapped to
 * distinct ElevenLabs premade voice IDs so every voice works seamlessly on both providers.
 */
export const STUDIO_VOICE_CATALOG: StudioVoiceProfile[] = [
  // --- MALE VOICES (16) ---
  {
    id: 'Charon',
    displayName: 'Charon',
    label: 'Charon (Male • Informative Documentary)',
    gender: 'male',
    tone: 'Informative & Deep Documentary',
    style: 'deep authoritative informative documentary narration',
    geminiVoiceName: 'Charon',
    elevenLabsVoiceId: 'pNInz6obpgDQGcFmaJgB', // Adam
  },
  {
    id: 'Fenrir',
    displayName: 'Fenrir',
    label: 'Fenrir (Male • Excitable Viral Energy)',
    gender: 'male',
    tone: 'Excitable & High Energy',
    style: 'energetic excitable punchy high-retention storytelling',
    geminiVoiceName: 'Fenrir',
    elevenLabsVoiceId: 'TxGEqnHWrfWFTfGW9XjX', // Josh
  },
  {
    id: 'Puck',
    displayName: 'Puck',
    label: 'Puck (Male • Upbeat & Viral)',
    gender: 'male',
    tone: 'Upbeat & Conversational',
    style: 'friendly upbeat lively conversational storytelling',
    geminiVoiceName: 'Puck',
    elevenLabsVoiceId: 'ErXwobaYiN019PkySvjV', // Antoni
  },
  {
    id: 'Orus',
    displayName: 'Orus',
    label: 'Orus (Male • Firm News Anchor)',
    gender: 'male',
    tone: 'Firm & Crisp Broadcast',
    style: 'clear firm confident broadcast news anchor delivery',
    geminiVoiceName: 'Orus',
    elevenLabsVoiceId: 'VR6AewLTigWG4xSOukaG', // Arnold
  },
  {
    id: 'Enceladus',
    displayName: 'Enceladus',
    label: 'Enceladus (Male • Breathy Cinematic)',
    gender: 'male',
    tone: 'Breathy & Cinematic',
    style: 'cinematic breathy atmospheric dramatic narration',
    geminiVoiceName: 'Enceladus',
    elevenLabsVoiceId: 'yoZ06aMxZJJ28mfd3POQ', // Sam
  },
  {
    id: 'Iapetus',
    displayName: 'Iapetus',
    label: 'Iapetus (Male • Clear Educator)',
    gender: 'male',
    tone: 'Clear & Articulated',
    style: 'clear well-paced educational explainer narration',
    geminiVoiceName: 'Iapetus',
    elevenLabsVoiceId: 'onwK4e9ZLuTAKqWW03F9', // Daniel
  },
  {
    id: 'Umbriel',
    displayName: 'Umbriel',
    label: 'Umbriel (Male • Easy-Going Calm)',
    gender: 'male',
    tone: 'Easy-Going & Calm',
    style: 'relaxed calm easy-going thoughtful storytelling',
    geminiVoiceName: 'Umbriel',
    elevenLabsVoiceId: 'N2lVS1w4EtoT3dr4eOWO', // Callum
  },
  {
    id: 'Algieba',
    displayName: 'Algieba',
    label: 'Algieba (Male • Smooth & Polished)',
    gender: 'male',
    tone: 'Smooth & Studio Polished',
    style: 'smooth velvety studio commercial narration',
    geminiVoiceName: 'Algieba',
    elevenLabsVoiceId: 'pqHfZKP75CvOlQylNhV4', // Bill
  },
  {
    id: 'Algenib',
    displayName: 'Algenib',
    label: 'Algenib (Male • Gravelly Dramatic)',
    gender: 'male',
    tone: 'Gravelly & Intense',
    style: 'gravelly deep dramatic thriller narration',
    geminiVoiceName: 'Algenib',
    elevenLabsVoiceId: 'flq6f7yk4E4fJM5XTYuZ', // Michael
  },
  {
    id: 'Rasalgethi',
    displayName: 'Rasalgethi',
    label: 'Rasalgethi (Male • Informative Analyst)',
    gender: 'male',
    tone: 'Informative & Analytical',
    style: 'sharp informative tech and finance analyst delivery',
    geminiVoiceName: 'Rasalgethi',
    elevenLabsVoiceId: 'IKne3meq5aSn9XLyUdCD', // Charlie
  },
  {
    id: 'Alnilam',
    displayName: 'Alnilam',
    label: 'Alnilam (Male • Firm & Command)',
    gender: 'male',
    tone: 'Firm & Commanding',
    style: 'firm steady authoritative leadership narration',
    geminiVoiceName: 'Alnilam',
    elevenLabsVoiceId: 'SOYHLrjzK2X1ezoPC6cr', // Harry
  },
  {
    id: 'Schedar',
    displayName: 'Schedar',
    label: 'Schedar (Male • Even & Balanced)',
    gender: 'male',
    tone: 'Even & Balanced',
    style: 'even-toned balanced steady documentary voice',
    geminiVoiceName: 'Schedar',
    elevenLabsVoiceId: 'TX3LPaxmHKxFdv7VOQHJ', // Liam
  },
  {
    id: 'Achird',
    displayName: 'Achird',
    label: 'Achird (Male • Friendly Guide)',
    gender: 'male',
    tone: 'Friendly & Approachable',
    style: 'warm friendly relatable YouTube creator voice',
    geminiVoiceName: 'Achird',
    elevenLabsVoiceId: 'bIHbv24MWmeRgasZH58o', // Will
  },
  {
    id: 'Zubenelgenubi',
    displayName: 'Zubenelgenubi',
    label: 'Zubenelgenubi (Male • Casual Podcast)',
    gender: 'male',
    tone: 'Casual & Podcast Host',
    style: 'natural casual podcast host conversational tone',
    geminiVoiceName: 'Zubenelgenubi',
    elevenLabsVoiceId: 'cjVigY5qzO86Huf0OWal', // Eric
  },
  {
    id: 'Sadachbia',
    displayName: 'Sadachbia',
    label: 'Sadachbia (Male • Lively & Dynamic)',
    gender: 'male',
    tone: 'Lively & Dynamic',
    style: 'lively animated fast-paced viral creator tone',
    geminiVoiceName: 'Sadachbia',
    elevenLabsVoiceId: 'iP95p4xoKVk53GoZ742B', // Chris
  },
  {
    id: 'Sadaltager',
    displayName: 'Sadaltager',
    label: 'Sadaltager (Male • Knowledgeable Host)',
    gender: 'male',
    tone: 'Knowledgeable & Trusted',
    style: 'knowledgeable articulate science and history host',
    geminiVoiceName: 'Sadaltager',
    elevenLabsVoiceId: 'nPczCjzI2devNBz1zQrb', // Brian
  },

  // --- FEMALE VOICES (14) ---
  {
    id: 'Kore',
    displayName: 'Kore',
    label: 'Kore (Female • Firm & Clear)',
    gender: 'female',
    tone: 'Firm & Clear Narrator',
    style: 'clear firm confident studio narration',
    geminiVoiceName: 'Kore',
    elevenLabsVoiceId: '21m00Tcm4TlvDq8ikWAM', // Rachel
  },
  {
    id: 'Aoede',
    displayName: 'Aoede',
    label: 'Aoede (Female • Breezy Storyteller)',
    gender: 'female',
    tone: 'Breezy & Warm Storyteller',
    style: 'warm breezy expressive natural storytelling',
    geminiVoiceName: 'Aoede',
    elevenLabsVoiceId: 'EXAVITQu4vr4xnSDxMaL', // Bella
  },
  {
    id: 'Leda',
    displayName: 'Leda',
    label: 'Leda (Female • Youthful Shorts)',
    gender: 'female',
    tone: 'Youthful & Lively',
    style: 'youthful lively engaging short-form delivery',
    geminiVoiceName: 'Leda',
    elevenLabsVoiceId: 'MF3mGyEYCl7XYWbV9V6O', // Elli
  },
  {
    id: 'Zephyr',
    displayName: 'Zephyr',
    label: 'Zephyr (Female • Bright & Smooth)',
    gender: 'female',
    tone: 'Bright & Modern',
    style: 'bright modern smooth explainer delivery',
    geminiVoiceName: 'Zephyr',
    elevenLabsVoiceId: 'AZnzlk1XvdvUeBnXmlld', // Domi
  },
  {
    id: 'Callirrhoe',
    displayName: 'Callirrhoe',
    label: 'Callirrhoe (Female • Easy-Going)',
    gender: 'female',
    tone: 'Easy-Going & Natural',
    style: 'easy-going warm conversational lifestyle voice',
    geminiVoiceName: 'Callirrhoe',
    elevenLabsVoiceId: 'ThT5KcBeYPX3keUQqHPh', // Dorothy
  },
  {
    id: 'Autonoe',
    displayName: 'Autonoe',
    label: 'Autonoe (Female • Bright Explainer)',
    gender: 'female',
    tone: 'Bright & Energetic',
    style: 'bright clear enthusiastic educational presenter',
    geminiVoiceName: 'Autonoe',
    elevenLabsVoiceId: 'jBpfuIE2acCO8z3wKNLl', // Gigi
  },
  {
    id: 'Despina',
    displayName: 'Despina',
    label: 'Despina (Female • Smooth Luxury)',
    gender: 'female',
    tone: 'Smooth & Refined',
    style: 'smooth refined luxury brand and travel narration',
    geminiVoiceName: 'Despina',
    elevenLabsVoiceId: 'oWAxZDx7w5VEj9dCyTzz', // Grace
  },
  {
    id: 'Erinome',
    displayName: 'Erinome',
    label: 'Erinome (Female • Clear & Crisp)',
    gender: 'female',
    tone: 'Clear & Studio Crisp',
    style: 'crisp articulate news and documentary narration',
    geminiVoiceName: 'Erinome',
    elevenLabsVoiceId: 'XB0fDUnXU5powFXDhCwa', // Charlotte
  },
  {
    id: 'Laomedeia',
    displayName: 'Laomedeia',
    label: 'Laomedeia (Female • Upbeat Motivational)',
    gender: 'female',
    tone: 'Upbeat & Motivational',
    style: 'upbeat inspiring energetic motivational delivery',
    geminiVoiceName: 'Laomedeia',
    elevenLabsVoiceId: 'jsCqWAovK2LkecY7zXl4', // Freya
  },
  {
    id: 'Achernar',
    displayName: 'Achernar',
    label: 'Achernar (Female • Soft & Gentle)',
    gender: 'female',
    tone: 'Soft & Soothing',
    style: 'soft gentle calming bedtime and mindfulness voice',
    geminiVoiceName: 'Achernar',
    elevenLabsVoiceId: 'LcfcDJNUP1GQjkzn1xUU', // Emily
  },
  {
    id: 'Gacrux',
    displayName: 'Gacrux',
    label: 'Gacrux (Female • Mature & Authoritative)',
    gender: 'female',
    tone: 'Mature & Authoritative',
    style: 'mature poised authoritative documentary narrator',
    geminiVoiceName: 'Gacrux',
    elevenLabsVoiceId: 'XrExE9yKIg1WjnnlVkGX', // Matilda
  },
  {
    id: 'Pulcherrima',
    displayName: 'Pulcherrima',
    label: 'Pulcherrima (Female • Forward & Bold)',
    gender: 'female',
    tone: 'Forward & Confident',
    style: 'bold forward confident commentary and creator delivery',
    geminiVoiceName: 'Pulcherrima',
    elevenLabsVoiceId: 'pFZP5JQG7iQjIQuC4Bku', // Lily
  },
  {
    id: 'Vindemiatrix',
    displayName: 'Vindemiatrix',
    label: 'Vindemiatrix (Female • Gentle & Poised)',
    gender: 'female',
    tone: 'Gentle & Poised',
    style: 'gentle poised calm narrative storytelling',
    geminiVoiceName: 'Vindemiatrix',
    elevenLabsVoiceId: 'z9fAnlkpzviPz146aGWa', // Glinda
  },
  {
    id: 'Sulafat',
    displayName: 'Sulafat',
    label: 'Sulafat (Female • Warm & Engaging)',
    gender: 'female',
    tone: 'Warm & Engaging',
    style: 'warm deeply engaging heartfelt human storytelling',
    geminiVoiceName: 'Sulafat',
    elevenLabsVoiceId: 'cgSgspJ2msm6clMCkdW9', // Jessica
  },
];

const VOICE_BY_ID = new Map(
  STUDIO_VOICE_CATALOG.map((v) => [v.id.toLowerCase(), v])
);

export function resolveStudioVoiceProfile(voiceId?: string): StudioVoiceProfile {
  const raw = (voiceId || 'Charon').trim();
  const matched = VOICE_BY_ID.get(raw.toLowerCase());
  if (matched) return matched;
  if (/^[A-Za-z0-9]{15,64}$/.test(raw)) {
    return {
      ...STUDIO_VOICE_CATALOG[0],
      id: raw,
      displayName: raw,
      elevenLabsVoiceId: raw,
    };
  }
  return STUDIO_VOICE_CATALOG[0];
}

export function defaultPreviewSampleText(language: string, voiceName: string): string {
  switch ((language || 'en').trim().toLowerCase()) {
    case 'hi':
      return `नमस्ते! मैं ${voiceName} हूँ। आपके अगले वायरल यूट्यूब वीडियो की आवाज़ बिल्कुल ऐसी सुनाई देगी।`;
    case 'hinglish':
      return `Namaste! Main ${voiceName} hoon. Aapke agle YouTube video ka voiceover bilkul aisa sunai dega.`;
    case 'es':
      return `Hola, soy ${voiceName}. Así sonará la narración de tu próximo video de YouTube.`;
    case 'fr':
      return `Bonjour, je suis ${voiceName}. Voici à quoi ressemblera la voix de votre prochaine vidéo.`;
    case 'de':
      return `Hallo, ich bin ${voiceName}. Genau so klingt die Stimme für dein nächstes YouTube-Video.`;
    case 'ja':
      return `こんにちは、${voiceName}です。次の動画のナレーションはこのような声になります。`;
    case 'pt':
      return `Olá, eu sou ${voiceName}. É assim que a narração do seu próximo vídeo vai soar.`;
    default:
      return `Hello! I'm ${voiceName}. This is how your next YouTube video narration will sound.`;
  }
}

export interface VoicePreviewRequest {
  userId: string;
  preferredProvider: VoiceProviderName;
  voiceId: string;
  language: string;
  speed: number;
  sampleText?: string;
}

export interface VoicePreviewResult {
  voiceId: string;
  providerUsed: VoiceProviderName;
  mimeType: string;
  audioBase64: string;
  sampleText: string;
}

interface CachedPreviewEntry {
  result: VoicePreviewResult;
  expiresAt: number;
}

const previewCache = new Map<string, CachedPreviewEntry>();
const PREVIEW_CACHE_TTL_MS = 15 * 60 * 1000;
const PREVIEW_CACHE_MAX = 60;

/**
 * Generates a short live voice preview audio clip (in-memory, zero storage clutter)
 * so users can audition all 30 studio voices before generating their video.
 */
export async function synthesizeVoicePreview(
  req: VoicePreviewRequest
): Promise<VoicePreviewResult> {
  const profile = resolveStudioVoiceProfile(req.voiceId);
  const speed = Math.max(0.75, Math.min(1.4, Number(req.speed || 1.0)));
  const language = (req.language || 'en').trim().toLowerCase();
  const sampleText = (req.sampleText || '').trim().slice(0, 180) ||
    defaultPreviewSampleText(language, profile.displayName);

  const cacheKey = `${req.userId}:${req.preferredProvider}:${profile.id}:${language}:${speed.toFixed(2)}:${sampleText}`;
  const now = Date.now();
  const cached = previewCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.result;
  }

  const providerOrder: VoiceProviderName[] =
    req.preferredProvider === 'elevenlabs'
      ? ['elevenlabs', 'gemini_tts']
      : ['gemini_tts', 'elevenlabs'];

  const synthReq: VoiceSynthesisRequest = {
    userId: req.userId,
    projectId: 'preview',
    text: sampleText,
    language,
    preferredProvider: req.preferredProvider,
    voiceId: profile.id,
    speed,
    workDir: '',
  };

  const errors: string[] = [];
  for (const provider of providerOrder) {
    try {
      const audio =
        provider === 'elevenlabs'
          ? await generateWithElevenLabs(synthReq)
          : await generateWithGeminiTts(synthReq);

      const result: VoicePreviewResult = {
        voiceId: profile.id,
        providerUsed: provider,
        mimeType: audio.mimeType,
        audioBase64: audio.buffer.toString('base64'),
        sampleText,
      };

      if (previewCache.size >= PREVIEW_CACHE_MAX) {
        const oldestKey = previewCache.keys().next().value;
        if (oldestKey) previewCache.delete(oldestKey);
      }
      previewCache.set(cacheKey, { result, expiresAt: now + PREVIEW_CACHE_TTL_MS });
      return result;
    } catch (err) {
      errors.push(`${provider}: ${sanitizeErrorMessage(err)}`);
    }
  }

  throw new Error(
    `Voice preview failed. Ensure your Gemini or ElevenLabs API key is connected (${errors.join(' | ')})`
  );
}

export interface VoiceSynthesisRequest {
  userId: string;
  projectId: string;
  text: string;
  language: string;
  preferredProvider: VoiceProviderName;
  voiceId: string;
  speed: number;
  workDir: string;
}

export interface VoiceSynthesisResult {
  providerUsed: VoiceProviderName;
  localAudioPath: string;
  storagePath: string;
  durationSec: number;
}

/**
 * Generates narration audio via Gemini TTS or ElevenLabs with automatic fallback,
 * persists it to Supabase Storage `voice-audio`, and measures exact duration via ffprobe.
 */
export async function synthesizeNarration(
  req: VoiceSynthesisRequest
): Promise<VoiceSynthesisResult> {
  const providerOrder: VoiceProviderName[] =
    req.preferredProvider === 'elevenlabs'
      ? ['elevenlabs', 'gemini_tts']
      : ['gemini_tts', 'elevenlabs'];

  const errors: string[] = [];

  for (const provider of providerOrder) {
    try {
      const audio =
        provider === 'elevenlabs'
          ? await generateWithElevenLabs(req)
          : await generateWithGeminiTts(req);

      const localAudioPath = resolveConfinedPath(req.workDir, `narration.${audio.ext}`);
      await fs.writeFile(localAudioPath, audio.buffer);

      const durationSec = await probeAudioDurationSeconds(localAudioPath);
      const storagePath = `${req.userId}/${req.projectId}/narration.${audio.ext}`;
      const { error: uploadError } = await uploadToStorageWithAutoBucket({
        bucket: 'voice-audio',
        storagePath,
        data: audio.buffer,
        contentType: audio.mimeType,
        upsert: true,
      });

      if (uploadError) {
        throw new Error(`Failed to persist narration audio: ${uploadError.message}`);
      }

      return {
        providerUsed: provider,
        localAudioPath,
        storagePath,
        durationSec,
      };
    } catch (err) {
      errors.push(`${provider}: ${sanitizeErrorMessage(err)}`);
    }
  }

  throw new Error(`Voice generation failed across configured providers (${errors.join(' | ')})`);
}

async function generateWithElevenLabs(
  req: VoiceSynthesisRequest
): Promise<{ buffer: Buffer; ext: string; mimeType: string }> {
  const cred = await resolveUserProviderKey(req.userId, 'elevenlabs');
  if (!cred) {
    throw new Error('ElevenLabs API key not configured.');
  }

  const profile = resolveStudioVoiceProfile(req.voiceId);
  // Accept a raw custom ElevenLabs 15+ char Voice ID if supplied; otherwise map from selected studio voice profile
  const voiceId = /^[A-Za-z0-9]{15,}$/.test(req.voiceId)
    ? req.voiceId
    : profile.elevenLabsVoiceId;

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': cred.apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text: req.text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.45,
          similarity_boost: 0.78,
          speed: Math.max(0.7, Math.min(1.2, req.speed || 1.0)),
        },
      }),
    }
  );

  if (!res.ok) {
    throw new Error(`ElevenLabs HTTP ${res.status}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 1024) {
    throw new Error('ElevenLabs returned empty audio buffer.');
  }
  return { buffer, ext: 'mp3', mimeType: 'audio/mpeg' };
}

async function generateWithGeminiTts(
  req: VoiceSynthesisRequest
): Promise<{ buffer: Buffer; ext: string; mimeType: string }> {
  const cred = await resolveUserProviderKey(req.userId, 'gemini');
  if (!cred) {
    throw new Error('Gemini API key not configured.');
  }

  const profile = resolveStudioVoiceProfile(req.voiceId);
  const voiceName = profile.geminiVoiceName;
  const speedClamped = Math.max(0.75, Math.min(1.4, Number(req.speed || 1.0)));

  const langMeta = resolveLanguageMeta(req.language);
  const requestBody = JSON.stringify({
    contents: [
      {
        parts: [
          {
            text: `Read the following narration aloud naturally in ${langMeta.ttsName} using ${profile.style} with authentic native pronunciation and ${speedClamped}x pacing. Speak ONLY the script text below without adding any extra words:\n\n${req.text}`,
          },
        ],
      },
    ],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName },
        },
      },
    },
  });

  const ttsModels = (await resolveActiveGeminiTtsModels(cred.apiKey)).slice(0, 4);
  const errors: string[] = [];
  let sawRateLimit = false;

  for (let i = 0; i < ttsModels.length; i++) {
    const model = ttsModels[i];
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent?key=${encodeURIComponent(cred.apiKey)}`;

    let res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody,
    });

    if (res.status === 429) {
      sawRateLimit = true;
      // Brief single backoff handles per-minute (RPM) bursts on Gemini Free Tier
      await new Promise((resolve) => setTimeout(resolve, 4000));
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody,
      });
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 403) {
        throw new Error('Invalid Gemini API key. Update your key in API Settings.');
      }
      if (isModelRetiredOrUnsupportedError(res.status, errText)) {
        console.warn(
          `[AutoTube Voice] Gemini TTS model "${model}" retired/unsupported (${res.status}); trying next active TTS model.`
        );
        markGeminiTtsModelRetired(cred.apiKey, model);
        errors.push(`${model}: retired (${res.status})`);
        continue;
      }
      if (res.status === 429) {
        errors.push(`${model}: HTTP 429`);
        if (i + 1 < ttsModels.length) continue;
        throw new Error(
          'Gemini TTS rate limit reached (HTTP 429). Wait a moment or add ElevenLabs in API Settings for voice-over.'
        );
      }
      errors.push(`${model}: HTTP ${res.status}`);
      if (i + 1 < ttsModels.length) continue;
      throw new Error(`Gemini TTS HTTP ${res.status}`);
    }

    const data = (await res.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            inlineData?: { mimeType?: string; data?: string };
          }>;
        };
      }>;
    };

    const inline = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
    if (!inline?.data) {
      errors.push(`${model}: empty audio payload`);
      continue;
    }

    const rawBytes = Buffer.from(inline.data, 'base64');
    const mime = (inline.mimeType || 'audio/L16;rate=24000').toLowerCase();

    if (mime.includes('l16') || mime.includes('pcm')) {
      const rateMatch = mime.match(/rate=(\d+)/);
      const sampleRate = rateMatch ? Number(rateMatch[1]) : 24000;
      const wavBuffer = wrapPcm16AsWav(rawBytes, sampleRate, 1);
      return { buffer: wavBuffer, ext: 'wav', mimeType: 'audio/wav' };
    }
    if (mime.includes('mp3') || mime.includes('mpeg')) {
      return { buffer: rawBytes, ext: 'mp3', mimeType: 'audio/mpeg' };
    }
    return { buffer: rawBytes, ext: 'wav', mimeType: 'audio/wav' };
  }

  if (sawRateLimit) {
    throw new Error(
      'Gemini TTS rate limit reached (HTTP 429). Wait a moment or add ElevenLabs in API Settings for voice-over.'
    );
  }
  throw new Error(`Gemini TTS failed across active models (${errors.join('; ')})`);
}

/**
 * Wraps raw signed 16-bit little-endian PCM bytes from Gemini TTS into a valid RIFF WAVE file.
 */
export function wrapPcm16AsWav(pcmData: Buffer, sampleRate: number, channels = 1): Buffer {
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmData.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmData.length, 40);

  return Buffer.concat([header, pcmData]);
}

export async function probeAudioDurationSeconds(filePath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync(config.ffprobePath, [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    const parsed = Number(stdout.trim());
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
  } catch {
    return 30;
  }
}
