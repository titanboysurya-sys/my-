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

export interface SubtitleStyleConfig {
  enabled: boolean;
  burnIn: boolean;
  fontSize: number;
  primaryColor: string;
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
 * Generates synchronized phrase-level SRT subtitles from scene durations & narration text.
 */
export function buildSynchronizedSrt(clips: TimelineSceneClip[]): string {
  const entries: string[] = [];
  let cursorSec = 0;
  let index = 1;

  for (const clip of clips) {
    const words = clip.subtitleText.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      cursorSec += clip.durationSec;
      continue;
    }

    // Split into crisp 4-6 word caption chunks for high readability on Shorts & landscape
    const chunkSize = 5;
    const chunks: string[] = [];
    for (let i = 0; i < words.length; i += chunkSize) {
      chunks.push(words.slice(i, i + chunkSize).join(' '));
    }

    const sliceSec = clip.durationSec / chunks.length;
    for (const chunk of chunks) {
      const start = cursorSec;
      const end = cursorSec + Math.max(0.4, sliceSec - 0.04);
      entries.push(`${index}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${chunk}\n`);
      cursorSec += sliceSec;
      index++;
    }
  }

  return entries.join('\n');
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
 * 1. Normalizes each clip (or applies Ken Burns zoompan to fallback images)
 * 2. Concatenates normalized clips
 * 3. Mixes narration + optional ducked background music + burned-in SRT subtitles
 * 4. Runs ffprobe quality verification on the output MP4
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

  // Scale scene durations proportionally so visuals match actual narration audio length
  const rawTotal = req.clips.reduce((acc, c) => acc + Math.max(1.5, c.durationSec), 0) || 1;
  const targetTotal = Math.max(req.totalNarrationDurationSec, 5);
  const scaledClips: TimelineSceneClip[] = req.clips.map((clip) => ({
    ...clip,
    durationSec: Math.max(1.5, (clip.durationSec / rawTotal) * targetTotal),
  }));

  // 1. Write synchronized SRT subtitle file
  const srtPath = resolveConfinedPath(req.workDir, 'subtitles.srt');
  const srtContent = buildSynchronizedSrt(scaledClips);
  await fs.writeFile(srtPath, srtContent, 'utf8');

  // 2. Normalize every scene clip to consistent resolution, fps, yuv420p, and exact duration
  const normalizedPaths: string[] = [];
  for (const clip of scaledClips) {
    const outSegment = resolveConfinedPath(
      req.workDir,
      `seg_${String(clip.sceneNumber).padStart(3, '0')}.mp4`
    );

    if (clip.mediaType === 'image') {
      const frames = Math.max(fps, Math.round(clip.durationSec * fps));
      // Keep zoompan source frame close to output size (never 2x/4K) to stay well under 512 MB RAM
      const zpW = Math.ceil((width * 1.12) / 2) * 2;
      const zpH = Math.ceil((height * 1.12) / 2) * 2;
      const vf = [
        `scale=${zpW}:${zpH}:force_original_aspect_ratio=increase`,
        `crop=${zpW}:${zpH}`,
        `zoompan=z='min(zoom+0.001,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${fps}`,
        'eq=contrast=1.04:saturation=1.08',
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

  // 4. Final pass: burn subtitles (if enabled) + mix narration & optional ducked background music
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
    const marginV = req.format === '9:16' ? (lowMem ? 150 : 220) : 56;
    const alignment =
      req.subtitleStyle.position === 'center'
        ? 5
        : req.subtitleStyle.position === 'top_safe'
          ? 8
          : 2;
    const escapedSrt = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:');
    const forceStyle = `FontName=DejaVu Sans,FontSize=${Math.max(
      14,
      Math.min(32, Math.round(req.subtitleStyle.fontSize * (lowMem ? 0.45 : 0.55)))
    )},PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H66000000,BorderStyle=3,Outline=2,Shadow=1,Alignment=${alignment},MarginV=${marginV}`;
    filterParts.push(`[0:v]subtitles='${escapedSrt}':force_style='${forceStyle}'[vout]`);
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
  const safeHeadline = params.headlineText
    .replace(/[':\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
    .slice(0, 36);

  const vf = [
    'scale=1280:720:force_original_aspect_ratio=increase',
    'crop=1280:720',
    'eq=contrast=1.15:saturation=1.22:brightness=-0.04',
    'drawbox=x=0:y=460:w=1280:h=260:color=black@0.62:t=fill',
    `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='${safeHeadline}':fontcolor=white:fontsize=64:borderw=4:bordercolor=black:x=(w-text_w)/2:y=555`,
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
