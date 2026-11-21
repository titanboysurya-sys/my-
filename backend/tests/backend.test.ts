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
import { targetWordRangeForDuration } from '../src/services/aiProvider.js';
import { scoreMediaCandidate, type MediaCandidate } from '../src/services/mediaSearchService.js';
import { wrapPcm16AsWav } from '../src/services/voiceService.js';
import { buildSynchronizedSrt, resolveOutputDimensions } from '../src/services/ffmpegRenderer.js';
import {
  computeRetryBackoffSeconds,
  isPermanentError,
  shouldSkipStage,
} from '../src/services/pipelineExecutor.js';
import { buildScheduleSlotIdempotencyKey } from '../src/scheduler.js';

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
});
