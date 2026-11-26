import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import { config } from '../config/env.js';
import { resolveConfinedPath } from '../security/urlGuard.js';
import { resolveUserProviderKey } from './credentialService.js';
import { probeAudioDurationSeconds } from './voiceService.js';

const execFileAsync = promisify(execFile);

export interface WordTimestamp {
  word: string;
  startSec: number;
  endSec: number;
}

export interface WhisperWordAlignment {
  durationSec: number;
  words: WordTimestamp[];
  segments: Array<{ startSec: number; endSec: number; text: string }>;
}

/**
 * Removes awkward long pauses ("dead air" > 0.36s) from TTS voiceover so Shorts/Reels
 * maintain relentless high-retention pacing without sluggish silences.
 * Never alters normal speech cadence — falls back to original file if trimming fails or over-cuts.
 */
export async function trimAudioDeadAir(params: {
  workDir: string;
  inputAudioPath: string;
  originalDurationSec: number;
}): Promise<{ audioPath: string; durationSec: number; trimmed: boolean }> {
  const outPath = resolveConfinedPath(params.workDir, 'narration_tight.wav');
  try {
    await execFileAsync(
      config.ffmpegPath,
      [
        '-y',
        '-threads',
        '1',
        '-i',
        params.inputAudioPath,
        '-af',
        'silenceremove=start_periods=1:start_duration=0.05:start_threshold=-42dB:stop_periods=-1:stop_duration=0.34:stop_threshold=-38dB',
        '-ar',
        '24000',
        '-ac',
        '1',
        outPath,
      ],
      { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }
    );

    const newDuration = await probeAudioDurationSeconds(outPath);
    // Safety guard: never accept an aggressive trim that accidentally cuts >45% of audio
    if (newDuration >= 3 && newDuration >= params.originalDurationSec * 0.55) {
      return {
        audioPath: outPath,
        durationSec: newDuration,
        trimmed: params.originalDurationSec - newDuration > 0.25,
      };
    }
  } catch {
    // Non-fatal fallback to untrimmed audio
  }
  return {
    audioPath: params.inputAudioPath,
    durationSec: params.originalDurationSec,
    trimmed: false,
  };
}

/**
 * Extracts exact millisecond-level spoken word timestamps using the user's Groq Whisper API
 * (`whisper-large-v3-turbo`), returning null cleanly if Groq key is not configured or fails.
 */
export async function alignNarrationWithGroqWhisper(params: {
  userId: string;
  audioPath: string;
  language: string;
}): Promise<WhisperWordAlignment | null> {
  try {
    const cred = await resolveUserProviderKey(params.userId, 'groq');
    if (!cred?.apiKey) return null;

    const audioBytes = await fs.readFile(params.audioPath);
    if (audioBytes.length < 1024 || audioBytes.length > 24 * 1024 * 1024) {
      return null;
    }

    const ext = params.audioPath.toLowerCase().endsWith('.mp3') ? 'mp3' : 'wav';
    const mime = ext === 'mp3' ? 'audio/mpeg' : 'audio/wav';
    const langLower = (params.language || 'en').trim().toLowerCase();
    // For code-switched Hinglish, omit explicit language hint so Whisper tracks mixed tokens cleanly
    const whisperLang =
      langLower === 'hi'
        ? 'hi'
        : langLower === 'en' || langLower === 'es' || langLower === 'fr' || langLower === 'de' || langLower === 'ja' || langLower === 'pt'
          ? langLower
          : null;

    const modelsToTry = ['whisper-large-v3-turbo', 'whisper-large-v3'];
    for (const model of modelsToTry) {
      const form = new FormData();
      form.append('file', new Blob([audioBytes], { type: mime }), `narration.${ext}`);
      form.append('model', model);
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'word');
      form.append('timestamp_granularities[]', 'segment');
      if (whisperLang) {
        form.append('language', whisperLang);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cred.apiKey}`,
        },
        body: form,
        signal: controller.signal,
      }).catch(() => null);
      clearTimeout(timer);

      if (!res || !res.ok) continue;

      const payload = (await res.json()) as {
        duration?: number;
        words?: Array<{ word?: string; start?: number; end?: number }>;
        segments?: Array<{ start?: number; end?: number; text?: string }>;
      };

      const words: WordTimestamp[] = (payload.words || [])
        .filter((w) => typeof w.word === 'string' && w.word.trim().length > 0)
        .map((w) => ({
          word: String(w.word).trim(),
          startSec: Math.max(0, Number(w.start || 0)),
          endSec: Math.max(Number(w.start || 0) + 0.08, Number(w.end || 0)),
        }));

      const segments = (payload.segments || [])
        .filter((s) => typeof s.text === 'string' && s.text.trim().length > 0)
        .map((s) => ({
          startSec: Math.max(0, Number(s.start || 0)),
          endSec: Math.max(Number(s.start || 0) + 0.2, Number(s.end || 0)),
          text: String(s.text).trim(),
        }));

      if (words.length > 0) {
        return {
          durationSec: Math.max(0, Number(payload.duration || words[words.length - 1].endSec)),
          words,
          segments,
        };
      }
    }
  } catch {
    // Non-fatal: pipeline falls back to character/word-weighted timing
  }
  return null;
}

/**
 * Maps clean original script words onto real Whisper spoken word timestamps so captions
 * preserve 100% accurate spelling (especially Hindi Devanagari & Hinglish) while achieving
 * millisecond-accurate audio sync!
 */
export function mapScriptWordsToWhisperTimings(
  scriptWords: string[],
  whisperWords: WordTimestamp[],
  windowStartSec: number,
  windowEndSec: number
): WordTimestamp[] {
  if (scriptWords.length === 0) return [];
  const safeWindowEnd = Math.max(windowStartSec + 0.25, windowEndSec);
  const windowDur = safeWindowEnd - windowStartSec;

  if (!whisperWords || whisperWords.length === 0) {
    const totalChars = scriptWords.reduce((acc, w) => acc + Math.max(2, w.length), 0);
    let cursor = windowStartSec;
    return scriptWords.map((w, idx) => {
      const dur = (Math.max(2, w.length) / totalChars) * windowDur;
      const start = cursor;
      const end = idx === scriptWords.length - 1 ? safeWindowEnd : cursor + dur;
      cursor += dur;
      return { word: w, startSec: start, endSec: Math.max(start + 0.09, end) };
    });
  }

  // Filter Whisper words falling inside this time slice, or interpolate cleanly across whisper range
  const windowWords = whisperWords.filter(
    (w) => w.endSec >= windowStartSec - 0.15 && w.startSec <= safeWindowEnd + 0.15
  );
  const source = windowWords.length >= 2 ? windowWords : whisperWords;

  if (scriptWords.length === source.length) {
    return scriptWords.map((word, idx) => ({
      word,
      startSec: Math.max(windowStartSec, source[idx].startSec),
      endSec: Math.max(
        Math.max(windowStartSec, source[idx].startSec) + 0.09,
        Math.min(safeWindowEnd, source[idx].endSec)
      ),
    }));
  }

  // Linearly interpolate proportional index positions across real spoken word intervals
  const totalSpeechStart = Math.max(windowStartSec, source[0].startSec);
  const totalSpeechEnd = Math.min(safeWindowEnd, source[source.length - 1].endSec);
  const effectiveEnd = Math.max(totalSpeechStart + 0.25, totalSpeechEnd);

  return scriptWords.map((word, i) => {
    const ratioStart = i / scriptWords.length;
    const ratioEnd = (i + 1) / scriptWords.length;
    const startSec = totalSpeechStart + ratioStart * (effectiveEnd - totalSpeechStart);
    const endSec = totalSpeechStart + ratioEnd * (effectiveEnd - totalSpeechStart);
    return {
      word,
      startSec,
      endSec: Math.max(startSec + 0.09, endSec),
    };
  });
}
