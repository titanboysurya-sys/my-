import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config/env.js';
import { resolveConfinedPath } from '../security/urlGuard.js';

const execFileAsync = promisify(execFile);

export type BgmMoodId =
  | 'none'
  | 'cinematic'
  | 'mystery'
  | 'motivational'
  | 'tech'
  | 'dark_phonk';

export function normalizeBgmMood(raw?: string | null): BgmMoodId {
  switch ((raw || '').trim().toLowerCase()) {
    case 'none':
    case 'off':
    case 'mute':
      return 'none';
    case 'mystery':
    case 'suspense':
      return 'mystery';
    case 'motivational':
    case 'upbeat':
    case 'energetic':
      return 'motivational';
    case 'tech':
    case 'futuristic':
    case 'cyber':
      return 'tech';
    case 'dark':
    case 'dark_phonk':
    case 'phonk':
    case 'thriller':
      return 'dark_phonk';
    case 'cinematic':
    case 'documentary':
    default:
      return 'cinematic';
  }
}

export function autoBgmMoodForNiche(niche?: string | null): BgmMoodId {
  const n = (niche || '').trim().toLowerCase();
  if (n.includes('history') || n.includes('facts') || n.includes('stories')) return 'mystery';
  if (n.includes('ai') || n.includes('tech') || n.includes('science')) return 'tech';
  if (n.includes('motiv') || n.includes('business') || n.includes('finance')) return 'motivational';
  return 'cinematic';
}

/**
 * Generates a clean, seamless loopable ambient/rhythmic background music bed (30s stereo WAV)
 * matched to the chosen mood using FFmpeg DSP synthesis — zero licensing risks, zero network dependency.
 */
export async function generateProceduralBgmTrack(params: {
  workDir: string;
  mood: BgmMoodId;
  durationSec?: number;
}): Promise<string | null> {
  if (params.mood === 'none') return null;

  const loopDuration = Math.max(12, Math.min(45, Math.ceil(params.durationSec || 24)));
  const outPath = resolveConfinedPath(params.workDir, `bgm_${params.mood}.wav`);

  let expr = '';
  let postFilter = 'lowpass=f=1800,aecho=0.8:0.75:55|95:0.28|0.22,volume=0.85';

  switch (params.mood) {
    case 'mystery':
      // Minor atmospheric drone + soft eerie pulse (Am / Dm tension)
      expr =
        '0.22*sin(2*PI*110*t)+0.16*sin(2*PI*164.81*t)+0.12*sin(2*PI*220*t)*(0.6+0.4*sin(2*PI*0.35*t))+0.14*sin(2*PI*55*t)*(0.5+0.5*sin(2*PI*1.5*t))';
      postFilter = 'lowpass=f=1300,aecho=0.8:0.85:90|140:0.35|0.25,volume=0.9';
      break;
    case 'tech':
      // Crisp futuristic synth pulse + clean sub groove
      expr =
        '0.20*sin(2*PI*98*t)+0.14*sin(2*PI*196*t)*(0.45+0.55*pow(sin(2*PI*2.0*t),2))+0.10*sin(2*PI*293.66*t)*(0.5+0.5*sin(2*PI*4.0*t))+0.08*sin(2*PI*392*t)*(0.5+0.5*cos(2*PI*1.0*t))';
      postFilter = 'lowpass=f=2400,aecho=0.75:0.7:65:0.25,volume=0.85';
      break;
    case 'motivational':
      // Warm major uplifting progression pad + rhythmic heartbeat pulse
      expr =
        '0.22*sin(2*PI*130.81*t)+0.16*sin(2*PI*196*t)+0.14*sin(2*PI*261.63*t)*(0.65+0.35*pow(sin(2*PI*1.6*t),2))+0.12*sin(2*PI*329.63*t)*(0.5+0.5*sin(2*PI*0.4*t))';
      postFilter = 'lowpass=f=2200,aecho=0.8:0.8:70|110:0.3|0.2,volume=0.88';
      break;
    case 'dark_phonk':
      // Heavy sub-bass pulse + dark fifth harmonic tension
      expr =
        '0.30*tanh(1.8*sin(2*PI*55*t))*(0.55+0.45*pow(sin(2*PI*1.8*t),4))+0.16*sin(2*PI*82.41*t)+0.11*sin(2*PI*116.54*t)*(0.5+0.5*sin(2*PI*0.9*t))';
      postFilter = 'lowpass=f=1100,aecho=0.75:0.75:80:0.28,volume=0.9';
      break;
    case 'cinematic':
    default:
      // Lush emotional documentary strings-like harmonic bed
      expr =
        '0.22*sin(2*PI*110*t)+0.18*sin(2*PI*164.81*t)+0.14*sin(2*PI*220*t)*(0.7+0.3*sin(2*PI*0.25*t))+0.12*sin(2*PI*261.63*t)*(0.6+0.4*cos(2*PI*0.33*t))';
      postFilter = 'lowpass=f=1700,aecho=0.85:0.82:95|150:0.35|0.24,volume=0.88';
      break;
  }

  try {
    await execFileAsync(
      config.ffmpegPath,
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        `aevalsrc=${expr}:s=44100:d=${loopDuration}`,
        '-af',
        `${postFilter},afade=t=in:st=0:d=0.6,afade=t=out:st=${(loopDuration - 0.6).toFixed(2)}:d=0.6`,
        '-ac',
        '2',
        '-ar',
        '44100',
        outPath,
      ],
      { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 }
    );
    return outPath;
  } catch {
    return null;
  }
}

export interface TransitionSfxTracks {
  hookBoomPath: string | null;
  whooshPath: string | null;
}

/**
 * Generates crisp short SFX clips (Hook Sub-Impact Boom + Scene Cut Whoosh)
 * using FFmpeg lavfi synthesis for punchy viral retention pacing.
 */
export async function generateTransitionSfxAssets(workDir: string): Promise<TransitionSfxTracks> {
  const hookBoomPath = resolveConfinedPath(workDir, 'sfx_hook_boom.wav');
  const whooshPath = resolveConfinedPath(workDir, 'sfx_whoosh.wav');

  const boomPromise = execFileAsync(
    config.ffmpegPath,
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'aevalsrc=0.75*sin(2*PI*(130*exp(-6.5*t)+38)*t)*exp(-4.2*t):s=44100:d=0.45',
      '-af',
      'lowpass=f=240,volume=0.8',
      '-ac',
      '2',
      '-ar',
      '44100',
      hookBoomPath,
    ],
    { timeout: 10_000 }
  )
    .then(() => hookBoomPath)
    .catch(() => null);

  const whooshPromise = execFileAsync(
    config.ffmpegPath,
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'anoisesrc=color=pink:duration=0.26:sample_rate=44100:amplitude=0.45',
      '-af',
      'bandpass=f=850:width_type=h:w=900,afade=t=in:st=0:d=0.07,afade=t=out:st=0.09:d=0.17,volume=0.72',
      '-ac',
      '2',
      '-ar',
      '44100',
      whooshPath,
    ],
    { timeout: 10_000 }
  )
    .then(() => whooshPath)
    .catch(() => null);

  const [boom, whoosh] = await Promise.all([boomPromise, whooshPromise]);
  return { hookBoomPath: boom, whooshPath: whoosh };
}
