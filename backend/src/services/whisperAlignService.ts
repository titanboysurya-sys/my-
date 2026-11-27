import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import { config } from '../config/env.js';
import { resolveConfinedPath } from '../security/urlGuard.js';
import { resolveUserProviderKey } from './credentialService.js';
import {
  isModelRetiredOrUnsupportedError,
  markGeminiTextModelRetired,
  resolveActiveGeminiTextModels,
} from './modelResolver.js';
import { probeAudioDurationSeconds } from './voiceService.js';

const execFileAsync = promisify(execFile);

export interface WordTimestamp {
  word: string;
  startSec: number;
  endSec: number;
}

export interface AudioSpeechInterval {
  startSec: number;
  endSec: number;
}

export interface SceneTimingHint {
  sceneNumber: number;
  startSec: number;
  endSec: number;
}

export interface WhisperWordAlignment {
  durationSec: number;
  words: WordTimestamp[];
  segments: Array<{ startSec: number; endSec: number; text: string }>;
}

/**
 * Removes awkward long pauses ("dead air" > 0.34s) from TTS voiceover so Shorts/Reels
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
 * Pure parser for FFmpeg `silencedetect` stderr output -> active non-silent speech intervals.
 * Runs cleanly offline without API keys so subtitles stay pinned to actual spoken bursts.
 */
export function parseSilenceDetectIntervals(
  stderr: string,
  totalDurationSec: number
): AudioSpeechInterval[] {
  const total = Math.max(0.5, totalDurationSec);
  const silences: Array<{ start: number; end: number }> = [];
  let pendingStart: number | null = null;

  for (const line of stderr.split(/\r?\n/)) {
    const startMatch = line.match(/silence_start:\s*([0-9]+(?:\.[0-9]+)?)/);
    if (startMatch) {
      pendingStart = Math.max(0, Number(startMatch[1]));
      continue;
    }
    const endMatch = line.match(/silence_end:\s*([0-9]+(?:\.[0-9]+)?)/);
    if (endMatch) {
      const end = Math.min(total, Math.max(0, Number(endMatch[1])));
      const start = pendingStart !== null ? Math.min(pendingStart, end) : Math.max(0, end - 0.14);
      silences.push({ start, end });
      pendingStart = null;
    }
  }

  if (pendingStart !== null && pendingStart < total) {
    silences.push({ start: pendingStart, end: total });
  }

  if (silences.length === 0) {
    return [{ startSec: 0, endSec: total }];
  }

  silences.sort((a, b) => a.start - b.start);
  const speech: AudioSpeechInterval[] = [];
  let cursor = 0;

  for (const s of silences) {
    if (s.start > cursor + 0.06) {
      speech.push({ startSec: cursor, endSec: s.start });
    }
    cursor = Math.max(cursor, s.end);
  }
  if (total > cursor + 0.06) {
    speech.push({ startSec: cursor, endSec: total });
  }

  return speech.length > 0 ? speech : [{ startSec: 0, endSec: total }];
}

/**
 * Probes the rendered voiceover file via FFmpeg `silencedetect` to extract exact active
 * speech bursts (eliminating leading/trailing silence and inter-sentence pause drift).
 */
export async function detectAudioSpeechIntervals(
  audioPath: string,
  totalDurationSec: number
): Promise<AudioSpeechInterval[]> {
  try {
    const { stderr } = await execFileAsync(
      config.ffmpegPath,
      [
        '-threads',
        '1',
        '-i',
        audioPath,
        '-af',
        'silencedetect=noise=-36dB:d=0.14',
        '-f',
        'null',
        '-',
      ],
      { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 }
    );
    return parseSilenceDetectIntervals(stderr || '', totalDurationSec);
  } catch {
    return [{ startSec: 0, endSec: Math.max(0.5, totalDurationSec) }];
  }
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
        : langLower === 'en' ||
            langLower === 'es' ||
            langLower === 'fr' ||
            langLower === 'de' ||
            langLower === 'ja' ||
            langLower === 'pt'
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
    // Non-fatal: pipeline falls back to Gemini audio alignment / FFmpeg speech bursts
  }
  return null;
}

/**
 * Validates candidate scene timestamps returned by Gemini Audio Alignment so corrupted or
 * non-monotonic timestamps can never degrade subtitle sync.
 */
export function validateSceneTimingHints(
  hints: SceneTimingHint[],
  expectedSceneNumbers: number[],
  totalDurationSec: number
): SceneTimingHint[] | null {
  if (expectedSceneNumbers.length === 0 || hints.length !== expectedSceneNumbers.length) {
    return null;
  }

  const byScene = new Map<number, SceneTimingHint>();
  for (const h of hints) {
    const num = Math.round(Number(h.sceneNumber));
    const startSec = Number(h.startSec);
    const endSec = Number(h.endSec);
    if (!Number.isFinite(num) || !Number.isFinite(startSec) || !Number.isFinite(endSec)) {
      return null;
    }
    byScene.set(num, {
      sceneNumber: num,
      startSec: Math.max(0, startSec),
      endSec: Math.min(totalDurationSec + 0.5, endSec),
    });
  }

  const ordered: SceneTimingHint[] = [];
  let prevEnd = 0;
  for (const num of expectedSceneNumbers) {
    const item = byScene.get(num);
    if (!item) return null;
    const startSec = Math.max(prevEnd, item.startSec);
    const endSec = Math.max(startSec + 0.25, item.endSec);
    if (startSec > totalDurationSec + 0.4) return null;
    ordered.push({
      sceneNumber: num,
      startSec,
      endSec: Math.min(totalDurationSec, endSec),
    });
    prevEnd = Math.min(totalDurationSec, endSec);
  }

  const coveredSpan = ordered[ordered.length - 1].endSec - ordered[0].startSec;
  if (coveredSpan < Math.max(2, totalDurationSec * 0.6)) {
    return null;
  }
  return ordered;
}

/**
 * Uses the user's connected Gemini multimodal model to listen directly to the rendered
 * narration audio and align each scene's spoken sentence to exact timestamps when Groq
 * Whisper is unavailable (zero extra API key required).
 */
export async function alignScenesWithGeminiAudio(params: {
  userId: string;
  workDir: string;
  audioPath: string;
  durationSec: number;
  scenes: Array<{ sceneNumber: number; text: string }>;
}): Promise<SceneTimingHint[] | null> {
  const nonEmptyScenes = params.scenes.filter((s) => s.text.trim().length > 0);
  if (nonEmptyScenes.length === 0 || params.durationSec < 2 || params.durationSec > 240) {
    return null;
  }

  const compactMp3Path = resolveConfinedPath(params.workDir, 'align_probe_16k.mp3');
  try {
    const cred = await resolveUserProviderKey(params.userId, 'gemini');
    if (!cred?.apiKey) return null;

    await execFileAsync(
      config.ffmpegPath,
      [
        '-y',
        '-threads',
        '1',
        '-i',
        params.audioPath,
        '-ac',
        '1',
        '-ar',
        '16000',
        '-b:a',
        '48k',
        compactMp3Path,
      ],
      { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 }
    );

    const mp3Bytes = await fs.readFile(compactMp3Path);
    if (mp3Bytes.length < 512 || mp3Bytes.length > 10 * 1024 * 1024) {
      return null;
    }

    const models = (await resolveActiveGeminiTextModels(cred.apiKey)).slice(0, 2);
    const prompt = JSON.stringify({
      task: 'Listen carefully to the voiceover audio and return the exact spoken startSec and endSec for every scene in strict chronological order.',
      totalAudioDurationSec: Number(params.durationSec.toFixed(2)),
      rules: [
        'Each scene startSec/endSec MUST match when those exact words are actually spoken in the audio.',
        'Timestamps MUST be strictly non-overlapping and monotonically increasing within [0, totalAudioDurationSec].',
        'Return strictly valid JSON: {"scenes":[{"sceneNumber":1,"startSec":0.1,"endSec":2.4}]}',
      ],
      scenes: nonEmptyScenes.map((s) => ({
        sceneNumber: s.sceneNumber,
        spokenText: s.text,
      })),
    });

    const body = JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: {
                mimeType: 'audio/mpeg',
                data: mp3Bytes.toString('base64'),
              },
            },
            { text: prompt },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.0,
        responseMimeType: 'application/json',
      },
    });

    for (const model of models) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25_000);
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        model
      )}:generateContent?key=${encodeURIComponent(cred.apiKey)}`;

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      }).catch(() => null);
      clearTimeout(timer);

      if (!res) continue;
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        if (isModelRetiredOrUnsupportedError(res.status, errText)) {
          markGeminiTextModelRetired(cred.apiKey, model);
        }
        continue;
      }

      const payload = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const rawText = payload.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (!rawText) continue;

      const cleaned = rawText
        .replace(/^```json\s*/i, '')
        .replace(/```$/i, '')
        .trim();
      const parsed = JSON.parse(cleaned) as { scenes?: SceneTimingHint[] };
      const validated = validateSceneTimingHints(
        Array.isArray(parsed.scenes) ? parsed.scenes : [],
        nonEmptyScenes.map((s) => s.sceneNumber),
        params.durationSec
      );
      if (validated) {
        return validated;
      }
    }
  } catch {
    // Non-fatal fallback to acoustic speech intervals
  } finally {
    await fs.rm(compactMp3Path, { force: true }).catch(() => undefined);
  }
  return null;
}

function normalizeLexToken(token: string): string {
  return token
    .toLowerCase()
    .replace(/['’`\-.,!?;:"()[\]{}।]/g, '')
    .trim();
}

function tokenMatchScore(aRaw: string, bRaw: string): number {
  const a = normalizeLexToken(aRaw);
  const b = normalizeLexToken(bRaw);
  if (!a || !b) return -0.8;
  if (a === b) return 4.0;
  if (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a))) {
    return 2.4;
  }
  // Bigram Dice coefficient for minor spelling/contraction variants
  if (a.length >= 3 && b.length >= 3) {
    const bigrams = (s: string) => {
      const set = new Set<string>();
      for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
      return set;
    };
    const ba = bigrams(a);
    const bb = bigrams(b);
    let hit = 0;
    for (const bg of ba) if (bb.has(bg)) hit++;
    const dice = (2 * hit) / (ba.size + bb.size);
    if (dice >= 0.6) return 2.2 * dice;
  }
  return -1.0;
}

function distributeWordsAcrossSpan(
  words: string[],
  startSec: number,
  endSec: number
): WordTimestamp[] {
  if (words.length === 0) return [];
  const safeStart = Math.max(0, startSec);
  const safeEnd = Math.max(safeStart + 0.1 * words.length, endSec);
  const span = safeEnd - safeStart;
  const totalChars = words.reduce((acc, w) => acc + Math.max(2, w.length), 0);
  let cursor = safeStart;
  return words.map((word, idx) => {
    const dur = (Math.max(2, word.length) / totalChars) * span;
    const s = cursor;
    const e = idx === words.length - 1 ? safeEnd : cursor + dur;
    cursor += dur;
    return { word, startSec: s, endSec: Math.max(s + 0.08, e) };
  });
}

/**
 * Distributes words strictly across active non-silent speech intervals [startSec, endSec]
 * so pauses and leading/trailing silences in the audio NEVER shift subtitles out of sync.
 */
export function distributeWordsAcrossSpeechIntervals(
  words: string[],
  intervals: AudioSpeechInterval[],
  fallbackStartSec = 0,
  fallbackEndSec = 5
): WordTimestamp[] {
  if (words.length === 0) return [];
  const cleanIntervals = intervals
    .filter((iv) => iv.endSec > iv.startSec + 0.04)
    .sort((a, b) => a.startSec - b.startSec);

  if (cleanIntervals.length === 0) {
    return distributeWordsAcrossSpan(words, fallbackStartSec, fallbackEndSec);
  }

  const cumulativeSpeech: number[] = [0];
  for (const iv of cleanIntervals) {
    cumulativeSpeech.push(cumulativeSpeech[cumulativeSpeech.length - 1] + (iv.endSec - iv.startSec));
  }
  const totalSpeech = cumulativeSpeech[cumulativeSpeech.length - 1];
  if (totalSpeech <= 0.1) {
    return distributeWordsAcrossSpan(words, fallbackStartSec, fallbackEndSec);
  }

  const speechOffsetToAudioTime = (speechOffset: number): number => {
    const clamped = Math.max(0, Math.min(totalSpeech, speechOffset));
    for (let k = 0; k < cleanIntervals.length; k++) {
      if (clamped <= cumulativeSpeech[k + 1] || k === cleanIntervals.length - 1) {
        const local = clamped - cumulativeSpeech[k];
        return Math.min(cleanIntervals[k].endSec, cleanIntervals[k].startSec + local);
      }
    }
    return cleanIntervals[cleanIntervals.length - 1].endSec;
  };

  const totalChars = words.reduce((acc, w) => acc + Math.max(2, w.length), 0);
  let charCursor = 0;
  return words.map((word, idx) => {
    const wChars = Math.max(2, word.length);
    const sSpeech = (charCursor / totalChars) * totalSpeech;
    charCursor += wChars;
    const eSpeech = idx === words.length - 1 ? totalSpeech : (charCursor / totalChars) * totalSpeech;
    const startSec = speechOffsetToAudioTime(sSpeech);
    const rawEnd = speechOffsetToAudioTime(eSpeech);
    return {
      word,
      startSec,
      endSec: Math.max(startSec + 0.08, rawEnd),
    };
  });
}

/**
 * Globally aligns the full flat array of spoken script words across the ENTIRE video
 * against real Whisper timestamps (via monotonic dynamic programming), OR against
 * Gemini scene timings / FFmpeg active speech intervals.
 *
 * Unlike windowed alignment, this prevents ANY cumulative 8-10s subtitle drift even when
 * scene durations or speech speed vary dramatically from start to finish!
 */
export function alignFullScriptWordsGlobally(params: {
  scriptWords: string[];
  totalDurationSec: number;
  whisperWords?: WordTimestamp[];
  speechIntervals?: AudioSpeechInterval[];
}): WordTimestamp[] {
  const { scriptWords, totalDurationSec } = params;
  if (scriptWords.length === 0) return [];
  const total = Math.max(1, totalDurationSec);
  const whisper = (params.whisperWords || []).filter((w) => w.word.trim().length > 0);

  if (whisper.length >= 2) {
    const n = scriptWords.length;
    const m = whisper.length;

    // Monotonic Needleman-Wunsch DP alignment (O(N*M), typically < 2ms for Shorts/Reels)
    if (n * m <= 250_000) {
      const cols = m + 1;
      const dp = new Float32Array((n + 1) * cols);
      const bt = new Uint8Array((n + 1) * cols); // 1=diag, 2=up(skip script), 3=left(skip whisper)
      const GAP_SCRIPT = -0.75;
      const GAP_WHISPER = -0.65;

      for (let i = 1; i <= n; i++) {
        dp[i * cols] = dp[(i - 1) * cols] + GAP_SCRIPT;
        bt[i * cols] = 2;
      }
      for (let j = 1; j <= m; j++) {
        dp[j] = dp[j - 1] + GAP_WHISPER;
        bt[j] = 3;
      }

      for (let i = 1; i <= n; i++) {
        const sWord = scriptWords[i - 1];
        const ratioI = (i - 0.5) / n;
        for (let j = 1; j <= m; j++) {
          const sim = tokenMatchScore(sWord, whisper[j - 1].word);
          // Tiny proportional tie-breaker keeps repeated filler words ("the", "and") aligned locally
          const posBonus = sim > 0 ? Math.max(0, 0.25 - Math.abs(ratioI - (j - 0.5) / m) * 0.5) : 0;
          const diag = dp[(i - 1) * cols + (j - 1)] + sim + posBonus;
          const up = dp[(i - 1) * cols + j] + GAP_SCRIPT;
          const left = dp[i * cols + (j - 1)] + GAP_WHISPER;

          if (diag >= up && diag >= left) {
            dp[i * cols + j] = diag;
            bt[i * cols + j] = 1;
          } else if (up >= left) {
            dp[i * cols + j] = up;
            bt[i * cols + j] = 2;
          } else {
            dp[i * cols + j] = left;
            bt[i * cols + j] = 3;
          }
        }
      }

      const anchorForScript = new Int32Array(n).fill(-1);
      let i = n;
      let j = m;
      let matchedCount = 0;
      while (i > 0 && j > 0) {
        const move = bt[i * cols + j];
        if (move === 1) {
          if (tokenMatchScore(scriptWords[i - 1], whisper[j - 1].word) >= 1.2) {
            anchorForScript[i - 1] = j - 1;
            matchedCount++;
          }
          i--;
          j--;
        } else if (move === 2) {
          i--;
        } else {
          j--;
        }
      }

      // If enough lexical anchors locked on (>= 20% of words or >= 2), interpolate gaps between exact anchors!
      if (matchedCount >= Math.min(n, Math.max(2, Math.floor(n * 0.2)))) {
        const result: Array<WordTimestamp | null> = new Array(n).fill(null);
        const anchorIndices: number[] = [];
        for (let idx = 0; idx < n; idx++) {
          const wIdx = anchorForScript[idx];
          if (wIdx >= 0) {
            anchorIndices.push(idx);
            result[idx] = {
              word: scriptWords[idx],
              startSec: Math.max(0, whisper[wIdx].startSec),
              endSec: Math.min(total, Math.max(whisper[wIdx].startSec + 0.08, whisper[wIdx].endSec)),
            };
          }
        }

        // Fill leading words before first anchor
        const firstA = anchorIndices[0];
        if (firstA > 0) {
          const leadStart = Math.min(whisper[0].startSec, result[firstA]!.startSec);
          const leadEnd = Math.max(leadStart + 0.08 * firstA, result[firstA]!.startSec);
          const filled = distributeWordsAcrossSpan(scriptWords.slice(0, firstA), leadStart, leadEnd);
          for (let k = 0; k < firstA; k++) result[k] = filled[k];
        }

        // Fill gaps strictly between consecutive anchors
        for (let a = 0; a < anchorIndices.length - 1; a++) {
          const leftIdx = anchorIndices[a];
          const rightIdx = anchorIndices[a + 1];
          if (rightIdx - leftIdx <= 1) continue;
          const gapWords = scriptWords.slice(leftIdx + 1, rightIdx);
          const leftAnchor = result[leftIdx]!;
          const rightAnchor = result[rightIdx]!;
          const gapStart = Math.min(leftAnchor.endSec, rightAnchor.startSec);
          const gapEnd = Math.max(gapStart + 0.08 * gapWords.length, rightAnchor.startSec);
          const filled = distributeWordsAcrossSpan(gapWords, gapStart, gapEnd);
          for (let k = 0; k < filled.length; k++) {
            result[leftIdx + 1 + k] = filled[k];
          }
        }

        // Fill trailing words after last anchor
        const lastA = anchorIndices[anchorIndices.length - 1];
        if (lastA < n - 1) {
          const tailWords = scriptWords.slice(lastA + 1);
          const lastWhisperEnd = whisper[m - 1].endSec;
          const tailStart = result[lastA]!.endSec;
          const tailEnd = Math.max(tailStart + 0.08 * tailWords.length, Math.min(total, lastWhisperEnd));
          const filled = distributeWordsAcrossSpan(tailWords, tailStart, tailEnd);
          for (let k = 0; k < filled.length; k++) {
            result[lastA + 1 + k] = filled[k];
          }
        }

        // Guarantee monotonic non-overlapping order
        const finalized: WordTimestamp[] = [];
        let prevStart = 0;
        for (let idx = 0; idx < n; idx++) {
          const item = result[idx]!;
          const s = Math.max(prevStart, Math.min(total - 0.08, item.startSec));
          const e = Math.min(total, Math.max(s + 0.08, item.endSec));
          finalized.push({ word: item.word, startSec: s, endSec: e });
          prevStart = s + 0.02;
        }
        return finalized;
      }
    }

    // Fallback when Whisper script differs lexically (e.g. Romanized Hindi): map onto Whisper's real speech intervals!
    const whisperIntervals: AudioSpeechInterval[] = [];
    for (const w of whisper) {
      const prev = whisperIntervals[whisperIntervals.length - 1];
      if (prev && w.startSec - prev.endSec <= 0.18) {
        prev.endSec = Math.max(prev.endSec, Math.min(total, w.endSec));
      } else {
        whisperIntervals.push({
          startSec: Math.max(0, w.startSec),
          endSec: Math.min(total, Math.max(w.startSec + 0.08, w.endSec)),
        });
      }
    }
    return distributeWordsAcrossSpeechIntervals(scriptWords, whisperIntervals, 0, total);
  }

  // Tier 3: Map words onto real FFmpeg acoustic speech bursts (ignores leading/trailing silence & pauses)
  if (params.speechIntervals && params.speechIntervals.length > 0) {
    return distributeWordsAcrossSpeechIntervals(scriptWords, params.speechIntervals, 0, total);
  }

  return distributeWordsAcrossSpan(scriptWords, 0, total);
}

/**
 * Maps clean original script words onto real Whisper spoken word timestamps inside a local window
 * (kept exported for direct unit testing & backwards compatibility).
 */
export function mapScriptWordsToWhisperTimings(
  scriptWords: string[],
  whisperWords: WordTimestamp[],
  windowStartSec: number,
  windowEndSec: number
): WordTimestamp[] {
  if (scriptWords.length === 0) return [];
  const safeWindowEnd = Math.max(windowStartSec + 0.25, windowEndSec);

  if (!whisperWords || whisperWords.length === 0) {
    return distributeWordsAcrossSpan(scriptWords, windowStartSec, safeWindowEnd);
  }

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
