import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  createSignedOAuthState,
  decryptSecret,
  encryptSecret,
  maskApiKey,
  verifySignedOAuthState,
} from '../src/security/crypto.js';
import { assertSafeExternalUrl, resolveConfinedPath } from '../src/security/urlGuard.js';
import { sanitizeErrorMessage } from '../src/config/env.js';
import {
  FallbackAIProvider,
  resolveLanguageMeta,
  targetWordRangeForDuration,
  type AIProviderClient,
} from '../src/services/aiProvider.js';
import { scoreMediaCandidate, type MediaCandidate } from '../src/services/mediaSearchService.js';
import { wrapPcm16AsWav } from '../src/services/voiceService.js';
import {
  buildSynchronizedAss,
  buildSynchronizedSrt,
  calibrateClipDurations,
  resolveOutputDimensions,
} from '../src/services/ffmpegRenderer.js';
import {
  computeRetryBackoffSeconds,
  isPermanentError,
  shouldSkipStage,
} from '../src/services/pipelineExecutor.js';
import {
  buildScheduleSlotIdempotencyKey,
  computeNextScheduledSlotIso,
} from '../src/scheduler.js';

const TEST_ENC_KEY = crypto.randomBytes(32).toString('hex');

test('AES-256-GCM encrypts/decrypts credentials and rejects wrong-owner AAD', () => {
  const secret = 'AIzaSyFakeTestKeyExample1234567890';
  const encrypted = encryptSecret(secret, TEST_ENC_KEY, 'user-A:gemini');

  assert.notEqual(encrypted.ciphertext, secret);
  const decrypted = decryptSecret(encrypted, TEST_ENC_KEY, 'user-A:gemini');
  assert.equal(decrypted, secret);

  // Tenant isolation: decrypting with another user's AAD MUST fail
  assert.throws(() => decryptSecret(encrypted, TEST_ENC_KEY, 'user-B:gemini'));
});

test('maskApiKey never exposes middle key material', () => {
  assert.equal(maskApiKey('AIzaSyD9876543210XYZ'), 'AIza••••••••0XYZ');
  assert.equal(maskApiKey('short'), '••••••••');
});

test('HMAC OAuth state verifies valid token and blocks tampered state', () => {
  const token = createSignedOAuthState('user-123', TEST_ENC_KEY, 300);
  const parsed = verifySignedOAuthState(token, TEST_ENC_KEY);
  assert.equal(parsed.userId, 'user-123');

  const tampered = `${token.slice(0, -2)}AA`;
  assert.throws(() => verifySignedOAuthState(tampered, TEST_ENC_KEY));
});

test('SSRF guard allows Pexels HTTPS and blocks private IPs / metadata / HTTP', () => {
  assert.doesNotThrow(() =>
    assertSafeExternalUrl('https://videos.pexels.com/video-files/123/hd.mp4', 'media')
  );
  assert.throws(() => assertSafeExternalUrl('http://videos.pexels.com/hd.mp4', 'media'));
  assert.throws(() => assertSafeExternalUrl('https://169.254.169.254/latest/meta-data', 'media'));
  assert.throws(() => assertSafeExternalUrl('https://127.0.0.1:8080/admin', 'media'));
  assert.throws(() => assertSafeExternalUrl('https://evil.example.com/file.mp4', 'media'));
});

test('Path confinement blocks directory traversal', () => {
  assert.doesNotThrow(() => resolveConfinedPath('/tmp/work', 'job_1', 'video.mp4'));
  assert.throws(() => resolveConfinedPath('/tmp/work', '../../etc/passwd'));
});

test('Error sanitizer strips API keys and Bearer tokens', () => {
  const raw = 'Failed calling https://api?key=AIzaSySecretKey1234567890123456 with Bearer eyJhbGciOiJIUzI1NiJ9.abc';
  const clean = sanitizeErrorMessage(raw);
  assert.ok(!clean.includes('AIzaSySecretKey'));
  assert.ok(!clean.includes('eyJhbGci'));
});

test('Script duration target word ranges calibrate 30s and 60s videos', () => {
  const r30 = targetWordRangeForDuration(30);
  assert.ok(r30.min >= 60 && r30.max <= 95);
  const r60 = targetWordRangeForDuration(60);
  assert.ok(r60.min >= 120 && r60.max <= 170);
});

test('Media relevance scoring favors matching portrait HD video and rejects duplicates', () => {
  const portraitMatch: MediaCandidate = {
    provider: 'pexels',
    externalId: 'pexels-v-1',
    mediaType: 'video',
    originalUrl: 'https://pexels.com/video/ancient-artifact',
    downloadUrl: 'https://videos.pexels.com/1.mp4',
    width: 1080,
    height: 1920,
    durationSec: 8,
    titleOrTags: 'ancient artifact museum discovery history',
    authorName: 'Creator',
    licenseMetadata: {},
  };

  const unrelated: MediaCandidate = {
    ...portraitMatch,
    externalId: 'pexels-v-2',
    width: 640,
    height: 360,
    titleOrTags: 'puppy dog beach sunset',
  };

  const scoreGood = scoreMediaCandidate(portraitMatch, {
    keywords: ['ancient artifact', 'archaeological discovery'],
    visualDescription: 'Close-up of mysterious ancient artifact',
    targetDurationSec: 5,
    format: '9:16',
    preferredType: 'video',
    alreadyUsed: false,
  });
  const scoreBad = scoreMediaCandidate(unrelated, {
    keywords: ['ancient artifact', 'archaeological discovery'],
    visualDescription: 'Close-up of mysterious ancient artifact',
    targetDurationSec: 5,
    format: '9:16',
    preferredType: 'video',
    alreadyUsed: false,
  });
  const scoreDuplicate = scoreMediaCandidate(portraitMatch, {
    keywords: ['ancient artifact'],
    visualDescription: 'ancient artifact',
    targetDurationSec: 5,
    format: '9:16',
    preferredType: 'video',
    alreadyUsed: true,
  });

  assert.ok(scoreGood > 0.8);
  assert.ok(scoreGood > scoreBad);
  assert.equal(scoreDuplicate, 0);
});

test('PCM16 WAV wrapper creates valid RIFF WAVE header', () => {
  const pcm = Buffer.alloc(1000, 0);
  const wav = wrapPcm16AsWav(pcm, 24000, 1);
  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(wav.length, 1044);
});

test('SRT generator produces properly formatted synchronized captions and dimensions', () => {
  const srt = buildSynchronizedSrt([
    {
      sceneNumber: 1,
      localMediaPath: '/tmp/a.mp4',
      mediaType: 'video',
      durationSec: 4,
      subtitleText: 'Did you know ancient libraries held hidden engineering secrets',
      transition: 'fade',
    },
  ]);
  assert.ok(srt.includes('00:00:00,000 --> '));
  assert.ok(srt.includes('Did you know ancient libraries'));
  assert.deepEqual(resolveOutputDimensions('9:16', '1080p'), { width: 1080, height: 1920 });
  assert.deepEqual(resolveOutputDimensions('16:9', '720p'), { width: 1280, height: 720 });
});

test('Pipeline crash recovery skips completed stages & prevents infinite retries on auth errors', () => {
  const completed = ['researching', 'generating_script', 'generating_scenes'];
  assert.equal(shouldSkipStage(completed, 'generating_script'), true);
  assert.equal(shouldSkipStage(completed, 'rendering'), false);
  assert.equal(isPermanentError('Invalid Gemini API key. Update in settings.'), true);
  assert.equal(isPermanentError('Network ECONNRESET timeout'), false);
  assert.ok(computeRetryBackoffSeconds(2) > computeRetryBackoffSeconds(0));
});

test('Scheduler produces identical idempotency key within same UTC hour slot to prevent duplicate jobs', () => {
  const t1 = new Date('2026-11-21T14:00:00Z');
  const t2 = new Date('2026-11-21T14:05:00Z');
  const t3 = new Date('2026-11-21T15:00:00Z');

  assert.equal(
    buildScheduleSlotIdempotencyKey('user-1', t1),
    buildScheduleSlotIdempotencyKey('user-1', t2)
  );
  assert.notEqual(
    buildScheduleSlotIdempotencyKey('user-1', t1),
    buildScheduleSlotIdempotencyKey('user-1', t3)
  );
  // Multi-channel schedules in the same hour generate distinct non-colliding keys
  assert.notEqual(
    buildScheduleSlotIdempotencyKey('user-1', t1, 'channel-aaa-111'),
    buildScheduleSlotIdempotencyKey('user-1', t1, 'channel-bbb-222')
  );
});

test('Timezone-aware scheduler computes exact UTC instant for Asia/Kolkata (+05:30) and respects weekdays', () => {
  // 2026-11-22T10:00:00Z is Sunday 15:30 IST; scheduling 18:00 IST should yield 12:30Z same day
  const now = new Date('2026-11-22T10:00:00.000Z');
  const sameDayIst = computeNextScheduledSlotIso({
    publishingTimes: ['18:00'],
    daysOfWeek: ['sun', 'mon'],
    timezone: 'Asia/Kolkata',
    now,
  });
  assert.equal(sameDayIst, '2026-11-22T12:30:00.000Z');

  // When Sunday is excluded, should jump to Monday 18:00 IST = 2026-11-23T12:30:00.000Z
  const mondayIst = computeNextScheduledSlotIso({
    publishingTimes: ['18:00'],
    daysOfWeek: ['mon'],
    timezone: 'Asia/Kolkata',
    now,
  });
  assert.equal(mondayIst, '2026-11-23T12:30:00.000Z');
});

test('Word-calibrated scene timing and ASS subtitles lock voiceover sync and bottom-safe placement', () => {
  const calibrated = calibrateClipDurations(
    [
      {
        sceneNumber: 1,
        localMediaPath: '/tmp/1.mp4',
        mediaType: 'video',
        durationSec: 5,
        subtitleText: 'Short hook here',
        transition: 'fade',
      },
      {
        sceneNumber: 2,
        localMediaPath: '/tmp/2.mp4',
        mediaType: 'video',
        durationSec: 5,
        subtitleText:
          'This second scene has a much longer explanation with many more spoken words to narrate accurately',
        transition: 'fade',
      },
    ],
    20
  );
  const sum = calibrated.reduce((a, c) => a + c.durationSec, 0);
  assert.ok(Math.abs(sum - 20) < 0.05);
  assert.ok(calibrated[1].durationSec > calibrated[0].durationSec * 2);

  const ass = buildSynchronizedAss(calibrated, 720, 1280, {
    enabled: true,
    burnIn: true,
    fontSize: 44,
    primaryColor: '#FFFFFF',
    outlineColor: '#000000',
    position: 'bottom_safe',
  });
  assert.ok(ass.includes('PlayResX: 720'));
  assert.ok(ass.includes('PlayResY: 1280'));
  assert.ok(ass.includes(',2,58,58,179,1')); // bottom-center alignment=2, MarginV=179 (~14% of 1280)
  assert.ok(ass.includes('Dialogue: 0,0:00:00.00,'));
});

test('Language resolver maps Hindi and Hinglish strictly to explicit instructions', () => {
  const hi = resolveLanguageMeta('hi');
  assert.equal(hi.ttsName, 'Hindi');
  assert.ok(hi.scriptInstruction.includes('Devanagari'));

  const hinglish = resolveLanguageMeta('hinglish');
  assert.equal(hinglish.code, 'hinglish');
  assert.ok(hinglish.scriptInstruction.includes('Roman'));
});

test('Groq API key redaction, permanent error detection, and 429 failover to Groq work reliably', async () => {
  const leaked = 'Authorization failed for gsk_FakeGroqSecretKey1234567890abcd';
  const cleaned = sanitizeErrorMessage(leaked);
  assert.ok(!cleaned.includes('gsk_FakeGroqSecretKey'));
  assert.ok(cleaned.includes('[REDACTED_GROQ_KEY]'));

  assert.equal(isPermanentError('Invalid Groq API key. Update your key in API Settings.'), true);

  let groqCalled = false;
  const rateLimitedGemini: AIProviderClient = {
    name: 'gemini',
    async generateJson() {
      throw new Error('Gemini API quota or rate limit exceeded (HTTP 429).');
    },
  };
  const healthyGroq: AIProviderClient = {
    name: 'groq',
    async generateJson<T>() {
      groqCalled = true;
      return { ok: true, provider: 'groq' } as T;
    },
  };

  const fallback = new FallbackAIProvider([rateLimitedGemini, healthyGroq]);
  const result = await fallback.generateJson<{ ok: boolean; provider: string }>(
    'Return JSON',
    'test'
  );
  assert.equal(groqCalled, true);
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'groq');
});


