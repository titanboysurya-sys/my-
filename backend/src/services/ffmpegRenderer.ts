import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import { config } from '../config/env.js';
import { resolveConfinedPath } from '../security/urlGuard.js';

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
  backgroundMusicPath?: string | null;
  musicVolume?: number;
  narrationVolume?: number;
  duckingEnabled?: boolean;
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
    if (!clean) return Math.max(1.5, clip.durationSec);
    const words = clean.split(/\s+/).filter(Boolean).length;
    const chars = clean.replace(/\s+/g, '').length;
    // Blend word & character count so both English and Devanagari/CJK pacing stay accurate
    return Math.max(1.5, words * 0.65 + (chars / 5) * 0.35);
  });

  const sumWeight = weights.reduce((a, b) => a + b, 0) || 1;
  const minSceneSec = Math.min(1.8, targetTotal / clips.length);

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

/**
 * Generates synchronized phrase-level SRT subtitles from scene durations & narration text.
 */
export function buildSynchronizedSrt(clips: TimelineSceneClip[]): string {
  const entries: string[] = [];
  let cursorSec = 0;
  let index = 1;

  for (const clip of clips) {
    const chunks = splitCaptionChunks(clip.subtitleText, 5);
    if (chunks.length === 0) {
      cursorSec += clip.durationSec;
      continue;
    }

    const totalChars = chunks.reduce((acc, c) => acc + Math.max(1, c.length), 0);
    for (const chunk of chunks) {
      const sliceSec = (Math.max(1, chunk.length) / totalChars) * clip.durationSec;
      const start = cursorSec;
      const end = cursorSec + Math.max(0.35, sliceSec - 0.03);
      entries.push(`${index}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${chunk}\n`);
      cursorSec += sliceSec;
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

/**
 * Generates an Advanced SubStation Alpha (.ass) subtitle file with explicit PlayResX/PlayResY
 * matching the output video dimensions and viral word-by-word color highlighting
 * (MrBeast, Hormozi, Neon Cyber, Cinematic Gold, Classic Clean).
 */
export function buildSynchronizedAss(
  clips: TimelineSceneClip[],
  width: number,
  height: number,
  style: SubtitleStyleConfig
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
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const maxWords = isVertical ? resolved.maxWordsVertical : resolved.maxWordsHorizontal;
  const dialogueLines: string[] = [];
  let cursorSec = 0;
  let globalWordIdx = 0;

  for (const clip of clips) {
    const chunks = splitCaptionChunks(clip.subtitleText, maxWords);
    if (chunks.length === 0) {
      cursorSec += clip.durationSec;
      continue;
    }

    const totalChars = chunks.reduce((acc, c) => acc + Math.max(1, c.length), 0);
    for (const chunk of chunks) {
      const sliceSec = (Math.max(1, chunk.length) / totalChars) * clip.durationSec;
      const chunkWords = chunk
        .split(/\s+/)
        .map((w) => sanitizeAssWord(w, resolved.uppercaseLatin))
        .filter(Boolean);

      if (chunkWords.length === 0) {
        cursorSec += sliceSec;
        continue;
      }

      if (!resolved.dynamicWordHighlight || chunkWords.length === 1) {
        const start = cursorSec;
        const end = cursorSec + Math.max(0.28, sliceSec - 0.02);
        const textOut =
          resolved.dynamicWordHighlight && chunkWords.length === 1
            ? `{\\c${highlightAssList[globalWordIdx % highlightAssList.length]}&\\fscx${resolved.wordPopScale}\\fscy${resolved.wordPopScale}}${chunkWords[0]}{\\r}`
            : chunkWords.join(' ');
        dialogueLines.push(
          `Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},Default,,0,0,0,,${textOut}`
        );
        globalWordIdx += chunkWords.length;
        cursorSec += sliceSec;
        continue;
      }

      // Word-by-word active color highlight (MrBeast / Hormozi / Neon / Gold)
      const wordCharTotal = chunkWords.reduce((acc, w) => acc + Math.max(2, w.length), 0);
      let wordCursor = cursorSec;
      const chunkEnd = cursorSec + sliceSec;

      for (let wi = 0; wi < chunkWords.length; wi++) {
        const wordDur = (Math.max(2, chunkWords[wi].length) / wordCharTotal) * sliceSec;
        const wStart = wordCursor;
        const wEnd = wi === chunkWords.length - 1 ? Math.max(wStart + 0.14, chunkEnd - 0.02) : wordCursor + wordDur;
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
        wordCursor += wordDur;
      }

      globalWordIdx += chunkWords.length;
      cursorSec += sliceSec;
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
  const fps = lowMem ? 24 : 30;
  const x264Preset = lowMem ? 'ultrafast' : 'veryfast';
  const threadFlags = lowMem
    ? ['-threads', '1', '-filter_threads', '1', '-filter_complex_threads', '1']
    : ['-threads', '2'];
  const x264MemParams = lowMem
    ? ['-x264-params', 'rc-lookahead=8:ref=1:bframes=0:sync-lookahead=0:threads=1', '-bufsize', '2M']
    : ['-x264-params', 'rc-lookahead=20:threads=2'];

  const targetTotal = Math.max(req.totalNarrationDurationSec, 5);
  const scaledClips = calibrateClipDurations(req.clips, targetTotal);

  // 1. Write synchronized SRT (for export) and resolution-accurate ASS (for burn-in)
  const srtPath = resolveConfinedPath(req.workDir, 'subtitles.srt');
  const assPath = resolveConfinedPath(req.workDir, 'subtitles.ass');
  const srtContent = buildSynchronizedSrt(scaledClips);
  const assContent = buildSynchronizedAss(scaledClips, width, height, req.subtitleStyle);
  await Promise.all([
    fs.writeFile(srtPath, srtContent, 'utf8'),
    fs.writeFile(assPath, assContent, 'utf8'),
  ]);

  // 2. Normalize every scene clip to consistent resolution, fps, yuv420p, smooth motion, and exact duration
  const normalizedPaths: string[] = [];
  for (let idx = 0; idx < scaledClips.length; idx++) {
    const clip = scaledClips[idx];
    const outSegment = resolveConfinedPath(
      req.workDir,
      `seg_${String(clip.sceneNumber).padStart(3, '0')}.mp4`
    );
    const fadeDur = Math.min(0.2, clip.durationSec * 0.12);
    const fadeOutStart = Math.max(0, clip.durationSec - fadeDur);

    if (clip.mediaType === 'image') {
      const frames = Math.max(fps, Math.round(clip.durationSec * fps));
      // Keep zoompan source frame close to output size (never 2x/4K) to stay well under 512 MB RAM
      const zpW = Math.ceil((width * 1.16) / 2) * 2;
      const zpH = Math.ceil((height * 1.16) / 2) * 2;
      // Alternate gentle zoom-in and zoom-out across the full clip duration so images never freeze
      const zoomExpr =
        idx % 2 === 0
          ? `1.0+(0.14*on/${frames})`
          : `1.14-(0.14*on/${frames})`;
      const vf = [
        `scale=${zpW}:${zpH}:force_original_aspect_ratio=increase`,
        `crop=${zpW}:${zpH}`,
        `zoompan=z='${zoomExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${fps}`,
        'eq=contrast=1.04:saturation=1.08',
        `fade=t=in:st=0:d=${fadeDur.toFixed(2)}`,
        `fade=t=out:st=${fadeOutStart.toFixed(2)}:d=${fadeDur.toFixed(2)}`,
        'format=yuv420p',
      ].join(',');

      await runFfmpeg([
        '-y',
        ...threadFlags,
        '-loop',
        '1',
        '-i',
        clip.localMediaPath,
        '-t',
        clip.durationSec.toFixed(2),
        '-vf',
        vf,
        '-c:v',
        'libx264',
        '-preset',
        x264Preset,
        '-crf',
        lowMem ? '25' : '23',
        ...x264MemParams,
        '-max_muxing_queue_size',
        '256',
        '-an',
        outSegment,
      ]);
    } else {
      const vf = [
        `scale=${width}:${height}:force_original_aspect_ratio=increase`,
        `crop=${width}:${height}`,
        `fps=${fps}`,
        'eq=contrast=1.03:saturation=1.06',
        `fade=t=in:st=0:d=${fadeDur.toFixed(2)}`,
        `fade=t=out:st=${fadeOutStart.toFixed(2)}:d=${fadeDur.toFixed(2)}`,
        'format=yuv420p',
      ].join(',');

      await runFfmpeg([
        '-y',
        ...threadFlags,
        '-stream_loop',
        '-1',
        '-i',
        clip.localMediaPath,
        '-t',
        clip.durationSec.toFixed(2),
        '-vf',
        vf,
        '-c:v',
        'libx264',
        '-preset',
        x264Preset,
        '-crf',
        lowMem ? '25' : '23',
        ...x264MemParams,
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

  // 4. Final pass: burn resolution-accurate ASS subtitles + mix narration & optional ducked music
  const finalVideoPath = resolveConfinedPath(req.workDir, 'final_output.mp4');
  const ffmpegArgs: string[] = [
    '-y',
    ...threadFlags,
    '-i',
    stitchedVideoPath,
    '-i',
    req.narrationAudioPath,
  ];

  const hasMusic = Boolean(req.backgroundMusicPath);
  if (hasMusic && req.backgroundMusicPath) {
    ffmpegArgs.push('-stream_loop', '-1', '-i', req.backgroundMusicPath);
  }

  const filterParts: string[] = [];
  let videoMap = '0:v';
  const burnSubtitles =
    req.subtitleStyle.enabled && req.subtitleStyle.burnIn && srtContent.trim().length > 0;

  if (burnSubtitles) {
    const escapedAss = assPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    filterParts.push(`[0:v]ass='${escapedAss}'[vout]`);
    videoMap = '[vout]';
  }

  const narVol = req.narrationVolume ?? 1.0;
  let audioMap = '1:a';
  if (hasMusic) {
    const musVol = req.musicVolume ?? 0.16;
    const fadeOutStart = Math.max(0, targetTotal - 2);
    if (req.duckingEnabled !== false) {
      filterParts.push(
        `[1:a]volume=${narVol},dynaudnorm=f=150:g=15[nar]`,
        `[2:a]volume=${musVol},afade=t=in:st=0:d=1.5,afade=t=out:st=${fadeOutStart.toFixed(
          2
        )}:d=2[mus]`,
        `[mus][nar]sidechaincompress=threshold=0.03:ratio=6:attack=25:release=250[ducked]`,
        `[nar][ducked]amix=inputs=2:duration=first:dropout_transition=2[aout]`
      );
    } else {
      filterParts.push(
        `[1:a]volume=${narVol},dynaudnorm=f=150:g=15[nar]`,
        `[2:a]volume=${musVol},afade=t=in:st=0:d=1.5,afade=t=out:st=${fadeOutStart.toFixed(
          2
        )}:d=2[mus]`,
        `[nar][mus]amix=inputs=2:duration=first:dropout_transition=2[aout]`
      );
    }
    audioMap = '[aout]';
  } else {
    // dynaudnorm uses far less RAM than two-pass loudnorm while keeping voice crisp
    filterParts.push(`[1:a]volume=${narVol},dynaudnorm=f=150:g=15[aout]`);
    audioMap = '[aout]';
  }

  if (filterParts.length > 0) {
    ffmpegArgs.push('-filter_complex', filterParts.join(';'));
  }

  ffmpegArgs.push('-map', videoMap, '-map', audioMap);

  if (burnSubtitles) {
    ffmpegArgs.push(
      '-c:v',
      'libx264',
      '-preset',
      x264Preset,
      '-crf',
      lowMem ? '25' : '22',
      ...x264MemParams,
      '-pix_fmt',
      'yuv420p'
    );
  } else {
    // Stream-copy video when subtitles are off (zero re-encode RAM)
    ffmpegArgs.push('-c:v', 'copy');
  }

  ffmpegArgs.push(
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

  await runFfmpeg(ffmpegArgs);
  await fs.rm(stitchedVideoPath, { force: true }).catch(() => undefined);

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
}): Promise<string> {
  const thumbPath = resolveConfinedPath(params.workDir, 'thumbnail_1280x720.jpg');
  const hasNonLatin = /[^\x00-\x7F]/.test(params.headlineText);
  const safeHeadline = params.headlineText
    .replace(/[':\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const formattedHeadline = (hasNonLatin ? safeHeadline : safeHeadline.toUpperCase()).slice(0, 36);
  const fontFile = await resolveThumbnailFontPath(formattedHeadline);

  const vf = [
    'scale=1280:720:force_original_aspect_ratio=increase',
    'crop=1280:720',
    'eq=contrast=1.15:saturation=1.22:brightness=-0.04',
    'drawbox=x=0:y=460:w=1280:h=260:color=black@0.62:t=fill',
    `drawtext=fontfile=${fontFile}:text='${formattedHeadline}':fontcolor=white:fontsize=62:borderw=4:bordercolor=black:x=(w-text_w)/2:y=555`,
  ].join(',');

  await runFfmpeg([
    '-y',
    '-threads',
    '1',
    '-ss',
    '00:00:02',
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

async function runFfmpeg(args: string[]): Promise<void> {
  try {
    await execFileAsync(config.ffmpegPath, args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
    });
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string })?.stderr || '';
    const snippet = stderr.slice(-400) || (err instanceof Error ? err.message : 'FFmpeg error');
    throw new Error(`FFmpeg render failed: ${snippet}`);
  }
}
