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
  generateScriptWithAI,
  resolveLanguageMeta,
  targetWordRangeForDuration,
  type AIProviderClient,
} from '../src/services/aiProvider.js';
import {
  isModelRetiredOrUnsupportedError,
  rankGeminiTextModels,
  rankGeminiTtsModels,
  rankGroqChatModels,
} from '../src/services/modelResolver.js';
import {
  buildAiVisualSearchQuery,
  isCartoonOrStylizedIntent,
  scoreMediaCandidate,
  searchCivitaiImages,
  searchLexicaImages,
  type MediaCandidate,
} from '../src/services/mediaSearchService.js';
import {
  defaultPreviewSampleText,
  resolveStudioVoiceProfile,
  STUDIO_VOICE_CATALOG,
  wrapPcm16AsWav,
} from '../src/services/voiceService.js';
import {
  buildColorGradeFilter,
  buildSynchronizedAss,
  buildSynchronizedSrt,
  calibrateClipDurations,
  normalizeColorGrade,
  normalizeEditingPace,
  normalizeSubtitlePreset,
  resolveOutputDimensions,
} from '../src/services/ffmpegRenderer.js';
import {
  VIDEO_VISUAL_INSTRUCTIONS_END,
  VIDEO_VISUAL_INSTRUCTIONS_START,
  VOICEOVER_SCRIPT_END,
  VOICEOVER_SCRIPT_START,
  formatDelimitedScriptDocument,
  parseDelimitedScriptSections,
  sanitizeSpokenNarration,
} from '../src/services/narrationSanitizer.js';
import { autoBgmMoodForNiche, normalizeBgmMood } from '../src/services/soundDesignService.js';
import { mapScriptWordsToWhisperTimings } from '../src/services/whisperAlignService.js';
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
  assert.ok(ass.includes(',2,54,54,205,1')); // bottom-center alignment=2, MarginV=205 (16% of 1280, Shorts UI safe)
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

test('Live model resolver skips retired/non-chat models and automatically adopts newest active Groq & Gemini models', () => {
  // Simulate Groq /models after llama-3.3-70b-versatile is retired and newer models are live
  const groqLive = [
    { id: 'whisper-large-v3', active: true },
    { id: 'llama-guard-4-12b', active: true },
    { id: 'playai-tts', active: true },
    { id: 'groq/compound', active: true },
    { id: 'llama-3.3-70b-versatile', active: false },
    { id: 'openai/gpt-oss-120b', active: true },
    { id: 'openai/gpt-oss-20b', active: true },
    { id: 'llama-3.1-8b-instant', active: true },
  ];

  // Auto mode skips inactive/audio/guard models and picks strongest active production model
  const groqAuto = rankGroqChatModels(groqLive, 'auto');
  assert.equal(groqAuto[0], 'openai/gpt-oss-120b');
  assert.ok(!groqAuto.includes('whisper-large-v3'));
  assert.ok(!groqAuto.includes('llama-3.3-70b-versatile'));

  // Fast mode prioritizes ultra-high-limit fast models
  const groqFast = rankGroqChatModels(groqLive, 'fast');
  assert.ok(groqFast[0] === 'llama-3.1-8b-instant' || groqFast[0] === 'openai/gpt-oss-20b');

  // Retired pinned model is safely ignored and replaced with active flagship
  const groqPinnedRetired = rankGroqChatModels(groqLive, 'llama-3.3-70b-versatile');
  assert.equal(groqPinnedRetired[0], 'openai/gpt-oss-120b');

  // Simulate Gemini /v1beta/models with next-gen 3.5/4.0 models alongside 2.5
  const geminiLive = [
    { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.0-flash-tts', supportedGenerationMethods: ['generateContent'] },
  ];

  const geminiText = rankGeminiTextModels(geminiLive);
  assert.equal(geminiText[0], 'gemini-3.5-flash');
  assert.ok(!geminiText.includes('gemini-2.5-flash-preview-tts'));
  assert.ok(!geminiText.includes('text-embedding-004'));

  const geminiTts = rankGeminiTtsModels(geminiLive);
  assert.equal(geminiTts[0], 'gemini-3.0-flash-tts');
  assert.equal(geminiTts[1], 'gemini-2.5-flash-preview-tts');

  assert.equal(
    isModelRetiredOrUnsupportedError(400, 'The model llama-3.3-70b-versatile has been decommissioned'),
    true
  );
  assert.equal(isModelRetiredOrUnsupportedError(404, 'Model not found'), true);
  assert.equal(isModelRetiredOrUnsupportedError(429, 'Rate limit exceeded'), false);
});

test('Studio voice catalog exposes all 30 official voices (16 male, 14 female) with localized preview samples', () => {
  const males = STUDIO_VOICE_CATALOG.filter((v) => v.gender === 'male');
  const females = STUDIO_VOICE_CATALOG.filter((v) => v.gender === 'female');
  const uniqueIds = new Set(STUDIO_VOICE_CATALOG.map((v) => v.id));

  assert.equal(STUDIO_VOICE_CATALOG.length, 30);
  assert.equal(uniqueIds.size, 30);
  assert.equal(males.length, 16);
  assert.equal(females.length, 14);

  const charon = resolveStudioVoiceProfile('Charon');
  assert.equal(charon.gender, 'male');
  assert.equal(charon.geminiVoiceName, 'Charon');
  assert.ok(charon.elevenLabsVoiceId.length >= 15);

  const enceladus = resolveStudioVoiceProfile('Enceladus');
  assert.equal(enceladus.gender, 'male');
  assert.equal(enceladus.geminiVoiceName, 'Enceladus');

  const sulafat = resolveStudioVoiceProfile('sulafat');
  assert.equal(sulafat.gender, 'female');
  assert.equal(sulafat.geminiVoiceName, 'Sulafat');
  assert.notEqual(sulafat.elevenLabsVoiceId, charon.elevenLabsVoiceId);

  // Custom raw ElevenLabs voice IDs are preserved verbatim
  const custom = resolveStudioVoiceProfile('CustomVoiceId123456789');
  assert.equal(custom.elevenLabsVoiceId, 'CustomVoiceId123456789');

  // Preview sample text localizes cleanly for Hindi, Hinglish, and English
  const hiSample = defaultPreviewSampleText('hi', 'Charon');
  assert.ok(hiSample.includes('Charon'));
  assert.ok(hiSample.includes('नमस्ते'));

  const hinglishSample = defaultPreviewSampleText('hinglish', 'Sulafat');
  assert.ok(hinglishSample.includes('Sulafat'));
  assert.ok(hinglishSample.toLowerCase().includes('namaste'));

  const enSample = defaultPreviewSampleText('en', 'Fenrir');
  assert.ok(enSample.includes('Fenrir'));
});

test('Colorful viral subtitle presets emit word-by-word ASS color pop and preserve Devanagari Hindi text', () => {
  assert.equal(normalizeSubtitlePreset('mrbeast'), 'mrbeast');
  assert.equal(normalizeSubtitlePreset('hormozi'), 'hormozi');
  assert.equal(normalizeSubtitlePreset('bold_shorts'), 'mrbeast');

  const mrbeastAss = buildSynchronizedAss(
    [
      {
        sceneNumber: 1,
        localMediaPath: '/tmp/1.mp4',
        mediaType: 'video',
        durationSec: 4,
        subtitleText: 'This ancient secret changed history forever',
        transition: 'fade',
      },
    ],
    1080,
    1920,
    {
      enabled: true,
      burnIn: true,
      preset: 'mrbeast',
      fontSize: 44,
      primaryColor: '#FFFFFF',
      outlineColor: '#000000',
      position: 'bottom_safe',
    }
  );
  // Active word highlight color tag & pop scaling should be present
  assert.ok(mrbeastAss.includes('{\\c&H'));
  assert.ok(mrbeastAss.includes('\\fscx11'));
  assert.ok(mrbeastAss.includes('ANCIENT'));

  const hormoziHindiAss = buildSynchronizedAss(
    [
      {
        sceneNumber: 1,
        localMediaPath: '/tmp/2.mp4',
        mediaType: 'video',
        durationSec: 4,
        subtitleText: 'यह अद्भुत इतिहास आज भी दुनिया को हैरान करता है',
        transition: 'fade',
      },
    ],
    1080,
    1920,
    {
      enabled: true,
      burnIn: true,
      preset: 'hormozi',
      fontSize: 44,
      primaryColor: '#FFFFFF',
      outlineColor: '#000000',
      position: 'center',
    }
  );
  assert.ok(hormoziHindiAss.includes('इतिहास'));
  assert.ok(hormoziHindiAss.includes('{\\c&H'));
});

test('User custom open-source media URL guard allows public HTTPS links and blocks private/local/HTTP URLs', () => {
  assert.doesNotThrow(() =>
    assertSafeExternalUrl('https://commons.wikimedia.org/wiki/File:Taj_Mahal.jpg', 'user_media')
  );
  assert.doesNotThrow(() =>
    assertSafeExternalUrl('https://archive.org/details/apollo11_launch', 'user_media')
  );
  assert.throws(() => assertSafeExternalUrl('http://commons.wikimedia.org/wiki/File:Test.jpg', 'user_media'));
  assert.throws(() => assertSafeExternalUrl('https://localhost:3000/secret.mp4', 'user_media'));
  assert.throws(() => assertSafeExternalUrl('https://10.0.0.5/internal.jpg', 'user_media'));
  assert.throws(() => assertSafeExternalUrl('https://169.254.169.254/latest/meta-data', 'user_media'));
  assert.throws(() => assertSafeExternalUrl('https://user:pass@example.com/clip.mp4', 'user_media'));
});

test('Narration sanitizer strips visual instructions, stage cues, and labels while keeping Hindi & English spoken text', () => {
  const dirtyScript = [
    '**Scene 1: Hook**',
    '[Visual: Dramatic drone zoom over ancient Rome at sunset]',
    '(Camera zooms in fast with whoosh SFX)',
    '00:00 - 00:03 Narrator: क्या आप जानते हैं कि रोमन कंक्रीट आज भी खुद को ठीक कर लेता है?',
    '*pause for impact*',
    'SFX: Boom',
    'Hook: Wait—here is the real scientific secret behind it.',
  ].join('\n');

  const clean = sanitizeSpokenNarration(dirtyScript);
  assert.ok(!clean.includes('Visual'));
  assert.ok(!clean.includes('Camera'));
  assert.ok(!clean.includes('Scene 1'));
  assert.ok(!clean.includes('Narrator:'));
  assert.ok(!clean.includes('SFX'));
  assert.ok(!clean.includes('pause'));
  assert.ok(clean.includes('क्या आप जानते हैं कि रोमन कंक्रीट आज भी खुद को ठीक कर लेता है?'));
  assert.ok(clean.includes('Wait—here is the real scientific secret behind it.'));
});

test('Phase 1 viral editing presets, BGM moods, Whisper word timing, and HookBanner ASS work cleanly', () => {
  assert.equal(normalizeEditingPace('viral_fast'), 'viral_fast');
  assert.equal(normalizeColorGrade('teal_orange'), 'teal_orange');
  assert.ok(buildColorGradeFilter('dark_moody').includes('vignette'));
  assert.equal(autoBgmMoodForNiche('AI News'), 'tech');
  assert.equal(autoBgmMoodForNiche('History'), 'mystery');
  assert.equal(normalizeBgmMood('dark'), 'dark_phonk');

  const aligned = mapScriptWordsToWhisperTimings(
    ['THIS', 'SECRET', 'WORKS'],
    [
      { word: 'this', startSec: 0.1, endSec: 0.45 },
      { word: 'secret', startSec: 0.5, endSec: 1.05 },
      { word: 'works', startSec: 1.1, endSec: 1.65 },
    ],
    0,
    2.0
  );
  assert.equal(aligned.length, 3);
  assert.equal(aligned[1].startSec, 0.5);
  assert.equal(aligned[1].endSec, 1.05);

  const ass = buildSynchronizedAss(
    [
      {
        sceneNumber: 1,
        localMediaPath: '/tmp/1.mp4',
        mediaType: 'video',
        durationSec: 2.0,
        subtitleText: '[Visual: rocket] This secret works',
        transition: 'punch',
      },
    ],
    720,
    1280,
    {
      enabled: true,
      burnIn: true,
      preset: 'mrbeast',
      fontSize: 44,
      primaryColor: '#FFFFFF',
      outlineColor: '#000000',
      position: 'bottom_safe',
    },
    {
      whisperWords: aligned,
      hookBannerText: 'Hidden Roman Concrete Secret',
    }
  );
  assert.ok(ass.includes('Style: HookBanner'));
  assert.ok(ass.includes('HIDDEN ROMAN CONCRETE SECRET'));
  assert.ok(!ass.includes('[Visual'));
});

test('Delimited script parser separates Video Visual Instructions from Voiceover Script independently', () => {
  const delimitedDoc = [
    VIDEO_VISUAL_INSTRUCTIONS_START,
    'Scene 1 (0:00-0:03): Fast drone push-in over Roman Colosseum, SFX sub boom.',
    'Scene 2 (0:03-0:06): Close-up microscopic volcanic ash mixing with seawater.',
    VIDEO_VISUAL_INSTRUCTIONS_END,
    '',
    VOICEOVER_SCRIPT_START,
    'क्या आप जानते हैं कि रोमन कंक्रीट दो हजार साल बाद भी खुद को ठीक कर लेता है?',
    'वैज्ञानिकों ने पाया कि इसमें मौजूद चूने के कण पानी के संपर्क में आते ही दरारें भर देते हैं।',
    VOICEOVER_SCRIPT_END,
  ].join('\n');

  const parsed = parseDelimitedScriptSections(delimitedDoc);
  assert.equal(parsed.hasExplicitDelimiters, true);
  assert.ok(parsed.videoVisualInstructions.includes('Fast drone push-in'));
  assert.ok(parsed.videoVisualInstructions.includes('microscopic volcanic ash'));
  assert.ok(!parsed.voiceoverScript.includes('Colosseum'));
  assert.ok(!parsed.voiceoverScript.includes('drone'));
  assert.ok(!parsed.voiceoverScript.includes('SFX'));
  assert.ok(!parsed.voiceoverScript.includes(VOICEOVER_SCRIPT_START));
  assert.ok(parsed.voiceoverScript.includes('रोमन कंक्रीट'));
  assert.ok(parsed.voiceoverScript.includes('दरारें भर देते हैं'));

  // sanitizeSpokenNarration also strips delimited visual blocks automatically
  const sanitized = sanitizeSpokenNarration(delimitedDoc);
  assert.equal(sanitized, parsed.voiceoverScript);

  const formatted = formatDelimitedScriptDocument(parsed.voiceoverScript, parsed.videoVisualInstructions);
  assert.ok(formatted.includes(VIDEO_VISUAL_INSTRUCTIONS_START));
  assert.ok(formatted.includes(VOICEOVER_SCRIPT_START));
});

test('generateScriptWithAI prompt enforces explicit delimiters and parses sections independently', async () => {
  let capturedSystemPrompt = '';
  let capturedUserPrompt = '';

  const mockAi: AIProviderClient = {
    name: 'mock-gemini',
    async generateJson<T>(systemPrompt: string, userPrompt: string): Promise<T> {
      capturedSystemPrompt = systemPrompt;
      capturedUserPrompt = userPrompt;
      return {
        titleIdea: 'Roman Concrete Secret',
        hook: '[Visual: zoom] Stop scrolling because ancient concrete still heals itself.',
        videoVisualInstructions: `${VIDEO_VISUAL_INSTRUCTIONS_START}\n00:00-00:03: Drone shot of Roman harbor ruins\n00:03-00:06: Lab microscope cutaway\n${VIDEO_VISUAL_INSTRUCTIONS_END}`,
        voiceoverScript: `${VOICEOVER_SCRIPT_START}\nStop scrolling because ancient Roman concrete still heals itself today. Scientists discovered hot-mixed lime clasts react with rainwater to seal cracks automatically.\n${VOICEOVER_SCRIPT_END}`,
        narrationText: `${VIDEO_VISUAL_INSTRUCTIONS_START}\nDrone shot of ruins\n${VIDEO_VISUAL_INSTRUCTIONS_END}\nStop scrolling because ancient Roman concrete still heals itself today. Scientists discovered hot-mixed lime clasts react with rainwater to seal cracks automatically.`,
        fullScript: 'placeholder',
        ending: 'Which explains why their harbors survived two millennia.',
        callToAction: 'Follow for more history.',
      } as unknown as T;
    },
  };

  const generated = await generateScriptWithAI(mockAi, {
    topic: 'Roman self-healing concrete',
    niche: 'History',
    language: 'en',
    contentStyle: 'documentary',
    durationSeconds: 30,
  });

  // Prompt explicitly instructs Gemini with section names and delimiters
  assert.ok(capturedSystemPrompt.includes(VIDEO_VISUAL_INSTRUCTIONS_START));
  assert.ok(capturedSystemPrompt.includes(VIDEO_VISUAL_INSTRUCTIONS_END));
  assert.ok(capturedSystemPrompt.includes(VOICEOVER_SCRIPT_START));
  assert.ok(capturedSystemPrompt.includes(VOICEOVER_SCRIPT_END));
  assert.ok(capturedUserPrompt.includes('Video Visual Instructions') || capturedSystemPrompt.includes('Video Visual Instructions'));
  assert.ok(capturedSystemPrompt.includes('Voiceover Script'));

  // Independent parsing ensures zero visual instructions leak into spoken narrationText or hook
  assert.ok(generated.visualInstructions?.includes('Drone shot of Roman harbor ruins'));
  assert.ok(!generated.narrationText.includes('Drone shot'));
  assert.ok(!generated.narrationText.includes('Lab microscope'));
  assert.ok(!generated.narrationText.includes(VOICEOVER_SCRIPT_START));
  assert.ok(!generated.hook.includes('Visual'));
  assert.ok(generated.narrationText.includes('Stop scrolling because ancient Roman concrete still heals itself today.'));
  assert.ok(generated.fullScript.includes(VIDEO_VISUAL_INSTRUCTIONS_START));
  assert.ok(generated.fullScript.includes(VOICEOVER_SCRIPT_START));
});

test('Lexica AI, Civitai AI, Openverse, and AI Horde CDN hosts pass media SSRF guard and cartoon intent works', async () => {
  assert.doesNotThrow(() =>
    assertSafeExternalUrl('https://image.lexica.art/md/0482ee68-0368-4eca-8846-5930db866b33', 'media')
  );
  assert.doesNotThrow(() =>
    assertSafeExternalUrl(
      'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/12345678/width=1080/sample.jpeg',
      'media'
    )
  );
  assert.doesNotThrow(() =>
    assertSafeExternalUrl('https://assets.aihorde.net/temporary/sample.webp', 'media')
  );
  assert.doesNotThrow(() =>
    assertSafeExternalUrl('https://stablehorde.net/temporary/12345.webp', 'media')
  );

  assert.equal(isCartoonOrStylizedIntent({ niche: 'Cartoon', contentStyle: 'documentary' }), true);
  assert.equal(isCartoonOrStylizedIntent({ niche: 'Finance', contentStyle: 'news_brief' }), false);
  assert.equal(
    buildAiVisualSearchQuery('clever fox', 'clever fox in forest', true),
    'clever fox cartoon illustration'
  );

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (input: string | URL) => {
      const u = String(input);
      if (u.startsWith('https://lexica.art/api/v1/search')) {
        return new Response(
          JSON.stringify({
            images: [
              {
                id: 'lex-1',
                gallery: 'https://lexica.art?q=lex-1',
                src: 'https://image.lexica.art/md/lex-1',
                prompt: 'cute cartoon fox in forest',
                width: 768,
                height: 1024,
                nsfw: false,
              },
              {
                id: 'lex-nsfw',
                src: 'https://image.lexica.art/md/lex-nsfw',
                width: 768,
                height: 1024,
                nsfw: true,
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (u.startsWith('https://civitai.com/api/v1/models')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: 901,
                name: 'Pixar Cartoon 3D',
                nsfw: false,
                tags: ['cartoon', '3d', 'animation'],
                modelVersions: [
                  {
                    images: [
                      {
                        id: 4001,
                        url: 'https://image.civitai.com/xG1/abc/width=450/fox.jpeg',
                        type: 'image',
                        width: 1024,
                        height: 1024,
                        nsfwLevel: 1,
                      },
                    ],
                  },
                ],
              },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    const lexicaResults = await searchLexicaImages('cartoon fox');
    assert.equal(lexicaResults.length, 1);
    assert.equal(lexicaResults[0].provider, 'ai_generated');
    assert.equal(lexicaResults[0].externalId, 'lexica-lex-1');

    const civitaiResults = await searchCivitaiImages('cartoon');
    assert.equal(civitaiResults.length, 1);
    assert.equal(civitaiResults[0].provider, 'ai_generated');
    assert.ok(civitaiResults[0].downloadUrl.includes('/width=1080/'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
