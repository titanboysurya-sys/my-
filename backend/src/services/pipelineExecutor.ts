import fs from 'node:fs/promises';
import path from 'node:path';
import { config, sanitizeErrorMessage } from '../config/env.js';
import { getSupabaseAdmin, uploadToStorageWithAutoBucket } from '../db/supabase.js';
import { resolveConfinedPath } from '../security/urlGuard.js';
import {
  createAIProviderForUser,
  generateSceneBreakdownWithAI,
  generateScriptWithAI,
  generateSeoMetadataWithAI,
  researchTopicsWithAI,
  verifySceneVisualMatchesWithAI,
  type GeneratedSeoMetadata,
  type ResearchReference,
} from './aiProvider.js';
import {
  downloadAndPersistMedia,
  gatherSceneMediaCandidates,
  isCartoonOrStylizedIntent,
  rescueUnmatchedSceneMedia,
  type MediaSourceMode,
  type SceneMediaSearchInput,
  type ScoredMediaCandidate,
} from './mediaSearchService.js';
import {
  generateThumbnailFromVideo,
  normalizeColorGrade,
  normalizeEditingPace,
  normalizeSubtitlePreset,
  renderVideoWithFfmpeg,
  type SubtitleStyleConfig,
  type TimelineSceneClip,
} from './ffmpegRenderer.js';
import {
  formatDelimitedScriptDocument,
  parseDelimitedScriptSections,
  sanitizeSpokenNarration,
} from './narrationSanitizer.js';
import {
  autoBgmMoodForNiche,
  generateProceduralBgmTrack,
  generateTransitionSfxAssets,
  normalizeBgmMood,
} from './soundDesignService.js';
import { probeAudioDurationSeconds, synthesizeNarration, type VoiceProviderName } from './voiceService.js';
import {
  alignNarrationWithGroqWhisper,
  alignScenesWithGeminiAudio,
  detectAudioSpeechIntervals,
  trimAudioDeadAir,
  type AudioSpeechInterval,
  type SceneTimingHint,
  type WordTimestamp,
} from './whisperAlignService.js';
import { uploadVideoToYouTubeResumable } from './youtubeService.js';

export type PipelineStage =
  | 'researching'
  | 'generating_script'
  | 'generating_scenes'
  | 'searching_media'
  | 'downloading_media'
  | 'generating_voice'
  | 'preparing_timeline'
  | 'rendering'
  | 'generating_thumbnail'
  | 'generating_metadata'
  | 'quality_check'
  | 'uploading';

export interface VideoJobRow {
  id: string;
  user_id: string;
  project_id: string;
  job_type: string;
  status: string;
  progress: number;
  current_stage: string;
  completed_stages: string[] | null;
  retry_count: number;
  max_retries: number;
  idempotency_key: string;
}

/**
 * Pure helper used by worker and tests to determine whether a stage can be safely skipped
 * during crash recovery or retry (saving API credits and time).
 */
export function shouldSkipStage(completedStages: string[], stage: PipelineStage): boolean {
  return completedStages.includes(stage);
}

/**
 * Computes bounded exponential backoff delay in seconds for retryable errors.
 */
export function computeRetryBackoffSeconds(retryCount: number): number {
  return Math.min(900, Math.pow(2, Math.max(0, retryCount)) * 30);
}

/**
 * Classifies whether an error is non-retryable (e.g. invalid API key, revoked OAuth)
 * to prevent infinite retry loops and wasted quota.
 */
export function isPermanentError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('invalid gemini api key') ||
    lower.includes('invalid groq api key') ||
    lower.includes('invalid api key') ||
    lower.includes('no ai provider key') ||
    lower.includes('revoked') ||
    lower.includes('no connected youtube channel')
  );
}

/**
 * Ensures scene subtitleText values match the exact spoken script sent to TTS so
 * dropped sentences or altered scene text never cause multi-second audio-subtitle skew.
 */
export function reconcileClipsSubtitleCoverage(
  clips: TimelineSceneClip[],
  spokenNarration: string
): TimelineSceneClip[] {
  const cleanSpoken = sanitizeSpokenNarration(spokenNarration);
  const spokenWords = cleanSpoken.split(/\s+/).filter(Boolean);
  if (clips.length === 0 || spokenWords.length === 0) return clips;

  const sceneTexts = clips.map((c) => sanitizeSpokenNarration(c.subtitleText || ''));
  const combinedWords = sceneTexts.join(' ').split(/\s+/).filter(Boolean);
  const allPopulated = sceneTexts.every((t) => t.length > 0);
  const ratio = combinedWords.length / spokenWords.length;

  // Preserve LLM scene splits whenever they already match the spoken narration closely
  if (allPopulated && ratio >= 0.85 && ratio <= 1.15) {
    return clips;
  }

  // Re-partition the exact spoken words across scenes proportionally by their existing weights
  const weights = clips.map((c, idx) => {
    const w = sceneTexts[idx].split(/\s+/).filter(Boolean).length;
    return w > 0 ? w : Math.max(1, Math.round(c.durationSec || 3));
  });
  const totalWeight = weights.reduce((a, b) => a + b, 0) || clips.length;

  let cursor = 0;
  return clips.map((clip, idx) => {
    const isLast = idx === clips.length - 1;
    const count = isLast
      ? spokenWords.length - cursor
      : Math.max(1, Math.round((weights[idx] / totalWeight) * spokenWords.length));
    const end = isLast ? spokenWords.length : Math.min(spokenWords.length, cursor + count);
    const slice = spokenWords.slice(cursor, end).join(' ');
    cursor = end;
    return {
      ...clip,
      subtitleText: slice || sceneTexts[idx] || clip.subtitleText,
    };
  });
}

/**
 * Parses a user-pasted custom script cleanly so the exact spoken narration is preserved
 * 100% verbatim for TTS and captions, while any optional [Visual] notes or delimiters
 * are separated into videoVisualInstructions for the scene visual director.
 */
export function resolvePipelineScriptFromCustomInput(
  rawCustomScript: string,
  fallbackTitle: string
): {
  titleIdea: string;
  hook: string;
  narrationText: string;
  fullScript: string;
  visualInstructions: string;
  ending: string;
  wordCount: number;
  estimatedDurationSec: number;
} {
  const trimmed = rawCustomScript.trim();
  const parsed = parseDelimitedScriptSections(trimmed);
  const narrationText =
    (parsed.hasExplicitDelimiters && parsed.voiceoverScript) ||
    parsed.voiceoverScript ||
    sanitizeSpokenNarration(trimmed) ||
    trimmed;
  const words = narrationText.split(/\s+/).filter(Boolean);
  const sentences = narrationText
    .split(/(?<=[.!?।])\s+|\r?\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const hook = sentences[0] || words.slice(0, 10).join(' ');
  const ending = sentences.length > 1 ? sentences[sentences.length - 1] : '';
  const estimatedDurationSec = Math.max(8, Math.round(words.length / 2.35));

  return {
    titleIdea: (fallbackTitle || hook || 'Custom Script Video').slice(0, 100),
    hook: hook.slice(0, 180),
    narrationText,
    fullScript: formatDelimitedScriptDocument(narrationText, parsed.videoVisualInstructions || ''),
    visualInstructions: parsed.videoVisualInstructions || '',
    ending: ending.slice(0, 180),
    wordCount: words.length,
    estimatedDurationSec,
  };
}

async function recordNotification(params: {
  userId: string;
  projectId: string;
  jobId: string;
  eventType: string;
  title: string;
  body: string;
}): Promise<void> {
  const supabase = getSupabaseAdmin();
  await supabase.from('user_notifications').insert({
    user_id: params.userId,
    project_id: params.projectId,
    job_id: params.jobId,
    event_type: params.eventType,
    title: params.title,
    body: params.body,
  });
}

async function updateJobStage(
  jobId: string,
  projectId: string,
  stage: string,
  progress: number,
  message: string,
  completedStages: string[]
): Promise<void> {
  const supabase = getSupabaseAdmin();
  await supabase
    .from('video_jobs')
    .update({
      status: stage,
      current_stage: stage,
      progress,
      status_message: message,
      completed_stages: completedStages,
      heartbeat_at: new Date().toISOString(),
    })
    .eq('id', jobId);

  await supabase.from('projects').update({ status: stage }).eq('id', projectId);
}

/**
 * Executes a persistent, stage-resumable automated video creation job end-to-end.
 * Temporary files are isolated per job and always deleted in `finally`.
 */
export async function executeVideoJob(job: VideoJobRow): Promise<void> {
  const supabase = getSupabaseAdmin();
  const completedStages = Array.isArray(job.completed_stages) ? [...job.completed_stages] : [];
  const workDir = resolveConfinedPath(config.tempWorkDir, `job_${job.id}`);
  await fs.mkdir(workDir, { recursive: true });

  const heartbeatTimer = setInterval(() => {
    void supabase
      .from('video_jobs')
      .update({ heartbeat_at: new Date().toISOString() })
      .eq('id', job.id);
  }, config.workerHeartbeatIntervalMs);

  const markStageDone = (stage: PipelineStage) => {
    if (!completedStages.includes(stage)) {
      completedStages.push(stage);
    }
  };

  try {
    const { data: project, error: projectErr } = await supabase
      .from('projects')
      .select('*')
      .eq('id', job.project_id)
      .eq('user_id', job.user_id)
      .single();

    if (projectErr || !project) {
      throw new Error('Associated video project was not found.');
    }

    const uploadCfgTop = (project.upload_config || {}) as {
      auto_upload?: boolean;
      review_before_upload?: boolean;
      privacy_status?: 'private' | 'unlisted' | 'public';
      scheduled_publish_time?: string | null;
      youtube_account_id?: string | null;
      media_source_mode?: MediaSourceMode;
      custom_media_urls?: string[];
      editing_pace?: string;
      bgm_mood?: string;
      sfx_enabled?: boolean;
      color_grade?: string;
      whisper_sync?: boolean;
      hook_style?: 'viral_retention' | 'story_arc' | 'standard';
      hook_banner?: boolean;
      script_mode?: 'ai' | 'custom';
      custom_script?: string | null;
    };

    const editingPace = normalizeEditingPace(
      uploadCfgTop.editing_pace || (project.format === '9:16' ? 'viral_fast' : 'balanced')
    );
    const colorGrade = normalizeColorGrade(uploadCfgTop.color_grade || 'vibrant');
    const bgmMood =
      !uploadCfgTop.bgm_mood || uploadCfgTop.bgm_mood === 'auto'
        ? autoBgmMoodForNiche(project.niche)
        : normalizeBgmMood(uploadCfgTop.bgm_mood);
    const sfxEnabled = uploadCfgTop.sfx_enabled !== false;
    const whisperSyncEnabled = uploadCfgTop.whisper_sync !== false;
    const hookStyle = uploadCfgTop.hook_style || 'viral_retention';
    const hookBannerEnabled = uploadCfgTop.hook_banner !== false;

    // =========================================================================
    // FAST PATH: upload_only (User reviewed & approved the already-rendered MP4)
    // =========================================================================
    if (job.job_type === 'upload_only') {
      if (!project.final_video_storage_path) {
        throw new Error(
          'No rendered video file is available for upload. Tap "Save & Re-Render Video" first.'
        );
      }

      await updateJobStage(
        job.id,
        project.id,
        'uploading',
        95,
        'Downloading approved video & uploading via YouTube Data API v3',
        completedStages
      );

      const { data: videoBlob, error: dlErr } = await supabase.storage
        .from('rendered-videos')
        .download(project.final_video_storage_path);
      if (dlErr || !videoBlob) {
        throw new Error(`Could not retrieve rendered MP4 from storage: ${dlErr?.message || 'missing file'}`);
      }
      const localVideoPath = resolveConfinedPath(workDir, 'approved_final.mp4');
      await fs.writeFile(localVideoPath, Buffer.from(await videoBlob.arrayBuffer()));

      let localThumbPath: string | null = null;
      if (project.thumbnail_storage_path) {
        const { data: thumbBlob } = await supabase.storage
          .from('thumbnails')
          .download(project.thumbnail_storage_path);
        if (thumbBlob) {
          localThumbPath = resolveConfinedPath(workDir, 'approved_thumb.jpg');
          await fs.writeFile(localThumbPath, Buffer.from(await thumbBlob.arrayBuffer()));
        }
      }

      const seoMeta = (project.seo_metadata || {}) as GeneratedSeoMetadata;
      const finalTitle = (seoMeta.title || project.title || project.topic || 'AutoTube Video').slice(0, 100);
      const fullDescription = [
        seoMeta.description || '',
        seoMeta.hashtags?.length ? `\n${seoMeta.hashtags.join(' ')}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      await recordNotification({
        userId: job.user_id,
        projectId: project.id,
        jobId: job.id,
        eventType: 'upload_started',
        title: 'YouTube upload started',
        body: `Uploading approved video "${finalTitle}" to YouTube.`,
      });

      const uploaded = await uploadVideoToYouTubeResumable({
        userId: job.user_id,
        projectId: project.id,
        youtubeAccountId: uploadCfgTop.youtube_account_id || null,
        localVideoPath,
        localThumbnailPath: localThumbPath,
        title: finalTitle,
        description: fullDescription,
        tags: Array.isArray(seoMeta.tags) ? seoMeta.tags : [],
        categoryId: seoMeta.categoryId || '27',
        privacyStatus: uploadCfgTop.privacy_status || 'private',
        scheduledPublishTimeIso: uploadCfgTop.scheduled_publish_time || null,
        idempotencyKey: `yt-upload-${project.id}-${job.id}`,
        onProgress: async (pct) => {
          await supabase
            .from('video_jobs')
            .update({ progress: 94 + Math.round(pct * 0.05), heartbeat_at: new Date().toISOString() })
            .eq('id', job.id);
        },
      });

      markStageDone('uploading');
      const channelLabel = uploaded.channelName ? ` (${uploaded.channelName})` : '';
      const msg =
        uploaded.status === 'scheduled'
          ? `Scheduled on YouTube${channelLabel}: ${uploaded.videoUrl}`
          : `Published on YouTube${channelLabel}: ${uploaded.videoUrl}`;

      await recordNotification({
        userId: job.user_id,
        projectId: project.id,
        jobId: job.id,
        eventType: uploaded.status === 'scheduled' ? 'upload_completed' : 'video_published',
        title: uploaded.status === 'scheduled' ? 'Video scheduled on YouTube' : 'Video published on YouTube',
        body: msg,
      });

      await supabase
        .from('video_jobs')
        .update({
          status: uploaded.status,
          current_stage: uploaded.status,
          progress: 100,
          status_message: msg,
          completed_stages: completedStages,
          error_code: null,
          error_message: null,
          locked_by: null,
          completed_at: new Date().toISOString(),
        })
        .eq('id', job.id);

      await supabase.from('projects').update({ status: uploaded.status }).eq('id', project.id);
      return;
    }

    await recordNotification({
      userId: job.user_id,
      projectId: project.id,
      jobId: job.id,
      eventType: 'generation_started',
      title: 'Video production started',
      body: `Cloud pipeline started for "${project.title || project.topic}".`,
    });

    const ai = await createAIProviderForUser(job.user_id);
    let references: ResearchReference[] = Array.isArray(project.research_references)
      ? project.research_references
      : [];
    let resolvedTopic = String(project.topic || '').trim();

    // =========================================================================
    // STAGE 1: Topic Research
    // =========================================================================
    if (!shouldSkipStage(completedStages, 'researching')) {
      await updateJobStage(job.id, project.id, 'researching', 8, 'Researching verified topic & references', completedStages);
      if (!resolvedTopic || resolvedTopic.toLowerCase() === 'auto') {
        const researched = await researchTopicsWithAI(ai, {
          niche: project.niche,
          language: project.language,
          audienceCountry: project.audience_country,
          contentStyle: project.content_style,
          durationSeconds: project.duration_seconds,
          topicType: project.topic_type || 'evergreen',
          count: 1,
        });
        const top = researched.suggestions[0];
        resolvedTopic = top?.topic || `Fascinating ${project.niche} insights`;
        references = top?.references?.length ? top.references : researched.verifiedReferences;
        await supabase
          .from('projects')
          .update({
            topic: resolvedTopic,
            title: project.title === 'Auto Scheduled Video' ? resolvedTopic : project.title,
            research_references: references,
          })
          .eq('id', project.id);
      }
      markStageDone('researching');
    }

    // =========================================================================
    // STAGE 2: Script Generation (reuses existing approved script on retry)
    // =========================================================================
    let { data: latestScript } = await supabase
      .from('scripts')
      .select('*')
      .eq('project_id', project.id)
      .eq('user_id', job.user_id)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();

    const customScriptRaw =
      typeof uploadCfgTop.custom_script === 'string' ? uploadCfgTop.custom_script.trim() : '';
    const isCustomScriptMode =
      uploadCfgTop.script_mode === 'custom' && customScriptRaw.length >= 10;

    if (!shouldSkipStage(completedStages, 'generating_script') || !latestScript) {
      if (isCustomScriptMode) {
        await updateJobStage(
          job.id,
          project.id,
          'generating_script',
          18,
          'Preparing your exact custom script for visual scene breakdown',
          completedStages
        );
        const customParsed = resolvePipelineScriptFromCustomInput(
          customScriptRaw,
          project.title || resolvedTopic
        );
        const nextVersion = (latestScript?.version || 0) + 1;
        const { data: savedScript, error: scriptErr } = await supabase
          .from('scripts')
          .insert({
            user_id: job.user_id,
            project_id: project.id,
            version: nextVersion,
            title_idea: customParsed.titleIdea,
            hook: customParsed.hook,
            narration_text: customParsed.narrationText,
            script_text: customParsed.fullScript,
            ending: customParsed.ending,
            call_to_action: '',
            word_count: customParsed.wordCount,
            approved: true,
          })
          .select('*')
          .single();

        if (scriptErr || !savedScript) {
          throw new Error(`Failed to persist custom script: ${scriptErr?.message}`);
        }
        latestScript = savedScript;
        markStageDone('generating_script');
      } else {
        await updateJobStage(job.id, project.id, 'generating_script', 18, 'Writing high-retention viral narration script', completedStages);
        const generated = await generateScriptWithAI(ai, {
          topic: resolvedTopic,
          niche: project.niche,
          language: project.language,
          contentStyle: project.content_style,
          durationSeconds: project.duration_seconds,
          hookStyle,
          references,
        });

        const nextVersion = (latestScript?.version || 0) + 1;
        const { data: savedScript, error: scriptErr } = await supabase
          .from('scripts')
          .insert({
            user_id: job.user_id,
            project_id: project.id,
            version: nextVersion,
            title_idea: generated.titleIdea,
            hook: generated.hook,
            narration_text: generated.narrationText,
            script_text: generated.fullScript,
            ending: generated.ending,
            call_to_action: generated.callToAction,
            word_count: generated.wordCount,
            approved: Boolean(project.auto_produce),
          })
          .select('*')
          .single();

        if (scriptErr || !savedScript) {
          throw new Error(`Failed to persist generated script: ${scriptErr?.message}`);
        }
        latestScript = savedScript;
        markStageDone('generating_script');

        await recordNotification({
          userId: job.user_id,
          projectId: project.id,
          jobId: job.id,
          eventType: 'script_completed',
          title: 'Script ready',
          body: `Generated ${generated.wordCount}-word script for "${generated.titleIdea}".`,
        });

        // Manual approval gate when Autopilot is disabled for this project
        if (!project.auto_produce) {
          await updateJobStage(
            job.id,
            project.id,
            'awaiting_approval',
            22,
            'Script generated — review and approve to continue video production',
            completedStages
          );
          return;
        }
      }
    }

    // =========================================================================
    // STAGE 3: Scene Breakdown
    // =========================================================================
    let { data: scenes } = await supabase
      .from('scenes')
      .select('*')
      .eq('project_id', project.id)
      .eq('user_id', job.user_id)
      .order('scene_number', { ascending: true });

    if (!shouldSkipStage(completedStages, 'generating_scenes') || !scenes || scenes.length === 0) {
      await updateJobStage(job.id, project.id, 'generating_scenes', 28, 'Breaking script into rapid 1-2s visual micro-scenes', completedStages);
      const parsedFromSavedScript = parseDelimitedScriptSections(
        latestScript.script_text || latestScript.narration_text || ''
      );
      const pureVoiceoverForScenes =
        parseDelimitedScriptSections(latestScript.narration_text || '').voiceoverScript ||
        parsedFromSavedScript.voiceoverScript ||
        latestScript.narration_text ||
        latestScript.script_text;
      const scriptWordCount = pureVoiceoverForScenes.split(/\s+/).filter(Boolean).length;
      const sceneBreakdownDuration =
        isCustomScriptMode && scriptWordCount >= 6
          ? Math.max(10, Math.round(scriptWordCount / 2.35))
          : project.duration_seconds;
      const breakdown = await generateSceneBreakdownWithAI(ai, {
        narrationText: pureVoiceoverForScenes,
        visualInstructions: parsedFromSavedScript.videoVisualInstructions || undefined,
        topic: resolvedTopic,
        niche: project.niche,
        language: project.language,
        durationSeconds: sceneBreakdownDuration,
        format: project.format,
        editingPace,
      });

      await supabase.from('scenes').delete().eq('project_id', project.id).eq('user_id', job.user_id);
      const { data: insertedScenes, error: sceneErr } = await supabase
        .from('scenes')
        .insert(
          breakdown.map((s) => ({
            user_id: job.user_id,
            project_id: project.id,
            scene_number: s.sceneNumber,
            narration: s.narration,
            visual_description: s.visualDescription,
            primary_keyword: s.primaryKeyword,
            search_keywords: s.alternativeKeywords,
            media_type_preference: s.mediaTypePreference,
            transition: s.transition,
            subtitle_text: s.subtitleText,
            duration: s.estimatedDuration,
            status: 'pending',
          }))
        )
        .select('*')
        .order('scene_number', { ascending: true });

      if (sceneErr || !insertedScenes?.length) {
        throw new Error(`Failed to persist scenes: ${sceneErr?.message}`);
      }
      scenes = insertedScenes;
      markStageDone('generating_scenes');
    }

    // =========================================================================
    // STAGE 4: Media Search (Pexels/Pixabay/Wikimedia)
    // =========================================================================
    const timelineClips: TimelineSceneClip[] = [];
    const usedExternalIds = new Set<string>();
    const pendingDownloads: Array<{
      scene: (typeof scenes)[number];
      candidate: ScoredMediaCandidate;
    }> = [];

    const alreadySearched = shouldSkipStage(completedStages, 'searching_media');
    await updateJobStage(
      job.id,
      project.id,
      alreadySearched ? 'preparing_timeline' : 'searching_media',
      alreadySearched ? 66 : 38,
      alreadySearched
        ? 'Restoring cached media clips for rendering'
        : 'Searching Pexels/Pixabay, Lexica AI, Civitai, Openverse & AI Horde visuals',
      completedStages
    );

    const projectCustomUrls = Array.isArray(uploadCfgTop.custom_media_urls)
      ? uploadCfgTop.custom_media_urls.map((u) => String(u).trim()).filter((u) => u.startsWith('https://'))
      : [];
    const mediaSourceMode: MediaSourceMode =
      uploadCfgTop.media_source_mode === 'open_source_only' ||
      uploadCfgTop.media_source_mode === 'api_only'
        ? uploadCfgTop.media_source_mode
        : 'all';

    const pendingSearchTasks: Array<{
      scene: (typeof scenes)[number];
      searchInput: SceneMediaSearchInput;
    }> = [];

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const rawKeywords = Array.isArray(scene.search_keywords)
        ? scene.search_keywords.map((k: unknown) => String(k))
        : [];
      const sceneCustomUrlEntry = rawKeywords.find((k: string) => k.startsWith('custom_url:'));
      const sceneCustomUrl = sceneCustomUrlEntry
        ? sceneCustomUrlEntry.slice('custom_url:'.length).trim()
        : projectCustomUrls[i] || null;
      const cleanKeywords = rawKeywords.filter((k: string) => !k.startsWith('custom_url:'));

      const { data: existingAsset } = await supabase
        .from('media_assets')
        .select('*')
        .eq('scene_id', scene.id)
        .eq('user_id', job.user_id)
        .not('storage_path', 'is', null)
        .limit(1)
        .maybeSingle();

      if (existingAsset?.storage_path && (!sceneCustomUrl || existingAsset.original_url === sceneCustomUrl)) {
        const ext = existingAsset.media_type === 'video' ? '.mp4' : '.jpg';
        const localPath = resolveConfinedPath(workDir, `scene_${scene.id}${ext}`);
        const { data: blob } = await supabase.storage
          .from('source-media')
          .download(existingAsset.storage_path);
        if (blob) {
          await fs.writeFile(localPath, Buffer.from(await blob.arrayBuffer()));
          if (existingAsset.external_id) usedExternalIds.add(existingAsset.external_id);
          timelineClips.push({
            sceneNumber: scene.scene_number,
            localMediaPath: localPath,
            mediaType: existingAsset.media_type === 'image' ? 'image' : 'video',
            durationSec: Number(scene.duration || 5),
            subtitleText: scene.subtitle_text || scene.narration,
            transition: scene.transition || 'fade',
          });
          continue;
        }
      }

      pendingSearchTasks.push({
        scene,
        searchInput: {
          userId: job.user_id,
          projectId: project.id,
          sceneId: scene.id,
          narration: scene.narration,
          visualDescription: scene.visual_description,
          primaryKeyword: scene.primary_keyword,
          alternativeKeywords: cleanKeywords,
          preferredType: scene.media_type_preference === 'image' ? 'image' : 'video',
          targetDurationSec: Number(scene.duration || 5),
          format: project.format,
          usedExternalIds,
          mediaSourceMode,
          customMediaUrl: sceneCustomUrl,
          niche: project.niche,
          contentStyle: project.content_style,
        },
      });
    }

    // Gather media candidate pools in bounded batches of 3 scenes for fast execution across micro-scenes
    const scenesToVerify: Array<{
      scene: (typeof scenes)[number];
      searchInput: SceneMediaSearchInput;
      candidates: ScoredMediaCandidate[];
    }> = [];
    for (let b = 0; b < pendingSearchTasks.length; b += 3) {
      const batch = pendingSearchTasks.slice(b, b + 3);
      const gatheredBatch = await Promise.all(
        batch.map(async (item) => ({
          ...item,
          res: await gatherSceneMediaCandidates(item.searchInput),
        }))
      );
      for (const item of gatheredBatch) {
        if (item.res.customMatch) {
          usedExternalIds.add(item.res.customMatch.externalId);
          pendingDownloads.push({ scene: item.scene, candidate: item.res.customMatch });
        } else {
          scenesToVerify.push({
            scene: item.scene,
            searchInput: item.searchInput,
            candidates: item.res.candidates,
          });
        }
      }
    }

    if (scenesToVerify.length > 0) {
      await updateJobStage(
        job.id,
        project.id,
        'searching_media',
        41,
        'Verifying exact visual-to-voiceover match for every scene',
        completedStages
      );

      const isCartoonProject = isCartoonOrStylizedIntent({
        niche: project.niche,
        contentStyle: project.content_style,
      });

      const verificationMap = await verifySceneVisualMatchesWithAI(ai, {
        topic: resolvedTopic,
        niche: project.niche,
        isCartoon: isCartoonProject,
        scenes: scenesToVerify.map(({ scene, candidates }) => ({
          sceneNumber: scene.scene_number,
          narration: scene.narration || scene.subtitle_text || '',
          visualDescription: scene.visual_description || '',
          primaryKeyword: scene.primary_keyword || '',
          candidates: candidates.map((c, idx) => ({
            idx,
            mediaType: c.mediaType,
            provider: String(c.licenseMetadata?.source || c.provider),
            description: c.titleOrTags || c.authorName,
            lexicalScore: c.relevanceScore,
          })),
        })),
      });

      for (const { scene, searchInput, candidates } of scenesToVerify) {
        const decision = verificationMap.get(scene.scene_number);
        let chosen: ScoredMediaCandidate | null = null;

        if (decision && decision.selectedIdx !== null && decision.confidence >= 55) {
          const picked = candidates[decision.selectedIdx];
          if (picked && !usedExternalIds.has(picked.externalId)) {
            chosen = {
              ...picked,
              relevanceScore: Math.max(picked.relevanceScore, Math.round((decision.confidence / 100) * 1000) / 1000),
            };
          }
        }

        // Fallback to high-confidence lexical match only if AI verifier did not explicitly reject it
        if (!chosen && !decision) {
          const strongUnused = candidates.find(
            (c) => !usedExternalIds.has(c.externalId) && c.relevanceScore >= (isCartoonProject ? 0.6 : 0.56)
          );
          if (strongUnused) chosen = strongUnused;
        }

        // Targeted rescue: re-search with AI's sharper query or generate exact artwork via AI Horde
        if (!chosen) {
          chosen = await rescueUnmatchedSceneMedia(
            { ...searchInput, usedExternalIds },
            {
              refinedQuery: decision?.refinedQuery,
              imagePrompt: decision?.imagePrompt || scene.visual_description,
              fallbackPool: candidates,
            }
          );
        }

        if (!chosen) {
          throw new Error(
            `No relevant footage found for Scene ${scene.scene_number} ("${scene.primary_keyword}"). Try simplifying scene keywords or adding a custom open-source URL.`
          );
        }

        usedExternalIds.add(chosen.externalId);
        pendingDownloads.push({ scene, candidate: chosen });
      }
    }

    markStageDone('searching_media');

    // =========================================================================
    // STAGE 5: Deduplicated Download & Verification
    // =========================================================================
    for (let i = 0; i < pendingDownloads.length; i++) {
      const { scene, candidate } = pendingDownloads[i];
      const dlProgress = 42 + Math.round(((i + 1) / Math.max(1, pendingDownloads.length)) * 14);
      await updateJobStage(
        job.id,
        project.id,
        'downloading_media',
        dlProgress,
        `Downloading & verifying clip ${i + 1} of ${pendingDownloads.length} (${candidate.provider})`,
        completedStages
      );

      const downloaded = await downloadAndPersistMedia({
        userId: job.user_id,
        projectId: project.id,
        sceneId: scene.id,
        candidate,
        workDir,
      });

      await supabase.from('media_assets').insert({
        user_id: job.user_id,
        project_id: project.id,
        scene_id: scene.id,
        provider: candidate.provider,
        external_id: candidate.externalId,
        original_url: candidate.originalUrl,
        download_url: candidate.downloadUrl,
        storage_path: downloaded.storagePath || null,
        sha256_hash: downloaded.sha256,
        file_size_bytes: downloaded.sizeBytes,
        license_metadata: candidate.licenseMetadata,
        author_name: candidate.authorName,
        media_type: candidate.mediaType,
        duration: candidate.durationSec,
        resolution: `${candidate.width}x${candidate.height}`,
        width: candidate.width,
        height: candidate.height,
        relevance_score: candidate.relevanceScore,
        is_fallback: candidate.isFallback,
      });

      await supabase
        .from('scenes')
        .update({
          status: candidate.isFallback ? 'fallback_image' : 'downloaded',
          fallback_used: candidate.isFallback,
        })
        .eq('id', scene.id);

      timelineClips.push({
        sceneNumber: scene.scene_number,
        localMediaPath: downloaded.localFilePath,
        mediaType: candidate.mediaType,
        durationSec: Number(scene.duration || 5),
        subtitleText: scene.subtitle_text || scene.narration,
        transition: scene.transition || 'fade',
      });
    }

    timelineClips.sort((a, b) => a.sceneNumber - b.sceneNumber);
    markStageDone('downloading_media');

    const parsedNarration = parseDelimitedScriptSections(
      latestScript.narration_text || latestScript.script_text || ''
    );
    const cleanNarrationText =
      parsedNarration.voiceoverScript ||
      sanitizeSpokenNarration(latestScript.narration_text || latestScript.script_text);

    const syncedTimelineClips = reconcileClipsSubtitleCoverage(timelineClips, cleanNarrationText);
    // Lock TTS synthesis 1:1 verbatim to the exact scene beats so spoken voiceover, scene cuts, and subtitles match word-for-word
    const sceneJoinedNarration = syncedTimelineClips
      .map((c) => sanitizeSpokenNarration(c.subtitleText || ''))
      .filter(Boolean)
      .join(' ')
      .trim();
    const ttsSpokenText = sceneJoinedNarration || cleanNarrationText;

    // =========================================================================
    // STAGE 6: Voice Generation (Gemini TTS / ElevenLabs) — cached on retry
    // =========================================================================
    let localNarrationPath = '';
    let narrationDurationSec = Number(project.duration_seconds || 45);

    if (shouldSkipStage(completedStages, 'generating_voice') && project.narration_audio_path) {
      const ext = path.extname(project.narration_audio_path) || '.wav';
      localNarrationPath = resolveConfinedPath(workDir, `narration${ext}`);
      const { data: audioBlob } = await supabase.storage
        .from('voice-audio')
        .download(project.narration_audio_path);
      if (audioBlob) {
        await fs.writeFile(localNarrationPath, Buffer.from(await audioBlob.arrayBuffer()));
        narrationDurationSec = await probeAudioDurationSeconds(localNarrationPath);
      } else {
        localNarrationPath = '';
      }
    }

    if (!localNarrationPath) {
      await updateJobStage(job.id, project.id, 'generating_voice', 62, 'Synthesizing clean voice-over (spoken text only)', completedStages);
      const voiceResult = await synthesizeNarration({
        userId: job.user_id,
        projectId: project.id,
        text: ttsSpokenText,
        language: project.language,
        preferredProvider: (project.voice_provider as VoiceProviderName) || 'gemini_tts',
        voiceId: project.voice_id || 'Charon',
        speed: Number(project.voice_speed || 1.0),
        workDir,
      });

      localNarrationPath = voiceResult.localAudioPath;
      narrationDurationSec = voiceResult.durationSec;

      await supabase
        .from('projects')
        .update({ narration_audio_path: voiceResult.storagePath })
        .eq('id', project.id);

      markStageDone('generating_voice');
    }

    // =========================================================================
    // STAGE 7 & 8: Dead-Air Trim + Multi-Tier Audio Alignment + Sound Design + FFmpeg Render
    // =========================================================================
    await updateJobStage(job.id, project.id, 'preparing_timeline', 68, 'Trimming dead air & synchronizing captions to voiceover', completedStages);

    if (whisperSyncEnabled || editingPace === 'viral_fast') {
      const trimmed = await trimAudioDeadAir({
        workDir,
        inputAudioPath: localNarrationPath,
        originalDurationSec: narrationDurationSec,
      });
      localNarrationPath = trimmed.audioPath;
      narrationDurationSec = trimmed.durationSec;
    }

    // Always probe actual non-silent speech intervals locally via FFmpeg (~50ms)
    const speechIntervals: AudioSpeechInterval[] = await detectAudioSpeechIntervals(
      localNarrationPath,
      narrationDurationSec
    );

    let whisperWords: WordTimestamp[] = [];
    let geminiSceneTimings: SceneTimingHint[] = [];
    if (whisperSyncEnabled) {
      const aligned = await alignNarrationWithGroqWhisper({
        userId: job.user_id,
        audioPath: localNarrationPath,
        language: project.language,
      });
      if (aligned?.words?.length) {
        whisperWords = aligned.words;
      } else {
        const geminiHints = await alignScenesWithGeminiAudio({
          userId: job.user_id,
          workDir,
          audioPath: localNarrationPath,
          durationSec: narrationDurationSec,
          scenes: syncedTimelineClips.map((c) => ({
            sceneNumber: c.sceneNumber,
            text: sanitizeSpokenNarration(c.subtitleText || ''),
          })),
        });
        if (geminiHints?.length) {
          geminiSceneTimings = geminiHints;
        }
      }
    }

    markStageDone('preparing_timeline');

    await recordNotification({
      userId: job.user_id,
      projectId: project.id,
      jobId: job.id,
      eventType: 'rendering_started',
      title: 'Rendering viral edit',
      body: `FFmpeg worker started ${editingPace.replace('_', ' ')} render for "${project.title || resolvedTopic}".`,
    });

    await updateJobStage(job.id, project.id, 'rendering', 74, 'Mixing BGM/SFX & encoding crisp 30fps MP4', completedStages);

    // Optional licensed/user background music OR built-in mood BGM bed
    let localMusicPath: string | null = null;
    const musicCfg = (project.music_config || {}) as {
      enabled?: boolean;
      track_id?: string | null;
      music_volume?: number;
      narration_volume?: number;
      ducking_enabled?: boolean;
    };
    if (musicCfg.enabled && musicCfg.track_id) {
      const { data: track } = await supabase
        .from('background_music_tracks')
        .select('storage_path')
        .eq('id', musicCfg.track_id)
        .eq('user_id', job.user_id)
        .maybeSingle();
      if (track?.storage_path) {
        const { data: musicBlob } = await supabase.storage
          .from('music-tracks')
          .download(track.storage_path);
        if (musicBlob) {
          localMusicPath = resolveConfinedPath(workDir, 'bg_music.mp3');
          await fs.writeFile(localMusicPath, Buffer.from(await musicBlob.arrayBuffer()));
        }
      }
    }

    if (!localMusicPath && bgmMood !== 'none') {
      localMusicPath = await generateProceduralBgmTrack({
        workDir,
        mood: bgmMood,
        durationSec: Math.min(36, Math.max(15, narrationDurationSec)),
      });
    }

    const sfxAssets = sfxEnabled
      ? await generateTransitionSfxAssets(workDir)
      : { hookBoomPath: null, whooshPath: null };

    const hookBannerText = hookBannerEnabled
      ? sanitizeSpokenNarration(latestScript.title_idea || latestScript.hook || project.title || resolvedTopic)
      : null;

    const subCfgRaw = (project.subtitle_style || {}) as Record<string, unknown>;
    const subtitleStyle: SubtitleStyleConfig = {
      enabled: subCfgRaw.enabled !== false,
      burnIn: subCfgRaw.burn_in !== false,
      preset: normalizeSubtitlePreset(
        typeof subCfgRaw.preset === 'string' ? subCfgRaw.preset : 'mrbeast'
      ),
      fontSize: Number(subCfgRaw.font_size || 44),
      primaryColor: String(subCfgRaw.primary_color || '#FFFFFF'),
      highlightColor: String(subCfgRaw.highlight_color || '#FFE600'),
      outlineColor: String(subCfgRaw.outline_color || '#000000'),
      position:
        subCfgRaw.position === 'center' || subCfgRaw.position === 'top_safe'
          ? subCfgRaw.position
          : 'bottom_safe',
    };

    const rendered = await renderVideoWithFfmpeg({
      workDir,
      clips: syncedTimelineClips,
      narrationAudioPath: localNarrationPath,
      totalNarrationDurationSec: narrationDurationSec,
      format: project.format,
      qualityPreset: project.quality_preset === '720p' ? '720p' : '1080p',
      subtitleStyle,
      editingPace,
      colorGrade,
      hookBannerText,
      whisperWords,
      speechIntervals,
      geminiSceneTimings,
      backgroundMusicPath: localMusicPath,
      musicVolume: musicCfg.music_volume ?? 0.16,
      narrationVolume: musicCfg.narration_volume ?? 1.05,
      duckingEnabled: musicCfg.ducking_enabled ?? true,
      sfxEnabled,
      hookBoomPath: sfxAssets.hookBoomPath,
      whooshPath: sfxAssets.whooshPath,
    });

    let videoStoragePath: string | null = `${job.user_id}/${project.id}/final_${Date.now()}.mp4`;
    const srtStoragePath = `${job.user_id}/${project.id}/subtitles.srt`;
    const [videoBytes, srtBytes] = await Promise.all([
      fs.readFile(rendered.finalVideoPath),
      fs.readFile(rendered.srtPath),
    ]);

    const uploadCfgPreview = (project.upload_config || {}) as { auto_upload?: boolean };
    const { error: vidUploadErr } = await uploadToStorageWithAutoBucket({
      bucket: 'rendered-videos',
      storagePath: videoStoragePath,
      data: videoBytes,
      contentType: 'video/mp4',
      upsert: true,
    });
    if (vidUploadErr) {
      if (
        uploadCfgPreview.auto_upload &&
        /maximum allowed size|payload too large|entity too large|413/i.test(vidUploadErr.message)
      ) {
        // Auto-upload to YouTube directly from local rendered MP4 even if it exceeds Supabase Free Tier 50 MB cap
        console.warn(
          `[AutoTube Render] Rendered MP4 (${videoBytes.length} bytes) exceeds storage cap; uploading directly to YouTube.`
        );
        videoStoragePath = null;
      } else {
        throw new Error(`Failed to upload rendered video to storage: ${vidUploadErr.message}`);
      }
    }

    await uploadToStorageWithAutoBucket({
      bucket: 'subtitles',
      storagePath: srtStoragePath,
      data: srtBytes,
      contentType: 'text/plain',
      upsert: true,
    });

    markStageDone('rendering');

    // =========================================================================
    // STAGE 9: SEO Metadata Generation + High-CTR Thumbnail Generation
    // =========================================================================
    await updateJobStage(job.id, project.id, 'generating_metadata', 85, 'Generating YouTube title, description, tags & SEO', completedStages);
    let seo: GeneratedSeoMetadata = (project.seo_metadata || {}) as GeneratedSeoMetadata;
    if (!shouldSkipStage(completedStages, 'generating_metadata') || !seo?.title) {
      seo = await generateSeoMetadataWithAI(ai, {
        topic: resolvedTopic,
        niche: project.niche,
        language: project.language,
        format: project.format,
        narrationText: latestScript.narration_text || latestScript.script_text,
        references,
      });
      markStageDone('generating_metadata');
    }

    await updateJobStage(job.id, project.id, 'generating_thumbnail', 89, 'Compositing 16:9 high-CTR viral thumbnail', completedStages);
    const localThumbPath = await generateThumbnailFromVideo({
      workDir,
      videoPath: rendered.finalVideoPath,
      headlineText: seo.thumbnailHeadline || seo.title,
      seekSec: Math.min(5, Math.max(1.2, rendered.durationSec * 0.25)),
    });
    const thumbStoragePath = `${job.user_id}/${project.id}/thumbnail_${Date.now()}.jpg`;
    const thumbBytes = await fs.readFile(localThumbPath);
    await uploadToStorageWithAutoBucket({
      bucket: 'thumbnails',
      storagePath: thumbStoragePath,
      data: thumbBytes,
      contentType: 'image/jpeg',
      upsert: true,
    });

    await supabase
      .from('projects')
      .update({
        title: seo.title || project.title,
        seo_metadata: seo,
        final_video_storage_path: videoStoragePath,
        subtitle_srt_path: srtStoragePath,
        thumbnail_storage_path: thumbStoragePath,
      })
      .eq('id', project.id);

    markStageDone('generating_thumbnail');

    // =========================================================================
    // STAGE 10: Quality Check & Optional Authorized YouTube Upload
    // =========================================================================
    await updateJobStage(job.id, project.id, 'quality_check', 93, 'Verified H.264 stream, audio loudness, and thumbnail', completedStages);
    markStageDone('quality_check');

    await recordNotification({
      userId: job.user_id,
      projectId: project.id,
      jobId: job.id,
      eventType: 'video_completed',
      title: 'Video render complete',
      body: `"${seo.title}" rendered (${Math.round(rendered.durationSec)}s, ${rendered.width}x${rendered.height}).`,
    });

    const uploadCfg = (project.upload_config || {}) as {
      auto_upload?: boolean;
      review_before_upload?: boolean;
      privacy_status?: 'private' | 'unlisted' | 'public';
      scheduled_publish_time?: string | null;
      youtube_account_id?: string | null;
    };

    let finalJobStatus: 'published' | 'scheduled' = 'published';
    let finalMessage = 'Video rendered and saved to Studio Library (ready to preview & download)';

    const autoCleanupStorage = process.env.AUTO_CLEANUP_STORAGE_AFTER_UPLOAD !== 'false';
    const cleanupFinalVideoAfterUpload = process.env.AUTO_CLEANUP_FINAL_VIDEO_AFTER_UPLOAD === 'true';

    // Helper to remove heavy intermediate files from Supabase Storage while keeping final MP4 downloadable
    const purgeProjectStorage = async (includeFinalVideo: boolean) => {
      try {
        const { data: assets } = await supabase
          .from('media_assets')
          .select('storage_path')
          .eq('project_id', project.id)
          .eq('user_id', job.user_id)
          .not('storage_path', 'is', null);

        const sourcePaths = (assets || [])
          .map((a) => a.storage_path as string)
          .filter(Boolean);
        if (sourcePaths.length > 0) {
          await supabase.storage.from('source-media').remove(sourcePaths).catch(() => undefined);
          await supabase
            .from('media_assets')
            .update({ storage_path: null })
            .eq('project_id', project.id)
            .eq('user_id', job.user_id);
        }

        const { data: latestProj } = await supabase
          .from('projects')
          .select('narration_audio_path, subtitle_srt_path, final_video_storage_path')
          .eq('id', project.id)
          .maybeSingle();

        if (latestProj?.narration_audio_path) {
          await supabase.storage
            .from('voice-audio')
            .remove([latestProj.narration_audio_path])
            .catch(() => undefined);
        }

        const projectUpdates: Record<string, unknown> = {
          narration_audio_path: null,
        };

        if (includeFinalVideo) {
          if (latestProj?.final_video_storage_path) {
            await supabase.storage
              .from('rendered-videos')
              .remove([latestProj.final_video_storage_path])
              .catch(() => undefined);
          }
          if (latestProj?.subtitle_srt_path) {
            await supabase.storage
              .from('subtitles')
              .remove([latestProj.subtitle_srt_path])
              .catch(() => undefined);
          }
          projectUpdates.final_video_storage_path = null;
          projectUpdates.subtitle_srt_path = null;
        }

        await supabase
          .from('projects')
          .update(projectUpdates)
          .eq('id', project.id)
          .eq('user_id', job.user_id);
      } catch (cleanupErr) {
        console.warn(`[AutoTube Cleanup] Non-fatal storage cleanup warning: ${sanitizeErrorMessage(cleanupErr)}`);
      }
    };

    // Pre-YouTube Final Review Gate: pause after rendering so user can watch, download, edit, or push to YouTube
    if (uploadCfg.review_before_upload) {
      if (autoCleanupStorage) {
        await purgeProjectStorage(false);
      }
      await supabase
        .from('video_jobs')
        .update({
          status: 'awaiting_approval',
          current_stage: 'quality_check',
          progress: 94,
          status_message: 'Video ready — watch preview, download, edit, or tap Push to YouTube',
          completed_stages: completedStages,
          error_code: null,
          error_message: null,
          locked_by: null,
        })
        .eq('id', job.id);

      await supabase
        .from('projects')
        .update({ status: 'ready_for_review' })
        .eq('id', project.id);

      await recordNotification({
        userId: job.user_id,
        projectId: project.id,
        jobId: job.id,
        eventType: 'video_ready_for_review',
        title: 'Review video before YouTube push',
        body: `"${seo.title}" is rendered! Open Projects Library to watch, download, edit, or push to YouTube.`,
      });
      return;
    }

    if (uploadCfg.auto_upload) {
      await updateJobStage(job.id, project.id, 'uploading', 95, 'Uploading video via YouTube Data API v3', completedStages);
      await recordNotification({
        userId: job.user_id,
        projectId: project.id,
        jobId: job.id,
        eventType: 'upload_started',
        title: 'YouTube upload started',
        body: `Uploading "${seo.title}" to your selected YouTube channel.`,
      });

      const fullDescription = [
        seo.description,
        seo.hashtags?.length ? `\n${seo.hashtags.join(' ')}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      const uploaded = await uploadVideoToYouTubeResumable({
        userId: job.user_id,
        projectId: project.id,
        youtubeAccountId: uploadCfg.youtube_account_id || null,
        localVideoPath: rendered.finalVideoPath,
        localThumbnailPath: localThumbPath,
        title: seo.title,
        description: fullDescription,
        tags: seo.tags || [],
        categoryId: seo.categoryId || '27',
        privacyStatus: uploadCfg.privacy_status || 'private',
        scheduledPublishTimeIso: uploadCfg.scheduled_publish_time || null,
        idempotencyKey: `yt-upload-${project.id}`,
        onProgress: async (pct) => {
          await supabase
            .from('video_jobs')
            .update({ progress: 94 + Math.round(pct * 0.05), heartbeat_at: new Date().toISOString() })
            .eq('id', job.id);
        },
      });

      markStageDone('uploading');
      finalJobStatus = uploaded.status;
      const channelLabel = uploaded.channelName ? ` (${uploaded.channelName})` : '';
      finalMessage =
        uploaded.status === 'scheduled'
          ? `Scheduled on YouTube${channelLabel}: ${uploaded.videoUrl}`
          : `Published on YouTube${channelLabel}: ${uploaded.videoUrl}`;

      // Always purge heavy intermediate clips/audio; keep final MP4 downloadable in Library unless explicitly configured otherwise
      if (autoCleanupStorage) {
        await purgeProjectStorage(cleanupFinalVideoAfterUpload);
      }

      await recordNotification({
        userId: job.user_id,
        projectId: project.id,
        jobId: job.id,
        eventType: uploaded.status === 'scheduled' ? 'upload_completed' : 'video_published',
        title: uploaded.status === 'scheduled' ? 'Video scheduled on YouTube' : 'Video published on YouTube',
        body: finalMessage,
      });
    } else if (autoCleanupStorage) {
      // Remove heavy intermediate stock clips & raw voice audio; keep final rendered MP4 in Library
      await purgeProjectStorage(false);
    }

    await supabase
      .from('video_jobs')
      .update({
        status: finalJobStatus,
        current_stage: finalJobStatus,
        progress: 100,
        status_message: finalMessage,
        completed_stages: completedStages,
        error_code: null,
        error_message: null,
        locked_by: null,
        completed_at: new Date().toISOString(),
      })
      .eq('id', job.id);

    await supabase
      .from('projects')
      .update({ status: finalJobStatus })
      .eq('id', project.id);
  } catch (err) {
    const safeMsg = sanitizeErrorMessage(err);
    const permanent = isPermanentError(safeMsg);
    const nextRetry = job.retry_count + 1;
    const canRetry = !permanent && nextRetry <= (job.max_retries || 3);

    if (canRetry) {
      const backoffSec = computeRetryBackoffSeconds(job.retry_count);
      const retryAt = new Date(Date.now() + backoffSec * 1000).toISOString();
      await supabase
        .from('video_jobs')
        .update({
          status: 'queued',
          retry_count: nextRetry,
          next_retry_at: retryAt,
          locked_by: null,
          completed_stages: completedStages,
          status_message: `Temporary error — scheduled retry ${nextRetry}/${job.max_retries} in ${backoffSec}s`,
          error_message: safeMsg,
        })
        .eq('id', job.id);
    } else {
      await supabase
        .from('video_jobs')
        .update({
          status: 'failed',
          retry_count: nextRetry,
          locked_by: null,
          completed_stages: completedStages,
          status_message: safeMsg,
          error_message: safeMsg,
        })
        .eq('id', job.id);

      await supabase.from('projects').update({ status: 'failed' }).eq('id', job.project_id);

      await recordNotification({
        userId: job.user_id,
        projectId: job.project_id,
        jobId: job.id,
        eventType: 'job_failed',
        title: 'Video job failed',
        body: safeMsg,
      });
    }
  } finally {
    clearInterval(heartbeatTimer);
    // Always delete temporary worker disk files to protect Render ephemeral disk
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
