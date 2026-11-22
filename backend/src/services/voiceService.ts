import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import { config, sanitizeErrorMessage } from '../config/env.js';
import { uploadToStorageWithAutoBucket } from '../db/supabase.js';
import { resolveConfinedPath } from '../security/urlGuard.js';
import { resolveUserProviderKey } from './credentialService.js';

const execFileAsync = promisify(execFile);

export type VoiceProviderName = 'gemini_tts' | 'elevenlabs';

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

  // Default to Rachel voice ID if a non-ElevenLabs voice name was passed
  const voiceId = /^[A-Za-z0-9]{15,}$/.test(req.voiceId)
    ? req.voiceId
    : '21m00Tcm4TlvDq8ikWAM';

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

  const validGeminiVoices = new Set(['Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede', 'Zephyr']);
  const voiceName = validGeminiVoices.has(req.voiceId) ? req.voiceId : 'Kore';

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${encodeURIComponent(
    cred.apiKey
  )}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              text: `Read the following narration naturally in ${req.language} at ${req.speed}x pacing:\n\n${req.text}`,
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
    }),
  });

  if (!res.ok) {
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
    throw new Error('Gemini TTS response did not include audio payload.');
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
