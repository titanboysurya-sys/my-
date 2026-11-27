import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import { config } from '../config/env.js';
import { resolveConfinedPath } from '../security/urlGuard.js';
import { sanitizeSpokenNarration } from './narrationSanitizer.js';
import {
  alignFullScriptWordsGlobally,
  distributeWordsAcrossSpeechIntervals,
  type AudioSpeechInterval,
  type SceneTimingHint,
  type WordTimestamp,
} from './whisperAlignService.js';

const execFileAsync = promisify(execFile);

export interface TimelineSceneClip {
  sceneNumber: number;
  localMediaPath: string;
  mediaType: 'video' | 'image';
  durationSec: number;
  subtitleText: string;
  transition: string;
}

export type SubtitlePresetId =
  | 'mrbeast'
  | 'hormozi'
  | 'neon_glow'
  | 'cinematic_gold'
  | 'classic';

export type EditingPacePreset = 'viral_fast' | 'balanced' | 'cinematic';
export type ColorGradePreset = 'vibrant' | 'dark_moody' | 'teal_orange' | 'clean';

export interface SubtitleStyleConfig {
  enabled: boolean;
  burnIn: boolean;
  preset?: SubtitlePresetId;
  fontSize: number;
  primaryColor: string;
  highlightColor?: string;
  outlineColor: string;
  position: 'bottom_safe' | 'center' | 'top_safe';
}

export interface RenderVideoRequest {
  workDir: string;
  clips: TimelineSceneClip[];
  narrationAudioPath: string;
  totalNarrationDurationSec: number;
  format: '9:16' | '16:9' | '1:1';
  qualityPreset: '720p' | '1080p';
  subtitleStyle: SubtitleStyleConfig;
  editingPace?: EditingPacePreset;
  colorGrade?: ColorGradePreset;
  hookBannerText?: string | null;
  whisperWords?: WordTimestamp[];
  speechIntervals?: AudioSpeechInterval[];
  geminiSceneTimings?: SceneTimingHint[];
  backgroundMusicPath?: string | null;
  musicVolume?: number;
  narrationVolume?: number;
  duckingEnabled?: boolean;
  sfxEnabled?: boolean;
  hookBoomPath?: string | null;
  whooshPath?: string | null;
}

export interface RenderVideoOutput {
  finalVideoPath: string;
  srtPath: string;
  width: number;
  height: number;
  durationSec: number;
  fileSizeBytes: number;
}

export function resolveOutputDimensions(
  format: '9:16' | '16:9' | '1:1',
  qualityPreset: '720p' | '1080p'
): { width: number; height: number } {
  const high = qualityPreset === '1080p';
  switch (format) {
    case '9:16':
      return high ? { width: 1080, height: 1920 } : { width: 720, height: 1280 };
    case '16:9':
      return high ? { width: 1920, height: 1080 } : { width: 1280, height: 720 };
    case '1:1':
      return high ? { width: 1080, height: 1080 } : { width: 720, height: 720 };
  }
}

/**
 * Calibrates each scene's duration proportionally to its actual spoken text weight
 * so visuals and subtitles stay tightly synchronized with the TTS voiceover from start to finish.
 */
export function calibrateClipDurations(
  clips: TimelineSceneClip[],
  totalNarrationDurationSec: number
): TimelineSceneClip[] {
  const targetTotal = Math.max(totalNarrationDurationSec, 5);
  if (clips.length === 0) return [];

  const weights = clips.map((clip) => {
    const clean = (clip.subtitleText || '').trim();
    if (!clean) return Math.max(0.8, clip.durationSec);
    const words = clean.split(/\s+/).filter(Boolean).length;
    const chars = clean.replace(/\s+/g, '').length;
    // Blend word & character count so both English and Devanagari/CJK pacing stay accurate
    return Math.max(0.8, words * 0.65 + (chars / 5) * 0.35);
  });

  const sumWeight = weights.reduce((a, b) => a + b, 0) || 1;
  // Keep minimum scene cut nimble (0.65s) so short punch scenes do not push later captions late
  const minSceneSec = Math.min(0.65, targetTotal / clips.length);

  const rawDurations = weights.map((w) => Math.max(minSceneSec, (w / sumWeight) * targetTotal));
  const rawSum = rawDurations.reduce((a, b) => a + b, 0) || targetTotal;

  return clips.map((clip, idx) => ({
    ...clip,
    durationSec: (rawDurations[idx] / rawSum) * targetTotal,
  }));
}

function splitCaptionChunks(text: string, maxWordsPerChunk: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += maxWordsPerChunk) {
    chunks.push(words.slice(i, i + maxWordsPerChunk).join(' '));
  }
  return chunks;
}

export interface AlignedClipTimeline {
  clips: TimelineSceneClip[];
  wordTimingsByScene: WordTimestamp[][];
  hasRealAudioSync: boolean;
}

/**
 * Computes a single unified timeline of spoken word timestamps AND matching scene cut
 * durations across the entire audio track so voiceover, burned ASS captions, exported SRT,
 * and scene cuts never drift apart.
 */
export function buildUnifiedAlignedTimeline(
  clips: TimelineSceneClip[],
  totalDurationSec: number,
  options?: {
    whisperWords?: WordTimestamp[];
    speechIntervals?: AudioSpeechInterval[];
    geminiSceneTimings?: SceneTimingHint[];
  }
): AlignedClipTimeline {
  const safeTotal = Math.max(
    1,
    totalDurationSec || clips.reduce((acc, c) => acc + Math.max(0.5, c.durationSec), 0)
  );
  const cleanTexts = clips.map((c) => sanitizeSpokenNarration(c.subtitleText || ''));
  const sceneWordArrays = cleanTexts.map((t) => t.split(/\s+/).filter(Boolean));
  const flatWords = sceneWordArrays.flat();

  const hasWhisper = Boolean(options?.whisperWords && options.whisperWords.length >= 2);
  const hasSpeechIntervals = Boolean(options?.speechIntervals && options.speechIntervals.length > 0);
  const geminiHints = options?.geminiSceneTimings || [];
  const hintByScene = new Map(geminiHints.map((h) => [h.sceneNumber, h]));

  if (flatWords.length === 0) {
    return {
      clips: calibrateClipDurations(clips, safeTotal),
      wordTimingsByScene: clips.map(() => []),
      hasRealAudioSync: false,
    };
  }

  let flatAligned: WordTimestamp[] = [];
  let hasRealAudioSync = false;

  if (hasWhisper) {
    flatAligned = alignFullScriptWordsGlobally({
      scriptWords: flatWords,
      totalDurationSec: safeTotal,
      whisperWords: options?.whisperWords,
      speechIntervals: options?.speechIntervals,
    });
    hasRealAudioSync = true;
  } else if (
    geminiHints.length > 0 &&
    clips.every((c, idx) => sceneWordArrays[idx].length === 0 || hintByScene.has(c.sceneNumber))
  ) {
    const intervals = options?.speechIntervals || [];
    for (let i = 0; i < clips.length; i++) {
      const words = sceneWordArrays[i];
      if (words.length === 0) continue;
      const hint = hintByScene.get(clips[i].sceneNumber)!;
      const clippedIntervals = intervals
        .map((iv) => ({
          startSec: Math.max(hint.startSec, iv.startSec),
          endSec: Math.min(hint.endSec, iv.endSec),
        }))
        .filter((iv) => iv.endSec > iv.startSec + 0.05);
      const sceneWords = distributeWordsAcrossSpeechIntervals(
        words,
        clippedIntervals,
        hint.startSec,
        hint.endSec
      );
      flatAligned.push(...sceneWords);
    }
    hasRealAudioSync = true;
  } else if (hasSpeechIntervals) {
    flatAligned = alignFullScriptWordsGlobally({
      scriptWords: flatWords,
      totalDurationSec: safeTotal,
      speechIntervals: options?.speechIntervals,
    });
    hasRealAudioSync = true;
  }

  if (hasRealAudioSync && flatAligned.length === flatWords.length) {
    const wordTimingsByScene: WordTimestamp[][] = [];
    let offset = 0;
    for (const words of sceneWordArrays) {
      wordTimingsByScene.push(flatAligned.slice(offset, offset + words.length));
      offset += words.length;
    }

    // Derive scene visual cut boundaries directly from aligned word starts
    const nonEmptyIndices = wordTimingsByScene
      .map((arr, idx) => (arr.length > 0 ? idx : -1))
      .filter((idx) => idx >= 0);

    if (nonEmptyIndices.length > 0) {
      // Build strictly monotonic exact scene start boundaries directly from aligned word starts
      // with ZERO proportional rescaling, so visual cuts land on the exact spoken word timestamp.
      const minGap = Math.min(0.25, safeTotal / Math.max(2, clips.length * 2));
      const sceneStarts = new Array<number>(clips.length + 1).fill(-1);
      sceneStarts[0] = 0;
      sceneStarts[clips.length] = safeTotal;

      for (let k = 1; k < nonEmptyIndices.length; k++) {
        const idx = nonEmptyIndices[k];
        const rawStart = wordTimingsByScene[idx][0].startSec;
        const maxRemainingScenes = clips.length - idx;
        const upperBound = Math.max(0, safeTotal - maxRemainingScenes * minGap);
        sceneStarts[idx] = Math.max(minGap, Math.min(upperBound, rawStart));
      }

      // Fill any rare empty-subtitle scenes cleanly between neighboring anchored boundaries
      let prevAnchor = 0;
      for (let i = 1; i <= clips.length; i++) {
        if (sceneStarts[i] >= 0) {
          const span = i - prevAnchor;
          if (span > 1) {
            const startVal = sceneStarts[prevAnchor];
            const endVal = Math.max(startVal + span * minGap, sceneStarts[i]);
            for (let m = prevAnchor + 1; m < i; m++) {
              sceneStarts[m] = startVal + ((endVal - startVal) * (m - prevAnchor)) / span;
            }
          }
          prevAnchor = i;
        }
      }

      // Enforce strict monotonicity without altering well-spaced spoken anchors
      for (let i = 1; i < clips.length; i++) {
        const lower = sceneStarts[i - 1] + minGap;
        const upper = safeTotal - (clips.length - i) * minGap;
        sceneStarts[i] = Math.min(upper, Math.max(lower, sceneStarts[i]));
      }

      const calibratedClips = clips.map((clip, idx) => ({
        ...clip,
        durationSec: Math.max(minGap, sceneStarts[idx + 1] - sceneStarts[idx]),
      }));
      return {
        clips: calibratedClips,
        wordTimingsByScene,
        hasRealAudioSync: true,
      };
    }
  }

  // Pure proportional fallback (no Whisper/Gemini/silence metadata supplied)
  const scaled = calibrateClipDurations(clips, safeTotal);
  const wordTimingsByScene: WordTimestamp[][] = [];
  let cursorSec = 0;
  for (let i = 0; i < scaled.length; i++) {
    const words = sceneWordArrays[i];
    const dur = scaled[i].durationSec;
    if (words.length === 0) {
      wordTimingsByScene.push([]);
      cursorSec += dur;
      continue;
    }
    const totalChars = words.reduce((acc, w) => acc + Math.max(2, w.length), 0);
    let innerCursor = cursorSec;
    const mapped = words.map((word, wi) => {
      const slice = (Math.max(2, word.length) / totalChars) * dur;
      const s = innerCursor;
      const e = wi === words.length - 1 ? cursorSec + dur : innerCursor + slice;
      innerCursor += slice;
      return { word, startSec: s, endSec: Math.max(s + 0.08, e) };
    });
    wordTimingsByScene.push(mapped);
    cursorSec += dur;
  }

  return {
    clips: scaled,
    wordTimingsByScene,
    hasRealAudioSync: false,
  };
}

/**
 * Generates synchronized phrase-level SRT subtitles from audio-aligned word timings.
 */
export function buildSynchronizedSrt(
  clips: TimelineSceneClip[],
  options?: {
    totalDurationSec?: number;
    whisperWords?: WordTimestamp[];
    speechIntervals?: AudioSpeechInterval[];
    geminiSceneTimings?: SceneTimingHint[];
  }
): string {
  const totalDur =
    options?.totalDurationSec ??
    clips.reduce((acc, c) => acc + Math.max(0.5, c.durationSec), 0);
  const aligned = buildUnifiedAlignedTimeline(clips, totalDur, options);

  const entries: string[] = [];
  let index = 1;

  for (let sceneIdx = 0; sceneIdx < aligned.clips.length; sceneIdx++) {
    const cleanSubtitle = sanitizeSpokenNarration(aligned.clips[sceneIdx].subtitleText || '');
    const chunks = splitCaptionChunks(cleanSubtitle, 5);
    const sceneWords = aligned.wordTimingsByScene[sceneIdx] || [];
    if (chunks.length === 0 || sceneWords.length === 0) continue;

    let wordCursor = 0;
    for (let ci = 0; ci < chunks.length; ci++) {
      const chunkWordsCount = chunks[ci].split(/\s+/).filter(Boolean).length;
      const sliceWords = sceneWords.slice(wordCursor, wordCursor + chunkWordsCount);
      wordCursor += chunkWordsCount;
      if (sliceWords.length === 0) continue;

      const start = sliceWords[0].startSec;
      const rawEnd = sliceWords[sliceWords.length - 1].endSec;
      const end = Math.max(start + 0.25, rawEnd);
      entries.push(`${index}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${chunks[ci]}\n`);
      index++;
    }
  }

  return entries.join('\n');
}

export function normalizeSubtitlePreset(raw?: string | null): SubtitlePresetId {
  switch ((raw || '').trim().toLowerCase()) {
    case 'mrbeast':
    case 'bold_shorts':
      return 'mrbeast';
    case 'hormozi':
      return 'hormozi';
    case 'neon_glow':
    case 'neon':
      return 'neon_glow';
    case 'cinematic_gold':
    case 'gold':
      return 'cinematic_gold';
    case 'classic':
    case 'classic_clean':
    case 'minimal':
      return 'classic';
    default:
      return 'mrbeast';
  }
}

interface ResolvedAssPreset {
  preset: SubtitlePresetId;
  primaryHex: string;
  highlightColorsHex: string[];
  outlineHex: string;
  backAss: string;
  borderStyle: 1 | 3;
  fontMultiplier: number;
  outlineMultiplier: number;
  shadowMultiplier: number;
  uppercaseLatin: boolean;
  wordPopScale: number;
  maxWordsVertical: number;
  maxWordsHorizontal: number;
  dynamicWordHighlight: boolean;
}

function resolveAssPreset(style: SubtitleStyleConfig): ResolvedAssPreset {
  const preset = normalizeSubtitlePreset(style.preset);
  switch (preset) {
    case 'mrbeast':
      return {
        preset,
        primaryHex: '#FFFFFF',
        highlightColorsHex: ['#FFE600', '#FF5500'],
        outlineHex: '#000000',
        backAss: '&H90000000',
        borderStyle: 1,
        fontMultiplier: 1.18,
        outlineMultiplier: 0.125,
        shadowMultiplier: 0.08,
        uppercaseLatin: true,
        wordPopScale: 112,
        maxWordsVertical: 3,
        maxWordsHorizontal: 4,
        dynamicWordHighlight: true,
      };
    case 'hormozi':
      return {
        preset,
        primaryHex: '#FFFFFF',
        highlightColorsHex: ['#39FF14', '#FFD700', '#00E5FF'],
        outlineHex: '#0A0A0A',
        backAss: '&HA0000000',
        borderStyle: 1,
        fontMultiplier: 1.15,
        outlineMultiplier: 0.115,
        shadowMultiplier: 0.075,
        uppercaseLatin: true,
        wordPopScale: 110,
        maxWordsVertical: 3,
        maxWordsHorizontal: 4,
        dynamicWordHighlight: true,
      };
    case 'neon_glow':
      return {
        preset,
        primaryHex: '#F8FAFC',
        highlightColorsHex: ['#00F0FF', '#FF2E97'],
        outlineHex: '#0D0B26',
        backAss: '&H88140C2E',
        borderStyle: 1,
        fontMultiplier: 1.1,
        outlineMultiplier: 0.11,
        shadowMultiplier: 0.09,
        uppercaseLatin: true,
        wordPopScale: 108,
        maxWordsVertical: 3,
        maxWordsHorizontal: 5,
        dynamicWordHighlight: true,
      };
    case 'cinematic_gold':
      return {
        preset,
        primaryHex: '#FFF8E7',
        highlightColorsHex: ['#FFB703'],
        outlineHex: '#000000',
        backAss: '&H99090D14',
        borderStyle: 3,
        fontMultiplier: 1.0,
        outlineMultiplier: 0.08,
        shadowMultiplier: 0.0,
        uppercaseLatin: false,
        wordPopScale: 104,
        maxWordsVertical: 4,
        maxWordsHorizontal: 6,
        dynamicWordHighlight: true,
      };
    case 'classic':
    default:
      return {
        preset: 'classic',
        primaryHex: style.primaryColor || '#FFFFFF',
        highlightColorsHex: [style.highlightColor || '#FFD43B'],
        outlineHex: style.outlineColor || '#000000',
        backAss: '&H78000000',
        borderStyle: 1,
        fontMultiplier: 1.0,
        outlineMultiplier: 0.085,
        shadowMultiplier: 0.04,
        uppercaseLatin: false,
        wordPopScale: 100,
        maxWordsVertical: 4,
        maxWordsHorizontal: 6,
        dynamicWordHighlight: false,
      };
  }
}

function sanitizeAssWord(word: string, uppercaseLatin: boolean): string {
  const cleaned = word.replace(/\\/g, '').replace(/[{}]/g, '').replace(/\r?\n/g, ' ').trim();
  if (!cleaned) return '';
  // Preserve Devanagari/non-Latin scripts untouched while uppercasing Latin/Hinglish punch words
  const hasNonLatin = /[^\x00-\x7F]/.test(cleaned);
  return uppercaseLatin && !hasNonLatin ? cleaned.toUpperCase() : cleaned;
}

export function normalizeEditingPace(raw?: string | null): EditingPacePreset {
  switch ((raw || '').trim().toLowerCase()) {
    case 'balanced':
    case 'normal':
      return 'balanced';
    case 'cinematic':
    case 'slow':
      return 'cinematic';
    case 'viral_fast':
    case 'fast':
    default:
      return 'viral_fast';
  }
}

export function normalizeColorGrade(raw?: string | null): ColorGradePreset {
  switch ((raw || '').trim().toLowerCase()) {
    case 'dark_moody':
    case 'dark':
    case 'moody':
      return 'dark_moody';
    case 'teal_orange':
    case 'cinematic':
      return 'teal_orange';
    case 'clean':
    case 'natural':
      return 'clean';
    case 'vibrant':
    default:
      return 'vibrant';
  }
}

export function buildColorGradeFilter(grade: ColorGradePreset): string {
  switch (grade) {
    case 'dark_moody':
      return 'eq=contrast=1.14:saturation=0.92:brightness=-0.02,colorbalance=bs=0.06:ms=-0.02:hs=-0.04,unsharp=5:5:0.45:5:5:0.0,vignette=PI/4.8';
    case 'teal_orange':
      return 'colorbalance=rs=-0.06:gs=0.02:bs=0.08:rh=0.09:gh=0.02:bh=-0.07,eq=contrast=1.10:saturation=1.15,unsharp=5:5:0.40:5:5:0.0,vignette=PI/6';
    case 'clean':
      return 'eq=contrast=1.04:saturation=1.07,unsharp=3:3:0.30:3:3:0.0';
    case 'vibrant':
    default:
      return 'eq=contrast=1.09:saturation=1.20:brightness=0.01,unsharp=5:5:0.45:5:5:0.0,vignette=PI/6';
  }
}

/**
 * Generates an Advanced SubStation Alpha (.ass) subtitle file with explicit PlayResX/PlayResY
 * matching the output video dimensions, optional Whisper word-level audio alignment,
 * optional 0-3s top-safe Hook Banner, and viral word-by-word color highlighting.
 */
export function buildSynchronizedAss(
  clips: TimelineSceneClip[],
  width: number,
  height: number,
  style: SubtitleStyleConfig,
  options?: {
    totalDurationSec?: number;
    whisperWords?: WordTimestamp[];
    speechIntervals?: AudioSpeechInterval[];
    geminiSceneTimings?: SceneTimingHint[];
    hookBannerText?: string | null;
  }
): string {
  const isVertical = height > width;
  const isSquare = Math.abs(height - width) < 40;
  const resolved = resolveAssPreset(style);

  // Responsive readable font size scaled directly to actual video resolution
  const baseFontSize = isVertical
    ? Math.round(width * 0.058)
    : isSquare
      ? Math.round(width * 0.052)
      : Math.round(height * 0.056);
  const scaleFactor = Math.max(0.75, Math.min(1.25, (style.fontSize || 44) / 44));
  const fontSize = Math.max(
    26,
    Math.min(92, Math.round(baseFontSize * scaleFactor * resolved.fontMultiplier))
  );

  const alignment =
    style.position === 'center' ? 5 : style.position === 'top_safe' ? 8 : 2;

  // Bottom-safe lower-third positioning: 16% from bottom on 9:16 (clears YouTube Shorts UI), 8% on 16:9
  const marginV =
    style.position === 'center'
      ? 0
      : style.position === 'top_safe'
        ? Math.round(height * 0.12)
        : isVertical
          ? Math.round(height * 0.16)
          : isSquare
            ? Math.round(height * 0.1)
            : Math.round(height * 0.08);

  const marginH = Math.round(width * 0.075);
  const outlinePx = Math.max(2, Math.round(fontSize * resolved.outlineMultiplier));
  const shadowPx =
    resolved.shadowMultiplier > 0 ? Math.max(1, Math.round(fontSize * resolved.shadowMultiplier)) : 0;

  const primaryAss = hexToAssColor(resolved.primaryHex, '00');
  const outlineAss = hexToAssColor(resolved.outlineHex, '00');
  const highlightAssList = resolved.highlightColorsHex.map((hex) => hexToAssColor(hex, '00'));

  const hookFontSize = Math.max(22, Math.round(fontSize * 0.62));
  const hookMarginV = isVertical ? Math.round(height * 0.08) : Math.round(height * 0.06);

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'ScaledBorderAndShadow: yes',
    'WrapStyle: 2',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,Noto Sans,${fontSize},${primaryAss},${highlightAssList[0]},${outlineAss},${resolved.backAss},-1,0,0,0,100,100,0,0,${resolved.borderStyle},${outlinePx},${shadowPx},${alignment},${marginH},${marginH},${marginV},1`,
    `Style: HookBanner,Noto Sans,${hookFontSize},&H0000E6FF,&H00FFFFFF,&H00000000,&HB0090D16,-1,0,0,0,100,100,0,0,3,${Math.max(2, Math.round(hookFontSize * 0.14))},0,8,${marginH},${marginH},${hookMarginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const maxWords = isVertical ? resolved.maxWordsVertical : resolved.maxWordsHorizontal;
  const dialogueLines: string[] = [];

  const cleanBanner = sanitizeSpokenNarration(options?.hookBannerText || '')
    .replace(/[{}\\]/g, '')
    .trim();
  if (cleanBanner) {
    const bannerOut = (/[^\x00-\x7F]/.test(cleanBanner) ? cleanBanner : cleanBanner.toUpperCase()).slice(0, 56);
    dialogueLines.push(
      `Dialogue: 1,0:00:00.00,0:00:03.10,HookBanner,,0,0,0,,{\\fad(120,220)}${bannerOut}`
    );
  }

  const totalDur =
    options?.totalDurationSec ??
    clips.reduce((acc, c) => acc + Math.max(0.5, c.durationSec), 0);
  const aligned = buildUnifiedAlignedTimeline(clips, totalDur, {
    whisperWords: options?.whisperWords,
    speechIntervals: options?.speechIntervals,
    geminiSceneTimings: options?.geminiSceneTimings,
  });

  let globalWordIdx = 0;

  for (let sceneIdx = 0; sceneIdx < aligned.clips.length; sceneIdx++) {
    const cleanSubtitle = sanitizeSpokenNarration(aligned.clips[sceneIdx].subtitleText || '');
    const chunks = splitCaptionChunks(cleanSubtitle, maxWords);
    const sceneWordTimings = aligned.wordTimingsByScene[sceneIdx] || [];
    if (chunks.length === 0 || sceneWordTimings.length === 0) continue;

    let wordOffset = 0;
    for (let ci = 0; ci < chunks.length; ci++) {
      const rawChunkWords = chunks[ci].split(/\s+/).filter(Boolean);
      const alignedChunkSlice = sceneWordTimings.slice(wordOffset, wordOffset + rawChunkWords.length);
      wordOffset += rawChunkWords.length;

      const chunkWords: string[] = [];
      const chunkTimings: WordTimestamp[] = [];
      for (let wi = 0; wi < rawChunkWords.length; wi++) {
        const sanitized = sanitizeAssWord(rawChunkWords[wi], resolved.uppercaseLatin);
        if (!sanitized) continue;
        chunkWords.push(sanitized);
        if (alignedChunkSlice[wi]) {
          chunkTimings.push(alignedChunkSlice[wi]);
        }
      }

      if (chunkWords.length === 0 || chunkTimings.length === 0) continue;

      const chunkStart = chunkTimings[0].startSec;
      const chunkEnd = Math.max(chunkStart + 0.24, chunkTimings[chunkTimings.length - 1].endSec);

      if (!resolved.dynamicWordHighlight || chunkWords.length === 1) {
        const textOut =
          resolved.dynamicWordHighlight && chunkWords.length === 1
            ? `{\\c${highlightAssList[globalWordIdx % highlightAssList.length]}&\\fscx${resolved.wordPopScale}\\fscy${resolved.wordPopScale}}${chunkWords[0]}{\\r}`
            : chunkWords.join(' ');
        dialogueLines.push(
          `Dialogue: 0,${formatAssTime(chunkStart)},${formatAssTime(chunkEnd)},Default,,0,0,0,,${textOut}`
        );
        globalWordIdx += chunkWords.length;
        continue;
      }

      for (let wi = 0; wi < chunkWords.length; wi++) {
        const timing = chunkTimings[Math.min(wi, chunkTimings.length - 1)];
        const wStart = timing.startSec;
        const nextTiming = wi + 1 < chunkWords.length ? chunkTimings[Math.min(wi + 1, chunkTimings.length - 1)] : null;
        const wEnd =
          nextTiming && nextTiming.startSec > wStart + 0.05
            ? nextTiming.startSec
            : Math.max(wStart + 0.1, timing.endSec);

        const hlColor = highlightAssList[(globalWordIdx + wi) % highlightAssList.length];
        const popTag =
          resolved.wordPopScale > 100
            ? `\\fscx${resolved.wordPopScale}\\fscy${resolved.wordPopScale}`
            : '';

        const renderedLine = chunkWords
          .map((w, idx) => (idx === wi ? `{\\c${hlColor}&${popTag}}${w}{\\r}` : w))
          .join(' ');

        dialogueLines.push(
          `Dialogue: 0,${formatAssTime(wStart)},${formatAssTime(wEnd)},Default,,0,0,0,,${renderedLine}`
        );
      }

      globalWordIdx += chunkWords.length;
    }
  }

  return [...header, ...dialogueLines, ''].join('\n');
}

function hexToAssColor(hex: string, alphaHex = '00'): string {
  const clean = hex.replace('#', '').trim();
  if (/^[0-9a-fA-F]{6}$/.test(clean)) {
    const r = clean.slice(0, 2).toUpperCase();
    const g = clean.slice(2, 4).toUpperCase();
    const b = clean.slice(4, 6).toUpperCase();
    return `&H${alphaHex}${b}${g}${r}`;
  }
  return `&H${alphaHex}FFFFFF`;
}

function formatAssTime(totalSec: number): string {
  const clamped = Math.max(0, totalSec);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const seconds = Math.floor(clamped % 60);
  const cs = Math.min(99, Math.round((clamped - Math.floor(clamped)) * 100));
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function formatSrtTime(totalSec: number): string {
  const clamped = Math.max(0, totalSec);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const seconds = Math.floor(clamped % 60);
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(
    seconds
  ).padStart(2, '0')},${String(Math.min(999, ms)).padStart(3, '0')}`;
}

function isLowMemoryRenderEnv(): boolean {
  if (process.env.HIGH_MEMORY_WORKER === 'true') return false;
  if (process.env.LOW_MEMORY_RENDER === 'true') return true;
  // Render Free / Starter web containers default to 512 MB RAM
  return process.env.RENDER === 'true';
}

/**
 * Renders the complete video using FFmpeg via execFile (never shell interpolation):
 * 1. Calibrates scene durations proportionally by spoken word weight to lock voiceover sync
 * 2. Normalizes each clip (smooth continuous Ken Burns for images, subtle transition fades for video)
 * 3. Concatenates normalized clips
 * 4. Mixes narration + optional ducked background music + resolution-accurate ASS subtitles
 * 5. Runs ffprobe quality verification on the output MP4
 */
export async function renderVideoWithFfmpeg(
  req: RenderVideoRequest
): Promise<RenderVideoOutput> {
  const lowMem = isLowMemoryRenderEnv();
  const effectiveQuality: '720p' | '1080p' = lowMem ? '720p' : req.qualityPreset;
  const { width, height } = resolveOutputDimensions(req.format, effectiveQuality);
  // Smooth 30fps even on Render Starter containers; use 'superfast' for visibly cleaner frames
  const fps = 30;
  const x264Preset = lowMem ? 'superfast' : 'veryfast';
  const threadFlags = lowMem
    ? ['-threads', '1', '-filter_threads', '1', '-filter_complex_threads', '1']
    : ['-threads', '2'];
  const x264MemParams = lowMem
    ? ['-x264-params', 'rc-lookahead=8:ref=1:bframes=0:sync-lookahead=0:threads=1', '-bufsize', '2M']
    : ['-x264-params', 'rc-lookahead=20:threads=2'];

  const pace = normalizeEditingPace(req.editingPace);
  const colorGrade = normalizeColorGrade(req.colorGrade);
  const gradeFilter = buildColorGradeFilter(colorGrade);

  const targetTotal = Math.max(req.totalNarrationDurationSec, 5);
  const alignOpts = {
    totalDurationSec: targetTotal,
    whisperWords: req.whisperWords,
    speechIntervals: req.speechIntervals,
    geminiSceneTimings: req.geminiSceneTimings,
    hookBannerText: req.hookBannerText,
  };
  const unified = buildUnifiedAlignedTimeline(req.clips, targetTotal, alignOpts);
  const scaledClips = unified.clips;

  // 1. Write synchronized SRT (for export) and resolution-accurate ASS (globally locked to real audio timestamps)
  const srtPath = resolveConfinedPath(req.workDir, 'subtitles.srt');
  const assPath = resolveConfinedPath(req.workDir, 'subtitles.ass');
  const srtContent = buildSynchronizedSrt(scaledClips, alignOpts);
  const assContent = buildSynchronizedAss(scaledClips, width, height, req.subtitleStyle, alignOpts);
  await Promise.all([
    fs.writeFile(srtPath, srtContent, 'utf8'),
    fs.writeFile(assPath, assContent, 'utf8'),
  ]);

  // 2. Normalize every scene clip with cumulative frame-exact boundaries (zero rounding drift across scenes)
  const normalizedPaths: string[] = [];
  const sceneCutOffsetsSec: number[] = [];
  let timelineCursor = 0;
  let renderedFrames = 0;
  const totalTargetFrames = Math.max(scaledClips.length, Math.round(targetTotal * fps));

  for (let idx = 0; idx < scaledClips.length; idx++) {
    const clip = scaledClips[idx];
    if (idx > 0) {
      sceneCutOffsetsSec.push(renderedFrames / fps);
    }
    timelineCursor += clip.durationSec;

    const remainingClipsAfter = scaledClips.length - 1 - idx;
    const desiredEndFrame =
      idx === scaledClips.length - 1
        ? totalTargetFrames
        : Math.round(timelineCursor * fps);
    const targetEndFrame = Math.max(
      renderedFrames + 1,
      Math.min(totalTargetFrames - remainingClipsAfter, desiredEndFrame)
    );
    const clipFrames = Math.max(1, targetEndFrame - renderedFrames);
    const exactClipDurationSec = clipFrames / fps;
    renderedFrames = targetEndFrame;

    const outSegment = resolveConfinedPath(
      req.workDir,
      `seg_${String(clip.sceneNumber).padStart(3, '0')}.mp4`
    );

    const transitionLower = (clip.transition || '').toLowerCase();
    const useSubtleWhiteFlash =
      pace === 'viral_fast' && idx > 0 && (transitionLower === 'flash' || idx % 3 === 0);
    const useCinematicFade = pace === 'cinematic';
    const fadeDur = useCinematicFade ? Math.min(0.18, exactClipDurationSec * 0.1) : 0;

    if (clip.mediaType === 'image') {
      const frames = clipFrames;
      // Keep zoompan source frame close to output size to stay well under 512 MB RAM
      const zpW = Math.ceil((width * 1.18) / 2) * 2;
      const zpH = Math.ceil((height * 1.18) / 2) * 2;
      // Snappy zoom-in / zoom-out punch on alternating image scenes
      const zoomRange = pace === 'viral_fast' ? '0.16' : '0.12';
      const zoomExpr =
        idx % 2 === 0
          ? `1.0+(${zoomRange}*on/${frames})`
          : `1.16-(${zoomRange}*on/${frames})`;
      const panXExpr =
        idx % 3 === 1
          ? `iw/2-(iw/zoom/2)+(on/${frames})*24-12`
          : `iw/2-(iw/zoom/2)`;
      const filters = [
        `scale=${zpW}:${zpH}:force_original_aspect_ratio=increase`,
        `crop=${zpW}:${zpH}`,
        `zoompan=z='${zoomExpr}':x='${panXExpr}':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${fps}`,
        gradeFilter,
      ];
      if (useSubtleWhiteFlash) {
        filters.push('fade=t=in:st=0:d=0.07:color=white@0.45');
      } else if (useCinematicFade && fadeDur > 0.04) {
        const fadeOutStart = Math.max(0, exactClipDurationSec - fadeDur);
        filters.push(`fade=t=in:st=0:d=${fadeDur.toFixed(2)}`, `fade=t=out:st=${fadeOutStart.toFixed(2)}:d=${fadeDur.toFixed(2)}`);
      }
      filters.push('format=yuv420p');

      await runFfmpeg([
        '-y',
        ...threadFlags,
        '-loop',
        '1',
        '-i',
        clip.localMediaPath,
        '-frames:v',
        String(clipFrames),
        '-vf',
        filters.join(','),
        '-c:v',
        'libx264',
        '-preset',
        x264Preset,
        '-crf',
        lowMem ? '23' : '21',
        ...x264MemParams,
        '-video_track_timescale',
        '90000',
        '-max_muxing_queue_size',
        '256',
        '-an',
        outSegment,
      ]);
    } else {
      const durSafe = Math.max(0.25, exactClipDurationSec).toFixed(3);
      // Dynamic punch-zoom motion on video clips as well so static shots feel high-energy
      const zoomDelta = pace === 'viral_fast' ? 0.08 : 0.05;
      const zoomScaleExpr =
        idx % 2 === 0
          ? `1.0+${zoomDelta}*min(1\\,t/${durSafe})`
          : `${(1.0 + zoomDelta).toFixed(2)}-${zoomDelta}*min(1\\,t/${durSafe})`;

      const filters = [
        `scale=${width}:${height}:force_original_aspect_ratio=increase`,
        `crop=${width}:${height}`,
        `fps=${fps}`,
        'setpts=PTS-STARTPTS',
        `scale=w='trunc(${width}*(${zoomScaleExpr})/2)*2':h='trunc(${height}*(${zoomScaleExpr})/2)*2':eval=frame`,
        `crop=${width}:${height}:'(iw-ow)/2':'(ih-oh)/2'`,
        gradeFilter,
      ];
      if (useSubtleWhiteFlash) {
        filters.push('fade=t=in:st=0:d=0.07:color=white@0.45');
      } else if (useCinematicFade && fadeDur > 0.04) {
        const fadeOutStart = Math.max(0, exactClipDurationSec - fadeDur);
        filters.push(`fade=t=in:st=0:d=${fadeDur.toFixed(2)}`, `fade=t=out:st=${fadeOutStart.toFixed(2)}:d=${fadeDur.toFixed(2)}`);
      }
      filters.push('format=yuv420p');

      await runFfmpeg([
        '-y',
        ...threadFlags,
        '-stream_loop',
        '-1',
        '-i',
        clip.localMediaPath,
        '-frames:v',
        String(clipFrames),
        '-vf',
        filters.join(','),
        '-c:v',
        'libx264',
        '-preset',
        x264Preset,
        '-crf',
        lowMem ? '23' : '21',
        ...x264MemParams,
        '-video_track_timescale',
        '90000',
        '-max_muxing_queue_size',
        '256',
        '-an',
        outSegment,
      ]);
    }

    normalizedPaths.push(outSegment);
  }

  // 3. Concatenate normalized video segments via concat demuxer (zero re-encode, near-zero RAM)
  const concatListPath = resolveConfinedPath(req.workDir, 'concat_list.txt');
  const concatBody = normalizedPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  await fs.writeFile(concatListPath, concatBody, 'utf8');

  const stitchedVideoPath = resolveConfinedPath(req.workDir, 'stitched_video.mp4');
  await runFfmpeg([
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    concatListPath,
    '-c',
    'copy',
    stitchedVideoPath,
  ]);

  // Free disk/page-cache pressure from intermediate segment files right away
  await Promise.all(normalizedPaths.map((p) => fs.rm(p, { force: true }).catch(() => undefined)));

  // 4. Final pass: burn resolution-accurate ASS subtitles + mix narration + ducked BGM + transition SFX
  // Pre-mix hook boom + transition whooshes into one clean stereo WAV so the main video pass stays simple & low-RAM
  const sfxActive = req.sfxEnabled !== false;
  const validBoomPath =
    sfxActive && req.hookBoomPath && (await probeHasAudioStream(req.hookBoomPath))
      ? req.hookBoomPath
      : null;
  const validWhooshPath =
    sfxActive &&
    req.whooshPath &&
    sceneCutOffsetsSec.length > 0 &&
    (await probeHasAudioStream(req.whooshPath))
      ? req.whooshPath
      : null;
  const mixedSfxPath =
    validBoomPath || validWhooshPath
      ? await buildMixedSfxTrack({
          workDir: req.workDir,
          boomPath: validBoomPath,
          whooshPath: validWhooshPath,
          sceneCutOffsetsSec,
          totalDurationSec: targetTotal,
        })
      : null;

  const hasValidMusic = req.backgroundMusicPath
    ? await probeHasAudioStream(req.backgroundMusicPath)
    : false;
  const hasValidSfx = mixedSfxPath ? await probeHasAudioStream(mixedSfxPath) : false;

  const finalVideoPath = resolveConfinedPath(req.workDir, 'final_output.mp4');
  const buildFinalPassArgs = (includeExtras: boolean): string[] => {
    const args: string[] = [
      '-y',
      ...threadFlags,
      '-i',
      stitchedVideoPath,
      '-i',
      req.narrationAudioPath,
    ];

    let nextInputIdx = 2;
    let musicInputIdx: number | null = null;
    let sfxInputIdx: number | null = null;

    if (includeExtras && hasValidMusic && req.backgroundMusicPath) {
      args.push('-stream_loop', '-1', '-i', req.backgroundMusicPath);
      musicInputIdx = nextInputIdx++;
    }
    if (includeExtras && hasValidSfx && mixedSfxPath) {
      args.push('-i', mixedSfxPath);
      sfxInputIdx = nextInputIdx++;
    }

    const filterParts: string[] = [];
    let videoMap = '0:v';
    const burnSubtitles =
      req.subtitleStyle.enabled &&
      req.subtitleStyle.burnIn &&
      (srtContent.trim().length > 0 || Boolean(req.hookBannerText));

    if (burnSubtitles) {
      const escapedAss = assPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
      filterParts.push(`[0:v]ass='${escapedAss}'[vout]`);
      videoMap = '[vout]';
    }

    const audioFmt = 'aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo';
    const narVol = req.narrationVolume ?? 1.05;
    const useDucking = musicInputIdx !== null && req.duckingEnabled !== false;
    const audioLayers: string[] = ['[nar]'];
    // FFmpeg filtergraph pads can only be consumed once: split [nar] and re-pin fltp/stereo before sidechaincompress
    filterParts.push(
      useDucking
        ? `[1:a]${audioFmt},volume=${narVol},dynaudnorm=f=150:g=15,asplit=2[nar][nar_pre];[nar_pre]${audioFmt}[nar_sc]`
        : `[1:a]${audioFmt},volume=${narVol},dynaudnorm=f=150:g=15[nar]`
    );

    if (musicInputIdx !== null) {
      const musVol = req.musicVolume ?? 0.16;
      const fadeOutStart = Math.max(0, targetTotal - 2);
      if (useDucking) {
        filterParts.push(
          `[${musicInputIdx}:a]${audioFmt},volume=${musVol},afade=t=in:st=0:d=1.2,afade=t=out:st=${fadeOutStart.toFixed(
            2
          )}:d=2[mus]`,
          `[mus][nar_sc]sidechaincompress=threshold=0.025:ratio=6:attack=20:release=240[ducked]`
        );
        audioLayers.push('[ducked]');
      } else {
        filterParts.push(
          `[${musicInputIdx}:a]${audioFmt},volume=${musVol},afade=t=in:st=0:d=1.2,afade=t=out:st=${fadeOutStart.toFixed(
            2
          )}:d=2[mus]`
        );
        audioLayers.push('[mus]');
      }
    }

    if (sfxInputIdx !== null) {
      filterParts.push(`[${sfxInputIdx}:a]${audioFmt}[sfx]`);
      audioLayers.push('[sfx]');
    }

    let audioMap = '[nar]';
    if (audioLayers.length > 1) {
      filterParts.push(
        `${audioLayers.join('')}amix=inputs=${audioLayers.length}:duration=first:normalize=0:dropout_transition=2[aout]`
      );
      audioMap = '[aout]';
    }

    if (filterParts.length > 0) {
      args.push('-filter_complex', filterParts.join(';'));
    }

    args.push('-map', videoMap, '-map', audioMap);

    if (burnSubtitles) {
      args.push(
        '-c:v',
        'libx264',
        '-preset',
        x264Preset,
        '-crf',
        lowMem ? '23' : '21',
        ...x264MemParams,
        '-pix_fmt',
        'yuv420p'
      );
    } else {
      // Stream-copy video when subtitles are off (zero re-encode RAM)
      args.push('-c:v', 'copy');
    }

    args.push(
      '-c:a',
      'aac',
      '-b:a',
      lowMem ? '128k' : '192k',
      '-ar',
      '44100',
      '-max_muxing_queue_size',
      '256',
      '-movflags',
      '+faststart',
      '-shortest',
      finalVideoPath
    );
    return args;
  };

  try {
    await runFfmpeg(buildFinalPassArgs(true));
  } catch (err) {
    if (hasValidMusic || hasValidSfx) {
      await runFfmpeg(buildFinalPassArgs(false));
    } else {
      throw err;
    }
  }
  await fs.rm(stitchedVideoPath, { force: true }).catch(() => undefined);
  if (mixedSfxPath) {
    await fs.rm(mixedSfxPath, { force: true }).catch(() => undefined);
  }

  // 5. Quality check via ffprobe
  const stats = await fs.stat(finalVideoPath);
  const verifiedDuration = await verifyRenderedMp4(finalVideoPath);

  return {
    finalVideoPath,
    srtPath,
    width,
    height,
    durationSec: verifiedDuration,
    fileSizeBytes: stats.size,
  };
}

async function resolveThumbnailFontPath(text: string): Promise<string> {
  const hasDevanagari = /[\u0900-\u097F]/.test(text);
  const candidates = hasDevanagari
    ? [
        '/usr/share/fonts/truetype/noto/NotoSansDevanagari-Bold.ttf',
        '/usr/share/fonts/truetype/lohit-devanagari/Lohit-Devanagari.ttf',
        '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
      ]
    : [
        '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
      ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next installed font
    }
  }
  return '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
}

/**
 * Generates a YouTube-compliant 16:9 (1280x720) high-contrast thumbnail from the rendered video
 * with a dark cinematic bottom gradient and bold readable headline overlay.
 */
export async function generateThumbnailFromVideo(params: {
  workDir: string;
  videoPath: string;
  headlineText: string;
  seekSec?: number;
}): Promise<string> {
  const thumbPath = resolveConfinedPath(params.workDir, 'thumbnail_1280x720.jpg');
  const hasNonLatin = /[^\x00-\x7F]/.test(params.headlineText);
  const safeHeadline = sanitizeSpokenNarration(params.headlineText)
    .replace(/[':\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const formattedHeadline = (hasNonLatin ? safeHeadline : safeHeadline.toUpperCase()).slice(0, 36);
  const fontFile = await resolveThumbnailFontPath(formattedHeadline);
  const seekPos = Math.max(1.0, Math.min(6.0, params.seekSec ?? 2.4)).toFixed(2);

  // Two-tone stacked viral headline split on half of words for high CTR pop
  const headlineWords = formattedHeadline.split(' ').filter(Boolean);
  const mid = Math.ceil(headlineWords.length / 2);
  const topLine = headlineWords.slice(0, mid).join(' ');
  const bottomLine = headlineWords.slice(mid).join(' ');

  const textFilters = bottomLine
    ? [
        `drawtext=fontfile=${fontFile}:text='${topLine}':fontcolor=0xFFE600:fontsize=64:borderw=5:bordercolor=black:shadowcolor=black@0.85:shadowx=3:shadowy=4:x=(w-text_w)/2:y=505`,
        `drawtext=fontfile=${fontFile}:text='${bottomLine}':fontcolor=white:fontsize=66:borderw=5:bordercolor=black:shadowcolor=black@0.85:shadowx=3:shadowy=4:x=(w-text_w)/2:y=585`,
      ]
    : [
        `drawtext=fontfile=${fontFile}:text='${topLine}':fontcolor=0xFFE600:fontsize=68:borderw=5:bordercolor=black:shadowcolor=black@0.85:shadowx=3:shadowy=4:x=(w-text_w)/2:y=545`,
      ];

  const vf = [
    'scale=1280:720:force_original_aspect_ratio=increase',
    'crop=1280:720',
    'eq=contrast=1.22:saturation=1.28:brightness=-0.02',
    'unsharp=5:5:0.55:5:5:0.0',
    'vignette=PI/5',
    'drawbox=x=0:y=420:w=1280:h=300:color=black@0.38:t=fill',
    'drawbox=x=0:y=495:w=1280:h=225:color=black@0.65:t=fill',
    ...textFilters,
  ].join(',');

  await runFfmpeg([
    '-y',
    '-threads',
    '1',
    '-ss',
    seekPos,
    '-i',
    params.videoPath,
    '-frames:v',
    '1',
    '-vf',
    vf,
    '-q:v',
    '2',
    thumbPath,
  ]);

  return thumbPath;
}

export async function verifyRenderedMp4(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync(config.ffprobePath, [
    '-v',
    'error',
    '-show_entries',
    'format=duration:stream=codec_type',
    '-of',
    'json',
    filePath,
  ]);

  const parsed = JSON.parse(stdout) as {
    streams?: Array<{ codec_type?: string }>;
    format?: { duration?: string };
  };
  const streams = parsed.streams || [];
  const hasVideo = streams.some((s) => s.codec_type === 'video');
  const hasAudio = streams.some((s) => s.codec_type === 'audio');
  const duration = Number(parsed.format?.duration || 0);

  if (!hasVideo || !hasAudio || duration < 1) {
    throw new Error('Rendered MP4 failed quality check (missing video/audio stream or invalid duration).');
  }
  return duration;
}

async function probeHasAudioStream(filePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      config.ffprobePath,
      [
        '-v',
        'error',
        '-select_streams',
        'a',
        '-show_entries',
        'stream=codec_type',
        '-of',
        'json',
        filePath,
      ],
      { timeout: 8000 }
    );
    const parsed = JSON.parse(stdout) as { streams?: Array<{ codec_type?: string }> };
    return Boolean(parsed.streams && parsed.streams.length > 0);
  } catch {
    return false;
  }
}

async function buildMixedSfxTrack(params: {
  workDir: string;
  boomPath: string | null;
  whooshPath: string | null;
  sceneCutOffsetsSec: number[];
  totalDurationSec: number;
}): Promise<string | null> {
  const sfxOutPath = resolveConfinedPath(params.workDir, 'sfx_mixed.wav');
  const args: string[] = [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `anullsrc=r=44100:cl=stereo:d=${Math.max(1, params.totalDurationSec).toFixed(2)}`,
  ];
  const audioFmt = 'aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo';
  const filterParts: string[] = [`[0:a]${audioFmt}[base]`];
  const mixInputs: string[] = ['[base]'];
  let nextIdx = 1;

  if (params.boomPath) {
    args.push('-i', params.boomPath);
    filterParts.push(`[${nextIdx}:a]${audioFmt},volume=0.22[boom]`);
    mixInputs.push('[boom]');
    nextIdx++;
  }

  if (params.whooshPath && params.sceneCutOffsetsSec.length > 0) {
    const step = Math.max(1, Math.ceil(params.sceneCutOffsetsSec.length / 8));
    const chosenCuts = params.sceneCutOffsetsSec.filter((_, i) => i % step === 0).slice(0, 8);
    chosenCuts.forEach((sec, idx) => {
      args.push('-i', params.whooshPath!);
      const delayMs = Math.max(0, Math.round((sec - 0.08) * 1000));
      filterParts.push(`[${nextIdx}:a]${audioFmt},volume=0.18,adelay=${delayMs}|${delayMs}[w${idx}]`);
      mixInputs.push(`[w${idx}]`);
      nextIdx++;
    });
  }

  if (mixInputs.length <= 1) {
    return null;
  }

  filterParts.push(
    `${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=first:normalize=0[sfxout]`
  );

  try {
    await execFileAsync(
      config.ffmpegPath,
      [
        ...args,
        '-filter_complex',
        filterParts.join(';'),
        '-map',
        '[sfxout]',
        '-ac',
        '2',
        '-ar',
        '44100',
        sfxOutPath,
      ],
      { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 }
    );
    return sfxOutPath;
  } catch {
    return null;
  }
}

async function runFfmpeg(args: string[]): Promise<void> {
  try {
    await execFileAsync(config.ffmpegPath, args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
    });
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string })?.stderr || '';
    const errorLines = stderr
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /matches no streams|error|invalid|no such|conversion failed|unable to/i.test(l));
    const rawSnippet =
      errorLines.length > 0 ? errorLines.slice(-3).join(' | ') : stderr.slice(-480);
    const snippet =
      (rawSnippet.length > 480
        ? `${rawSnippet.slice(0, 220)} ... ${rawSnippet.slice(-240)}`
        : rawSnippet) ||
      (err instanceof Error ? err.message : 'FFmpeg error');
    throw new Error(`FFmpeg render failed: ${snippet}`);
  }
}
