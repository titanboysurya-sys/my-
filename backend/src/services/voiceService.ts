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
  label: string;
  gender: 'male' | 'female';
  style: string;
  geminiVoiceName: string;
  elevenLabsVoiceId: string;
}

/**
 * Curated multi-gender studio voice catalog mapped to real Gemini TTS prebuilt voices
 * and distinct ElevenLabs premade voice IDs so user voice choice works across both providers.
 */
export const STUDIO_VOICE_CATALOG: StudioVoiceProfile[] = [
  {
    id: 'Charon',
    label: 'Charon (Male • Deep Documentary)',
    gender: 'male',
    style: 'deep authoritative documentary narration',
    geminiVoiceName: 'Charon',
    elevenLabsVoiceId: 'pNInz6obpgDQGcFmaJgB', // Adam (Deep Male)
  },
  {
    id: 'Fenrir',
    label: 'Fenrir (Male • Bold Viral Energy)',
    gender: 'male',
    style: 'energetic punchy high-retention storytelling',
    geminiVoiceName: 'Fenrir',
    elevenLabsVoiceId: 'TxGEqnHWrfWFTfGW9XjX', // Josh (Energetic Male)
  },
  {
    id: 'Puck',
    label: 'Puck (Male • Friendly & Upbeat)',
    gender: 'male',
    style: 'friendly upbeat conversational storytelling',
    geminiVoiceName: 'Puck',
    elevenLabsVoiceId: 'ErXwobaYiN019PkySvjV', // Antoni (Warm Male)
  },
  {
    id: 'Orus',
    label: 'Orus (Male • Crisp News Anchor)',
    gender: 'male',
    style: 'clear confident broadcast anchor delivery',
    geminiVoiceName: 'Orus',
    elevenLabsVoiceId: 'VR6AewLTigWG4xSOukaG', // Arnold (Crisp Male)
  },
  {
    id: 'Kore',
    label: 'Kore (Female • Clear & Firm)',
    gender: 'female',
    style: 'clear confident studio narration',
    geminiVoiceName: 'Kore',
    elevenLabsVoiceId: '21m00Tcm4TlvDq8ikWAM', // Rachel (Clear Female)
  },
  {
    id: 'Aoede',
    label: 'Aoede (Female • Warm Storyteller)',
    gender: 'female',
    style: 'warm expressive natural storytelling',
    geminiVoiceName: 'Aoede',
    elevenLabsVoiceId: 'EXAVITQu4vr4xnSDxMaL', // Bella (Warm Female)
  },
  {
    id: 'Leda',
    label: 'Leda (Female • Youthful Shorts)',
    gender: 'female',
    style: 'youthful lively engaging delivery',
    geminiVoiceName: 'Leda',
    elevenLabsVoiceId: 'MF3mGyEYCl7XYWbV9V6O', // Elli (Youthful Female)
  },
  {
    id: 'Zephyr',
    label: 'Zephyr (Female • Bright & Smooth)',
    gender: 'female',
    style: 'bright modern explainer delivery',
    geminiVoiceName: 'Zephyr',
    elevenLabsVoiceId: 'AZnzlk1XvdvUeBnXmlld', // Domi (Bright Female)
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
      elevenLabsVoiceId: raw,
    };
  }
  return STUDIO_VOICE_CATALOG[0];
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
