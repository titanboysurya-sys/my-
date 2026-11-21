import crypto from 'node:crypto';
import { Router, type Response } from 'express';
import { z } from 'zod';
import { config, sanitizeErrorMessage } from '../config/env.js';
import { createSignedStorageUrl, getSupabaseAdmin } from '../db/supabase.js';
import {
  getAuthUserId,
  requireAuth,
  sensitiveRateLimiter,
  type AuthenticatedRequest,
} from '../middleware/auth.js';
import {
  createAIProviderForUser,
  generateScriptWithAI,
  researchTopicsWithAI,
} from '../services/aiProvider.js';
import {
  deleteUserCredential,
  listUserCredentials,
  upsertUserCredential,
  validateProviderKey,
  type SupportedProvider,
} from '../services/credentialService.js';
import {
  buildYouTubeOAuthConsentUrl,
  disconnectYouTubeAccount,
  handleYouTubeOAuthCallback,
  listUserYouTubeAccounts,
} from '../services/youtubeService.js';

export const apiRouter = Router();

const providerEnum = z.enum(['gemini', 'openai_compatible', 'elevenlabs', 'pexels', 'pixabay']);

// ============================================================================
// PUBLIC OAUTH CALLBACK (Verified via HMAC-SHA256 signed state parameter)
// ============================================================================
apiRouter.get('/youtube/oauth/callback', async (req, res) => {
  try {
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    const oauthError = String(req.query.error || '');

    if (oauthError) {
      res.redirect(
        `${config.androidOAuthCallbackUri}?status=error&message=${encodeURIComponent(oauthError)}`
      );
      return;
    }
    if (!code || !state) {
      res.status(400).send('Missing OAuth code or state parameter.');
      return;
    }

    const result = await handleYouTubeOAuthCallback(code, state);
    const primaryName = result.channels[0]?.channelName || 'YouTube Channel';
    res.redirect(
      `${config.androidOAuthCallbackUri}?status=connected&channel=${encodeURIComponent(primaryName)}`
    );
  } catch (err) {
    const msg = sanitizeErrorMessage(err);
    res.redirect(`${config.androidOAuthCallbackUri}?status=error&message=${encodeURIComponent(msg)}`);
  }
});

// All routes below require valid Supabase Bearer JWT authentication
apiRouter.use(requireAuth);

// ============================================================================
// DASHBOARD OVERVIEW & PROFILE PREFERENCES
// ============================================================================
apiRouter.get('/dashboard', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    const supabase = getSupabaseAdmin();
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    const [channels, scheduleRes, jobsRes, uploadsRes, credentials, notificationsRes] =
      await Promise.all([
        listUserYouTubeAccounts(userId),
        supabase.from('schedules').select('*').eq('user_id', userId).maybeSingle(),
        supabase
          .from('video_jobs')
          .select('*, projects(title, topic, format, thumbnail_storage_path)')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(30),
        supabase
          .from('uploads')
          .select('*')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(15),
        listUserCredentials(userId),
        supabase
          .from('user_notifications')
          .select('*')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(15),
      ]);

    const jobs = jobsRes.data || [];
    const todayJobs = jobs.filter((j) => new Date(j.created_at) >= todayStart).length;
    const completedVideos = jobs.filter(
      (j) => j.status === 'published' || j.status === 'scheduled'
    ).length;
    const failedJobs = jobs.filter((j) => j.status === 'failed').length;
    const scheduledVideos = (uploadsRes.data || []).filter(
      (u) => u.upload_status === 'scheduled'
    ).length;

    res.json({
      connectedChannel: channels.find((c) => c.isDefault) || channels[0] || null,
      automationEnabled: Boolean(scheduleRes.data?.enabled),
      nextScheduledRun: scheduleRes.data?.next_run_at || null,
      stats: {
        todayJobs,
        completedVideos,
        failedJobs,
        scheduledVideos,
        connectedProvidersCount: credentials.filter((c) => c.status === 'connected').length,
      },
      recentJobs: jobs.slice(0, 10),
      recentNotifications: notificationsRes.data || [],
    });
  } catch (err) {
    res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

apiRouter.get('/profile', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('profiles')
      .select('id, user_id, display_name, email, preferences, plan_tier, monthly_video_quota, max_concurrent_jobs')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    res.json({ profile: data });
  } catch (err) {
    res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

apiRouter.put('/profile/preferences', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    const schema = z.object({
      preferences: z.record(z.string(), z.unknown()),
      displayName: z.string().min(1).max(80).optional(),
    });
    const parsed = schema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('profiles')
      .upsert(
        {
          user_id: userId,
          preferences: parsed.preferences,
          ...(parsed.displayName ? { display_name: parsed.displayName } : {}),
        },
        { onConflict: 'user_id' }
      )
      .select('id, user_id, display_name, preferences')
      .single();

    if (error) throw new Error(error.message);
    res.json({ profile: data });
  } catch (err) {
    res.status(400).json({ error: sanitizeErrorMessage(err) });
  }
});

// ============================================================================
// BYOK CREDENTIALS (Encrypted at rest; full keys NEVER returned)
// ============================================================================
apiRouter.get('/credentials', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    const credentials = await listUserCredentials(userId);
    res.json({ credentials });
  } catch (err) {
    res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

apiRouter.post('/credentials/validate', sensitiveRateLimiter, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const schema = z.object({
      provider: providerEnum,
      apiKey: z.string().min(8).max(512),
      providerConfig: z.record(z.string(), z.unknown()).optional(),
    });
    const body = schema.parse(req.body);
    const validation = await validateProviderKey(
      body.provider as SupportedProvider,
      body.apiKey,
      body.providerConfig || {}
    );
    res.json({ validation });
  } catch (err) {
    res.status(400).json({ error: sanitizeErrorMessage(err) });
  }
});

apiRouter.post('/credentials', sensitiveRateLimiter, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    const schema = z.object({
      provider: providerEnum,
      apiKey: z.string().min(8).max(512),
      providerConfig: z.record(z.string(), z.unknown()).optional(),
      skipValidation: z.boolean().optional(),
    });
    const body = schema.parse(req.body);
    const result = await upsertUserCredential(
      userId,
      body.provider as SupportedProvider,
      body.apiKey,
      body.providerConfig || {},
      Boolean(body.skipValidation)
    );
    const statusCode = result.validation.valid ? 200 : 422;
    res.status(statusCode).json(result);
  } catch (err) {
    res.status(400).json({ error: sanitizeErrorMessage(err) });
  }
});

apiRouter.delete('/credentials/:provider', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    const provider = providerEnum.parse(req.params.provider);
    await deleteUserCredential(userId, provider);
    res.json({ removed: true, provider });
  } catch (err) {
    res.status(400).json({ error: sanitizeErrorMessage(err) });
  }
});

// ============================================================================
// YOUTUBE ACCOUNT INTEGRATION
// ============================================================================
apiRouter.post('/youtube/connect', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    const authUrl = buildYouTubeOAuthConsentUrl(userId);
    res.json({ authUrl });
  } catch (err) {
    res.status(400).json({ error: sanitizeErrorMessage(err) });
  }
});

apiRouter.get('/youtube/accounts', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    const accounts = await listUserYouTubeAccounts(userId);
    res.json({ accounts });
  } catch (err) {
    res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

apiRouter.get('/youtube/status', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    const accounts = await listUserYouTubeAccounts(userId);
    const active = accounts.find((a) => a.isDefault) || accounts[0] || null;
    res.json({
      connected: Boolean(active && active.tokenStatus === 'connected'),
      account: active,
      totalChannels: accounts.length,
    });
  } catch (err) {
    res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

apiRouter.post('/youtube/disconnect', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    const accountId = typeof req.body?.accountId === 'string' ? req.body.accountId : undefined;
    await disconnectYouTubeAccount(userId, accountId);
    res.json({ disconnected: true });
  } catch (err) {
    res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

// ============================================================================
// TOPIC RESEARCH & PROJECTS
// ============================================================================
apiRouter.post('/research/topics', sensitiveRateLimiter, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    const schema = z.object({
      niche: z.string().min(2).max(60),
      language: z.string().min(2).max(16).default('en'),
      audienceCountry: z.string().min(2).max(16).default('US'),
      contentStyle: z.string().min(2).max(40).default('documentary'),
      durationSeconds: z.number().int().min(15).max(1800).default(60),
      topicType: z.enum(['evergreen', 'trending', 'news']).default('evergreen'),
      count: z.number().int().min(1).max(10).default(5),
    });
    const parsed = schema.parse(req.body);
    const ai = await createAIProviderForUser(userId, 'gemini');
    const researched = await researchTopicsWithAI(ai, parsed);
    res.json(researched);
  } catch (err) {
    res.status(400).json({ error: sanitizeErrorMessage(err) });
  }
});

apiRouter.post('/projects', sensitiveRateLimiter, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    const schema = z.object({
      title: z.string().min(1).max(120).optional(),
      topic: z.string().min(2).max(300),
      niche: z.string().min(2).max(60).default('Facts'),
      language: z.string().min(2).max(16).default('en'),
      audienceCountry: z.string().min(2).max(16).default('US'),
      contentStyle: z.string().min(2).max(50).default('documentary'),
      topicType: z.enum(['evergreen', 'trending', 'news']).default('evergreen'),
      format: z.enum(['9:16', '16:9', '1:1']).default('9:16'),
      durationSeconds: z.number().int().min(15).max(1800).default(60),
      qualityPreset: z.enum(['720p', '1080p']).default('1080p'),
      autoProduce: z.boolean().default(true),
      voiceProvider: z.enum(['gemini_tts', 'elevenlabs']).default('gemini_tts'),
      voiceId: z.string().min(1).max(64).default('Kore'),
      autoUpload: z.boolean().default(false),
      privacyStatus: z.enum(['private', 'unlisted', 'public']).default('private'),
      scheduledPublishTime: z.string().nullable().optional(),
      startImmediately: z.boolean().default(true),
    });
    const body = schema.parse(req.body);
    const supabase = getSupabaseAdmin();

    const { data: project, error } = await supabase
      .from('projects')
      .insert({
        user_id: userId,
        title: body.title?.trim() || body.topic.trim().slice(0, 90),
        topic: body.topic.trim(),
        niche: body.niche,
        language: body.language,
        audience_country: body.audienceCountry,
        content_style: body.contentStyle,
        topic_type: body.topicType,
        format: body.format,
        duration_seconds: body.durationSeconds,
        quality_preset: body.qualityPreset,
        auto_produce: body.autoProduce,
        voice_provider: body.voiceProvider,
        voice_id: body.voiceId,
        upload_config: {
          auto_upload: body.autoUpload,
          privacy_status: body.privacyStatus,
          scheduled_publish_time: body.scheduledPublishTime || null,
        },
        status: 'queued',
      })
      .select('*')
      .single();

    if (error || !project) {
      throw new Error(error?.message || 'Failed to create project');
    }

    let createdJob = null;
    if (body.startImmediately) {
      const idempotencyKey = `proj-${project.id}-${crypto.randomUUID()}`;
      const { data: job, error: jobErr } = await supabase
        .from('video_jobs')
        .insert({
          user_id: userId,
          project_id: project.id,
          job_type: 'full_pipeline',
          status: 'queued',
          current_stage: 'queued',
          progress: 0,
          status_message: 'Queued for cloud worker',
          idempotency_key: idempotencyKey,
        })
        .select('*')
        .single();
      if (jobErr) throw new Error(jobErr.message);
      createdJob = job;
    }

    res.status(201).json({ project, job: createdJob });
  } catch (err) {
    res.status(400).json({ error: sanitizeErrorMessage(err) });
  }
});

apiRouter.get('/projects', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw new Error(error.message);

    const enriched = await Promise.all(
      (data || []).map(async (proj) => ({
        ...proj,
        thumbnail_signed_url: await createSignedStorageUrl('thumbnails', proj.thumbnail_storage_path),
        video_signed_url: await createSignedStorageUrl('rendered-videos', proj.final_video_storage_path),
      }))
    );

    res.json({ projects: enriched });
  } catch (err) {
    res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

apiRouter.get('/projects/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    const projectId = z.string().uuid().parse(req.params.id);
    const supabase = getSupabaseAdmin();

    const [projRes, scriptsRes, scenesRes, mediaRes, jobsRes, uploadsRes] = await Promise.all([
      supabase.from('projects').select('*').eq('id', projectId).eq('user_id', userId).maybeSingle(),
      supabase
        .from('scripts')
        .select('*')
        .eq('project_id', projectId)
        .eq('user_id', userId)
        .order('version', { ascending: false }),
      supabase
        .from('scenes')
        .select('*')
        .eq('project_id', projectId)
        .eq('user_id', userId)
        .order('scene_number', { ascending: true }),
      supabase
        .from('media_assets')
        .select('*')
        .eq('project_id', projectId)
        .eq('user_id', userId),
      supabase
        .from('video_jobs')
        .select('*')
        .eq('project_id', projectId)
        .eq('user_id', userId)
        .order('created_at', { ascending: false }),
      supabase
        .from('uploads')
        .select('*')
        .eq('project_id', projectId)
        .eq('user_id', userId)
        .order('created_at', { ascending: false }),
    ]);

    if (!projRes.data) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    const project = {
      ...projRes.data,
      thumbnail_signed_url: await createSignedStorageUrl(
        'thumbnails',
        projRes.data.thumbnail_storage_path
      ),
      video_signed_url: await createSignedStorageUrl(
        'rendered-videos',
        projRes.data.final_video_storage_path
      ),
      subtitle_signed_url: await createSignedStorageUrl('subtitles', projRes.data.subtitle_srt_path),
    };

    res.json({
      project,
      scripts: scriptsRes.data || [],
      scenes: scenesRes.data || [],
      mediaAssets: mediaRes.data || [],
      jobs: jobsRes.data || [],
      uploads: uploadsRes.data || [],
    });
  } catch (err) {
    res.status(400).json({ error: sanitizeErrorMessage(err) });
  }
});

// Edit, approve, or regenerate script for a project
apiRouter.put('/projects/:id/script', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    const projectId = z.string().uuid().parse(req.params.id);
    const body = z
      .object({
        narrationText: z.string().min(15).max(20000),
        titleIdea: z.string().max(150).optional(),
        approveAndContinue: z.boolean().default(false),
      })
      .parse(req.body);

    const supabase = getSupabaseAdmin();
    const { data: latest } = await supabase
      .from('scripts')
      .select('version')
      .eq('project_id', projectId)
      .eq('user_id', userId)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();

    const words = body.narrationText.trim().split(/\s+/).filter(Boolean).length;
    const { data: script, error } = await supabase
      .from('scripts')
      .insert({
        user_id: userId,
        project_id: projectId,
        version: (latest?.version || 0) + 1,
        title_idea: body.titleIdea || '',
        narration_text: body.narrationText.trim(),
        script_text: body.narrationText.trim(),
        word_count: words,
        approved: body.approveAndContinue,
      })
      .select('*')
      .single();

    if (error) throw new Error(error.message);

    if (body.approveAndContinue) {
      await supabase
        .from('projects')
        .update({ auto_produce: true, status: 'queued' })
        .eq('id', projectId)
        .eq('user_id', userId);

      await supabase
        .from('video_jobs')
        .update({
          status: 'queued',
          status_message: 'Script approved — resuming cloud production pipeline',
          next_retry_at: null,
        })
        .eq('project_id', projectId)
        .eq('user_id', userId)
        .eq('status', 'awaiting_approval');
    }

    res.json({ script });
  } catch (err) {
    res.status(400).json({ error: sanitizeErrorMessage(err) });
  }
});

apiRouter.post('/projects/:id/script/regenerate', sensitiveRateLimiter, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    const projectId = z.string().uuid().parse(req.params.id);
    const body = z
      .object({
        tone: z.string().max(50).optional(),
        durationSeconds: z.number().int().min(15).max(1800).optional(),
      })
      .parse(req.body || {});

    const supabase = getSupabaseAdmin();
    const { data: project } = await supabase
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .eq('user_id', userId)
      .single();
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    const ai = await createAIProviderForUser(userId, 'gemini');
    const generated = await generateScriptWithAI(ai, {
      topic: project.topic,
      niche: project.niche,
      language: project.language,
      contentStyle: project.content_style,
      durationSeconds: body.durationSeconds || project.duration_seconds,
      tone: body.tone || 'engaging',
    });

    const { data: latest } = await supabase
      .from('scripts')
      .select('version')
      .eq('project_id', projectId)
      .eq('user_id', userId)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();

    const { data: script, error } = await supabase
      .from('scripts')
      .insert({
        user_id: userId,
        project_id: projectId,
        version: (latest?.version || 0) + 1,
        title_idea: generated.titleIdea,
        hook: generated.hook,
        narration_text: generated.narrationText,
        script_text: generated.fullScript,
        ending: generated.ending,
        call_to_action: generated.callToAction,
        tone: body.tone || 'engaging',
        word_count: generated.wordCount,
        approved: false,
      })
      .select('*')
      .single();

    if (error) throw new Error(error.message);
    res.json({ script });
  } catch (err) {
    res.status(400).json({ error: sanitizeErrorMessage(err) });
  }
});

apiRouter.delete('/projects/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    const projectId = z.string().uuid().parse(req.params.id);
    const supabase = getSupabaseAdmin();

    const [{ data: proj }, { data: assets }] = await Promise.all([
      supabase
        .from('projects')
        .select('narration_audio_path, subtitle_srt_path, thumbnail_storage_path, final_video_storage_path')
        .eq('id', projectId)
        .eq('user_id', userId)
        .maybeSingle(),
      supabase
        .from('media_assets')
        .select('storage_path')
        .eq('project_id', projectId)
        .eq('user_id', userId)
        .not('storage_path', 'is', null),
    ]);

    const sourcePaths = (assets || []).map((a) => a.storage_path as string).filter(Boolean);
    if (sourcePaths.length > 0) {
      await supabase.storage.from('source-media').remove(sourcePaths).catch(() => undefined);
    }
    if (proj?.narration_audio_path) {
      await supabase.storage.from('voice-audio').remove([proj.narration_audio_path]).catch(() => undefined);
    }
    if (proj?.final_video_storage_path) {
      await supabase.storage.from('rendered-videos').remove([proj.final_video_storage_path]).catch(() => undefined);
    }
    if (proj?.subtitle_srt_path) {
      await supabase.storage.from('subtitles').remove([proj.subtitle_srt_path]).catch(() => undefined);
    }
    if (proj?.thumbnail_storage_path) {
      await supabase.storage.from('thumbnails').remove([proj.thumbnail_storage_path]).catch(() => undefined);
    }

    const { error } = await supabase
      .from('projects')
      .delete()
      .eq('id', projectId)
      .eq('user_id', userId);
    if (error) throw new Error(error.message);
    res.json({ deleted: true, id: projectId });
  } catch (err) {
    res.status(400).json({ error: sanitizeErrorMessage(err) });
  }
});

// ============================================================================
// JOBS (Create, List, Detail, Retry without repeating done stages, Cancel)
// ============================================================================
apiRouter.post('/jobs/create', sensitiveRateLimiter, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    const body = z
      .object({
        projectId: z.string().uuid(),
        jobType: z
          .enum(['full_pipeline', 'script_only', 'render_only', 'upload_only'])
          .default('full_pipeline'),
        idempotencyKey: z.string().min(8).max(128).optional(),
      })
      .parse(req.body);

    const supabase = getSupabaseAdmin();
    const { data: project } = await supabase
      .from('projects')
      .select('id')
      .eq('id', body.projectId)
      .eq('user_id', userId)
      .maybeSingle();

    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    const key = body.idempotencyKey || `job-${body.projectId}-${Date.now()}`;
    const { data: job, error } = await supabase
      .from('video_jobs')
      .upsert(
        {
          user_id: userId,
          project_id: body.projectId,
          job_type: body.jobType,
          status: 'queued',
          current_stage: 'queued',
          progress: 0,
          status_message: 'Queued for background worker',
          idempotency_key: key,
        },
        { onConflict: 'idempotency_key' }
      )
      .select('*')
      .single();

    if (error) throw new Error(error.message);
    res.status(201).json({ job });
  } catch (err) {
    res.status(400).json({ error: sanitizeErrorMessage(err) });
  }
});

apiRouter.get('/jobs', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('video_jobs')
      .select('*, projects(title, topic, niche, format, duration_seconds, thumbnail_storage_path)')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw new Error(error.message);
    res.json({ jobs: data || [] });
  } catch (err) {
    res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

apiRouter.get('/jobs/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    const jobId = z.string().uuid().parse(req.params.id);
    const supabase = getSupabaseAdmin();
    const { data: job, error } = await supabase
      .from('video_jobs')
      .select('*, projects(*)')
      .eq('id', jobId)
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    res.json({ job });
  } catch (err) {
    res.status(400).json({ error: sanitizeErrorMessage(err) });
  }
});

apiRouter.post('/jobs/:id/retry', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    const jobId = z.string().uuid().parse(req.params.id);
    const supabase = getSupabaseAdmin();

    // Preserves `completed_stages` so previously finished stages are NOT repeated unnecessarily
    const { data: job, error } = await supabase
      .from('video_jobs')
      .update({
        status: 'queued',
        status_message: 'Manual retry requested — resuming from last incomplete stage',
        next_retry_at: null,
        locked_by: null,
        error_message: null,
      })
      .eq('id', jobId)
      .eq('user_id', userId)
      .select('*')
      .single();

    if (error || !job) {
      res.status(404).json({ error: 'Job not found or cannot be retried' });
      return;
    }
    res.json({ job });
  } catch (err) {
    res.status(400).json({ error: sanitizeErrorMessage(err) });
  }
});

apiRouter.post('/jobs/:id/cancel', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    const jobId = z.string().uuid().parse(req.params.id);
    const supabase = getSupabaseAdmin();

    const { data: job, error } = await supabase
      .from('video_jobs')
      .update({
        status: 'cancelled',
        current_stage: 'cancelled',
        status_message: 'Cancelled by user',
        locked_by: null,
      })
      .eq('id', jobId)
      .eq('user_id', userId)
      .select('*')
      .single();

    if (error || !job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    res.json({ job });
  } catch (err) {
    res.status(400).json({ error: sanitizeErrorMessage(err) });
  }
});

// ============================================================================
// AUTOMATION & AUTOPILOT SCHEDULER SETTINGS
// ============================================================================
apiRouter.get('/automation/settings', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('schedules')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    res.json({ schedule: data });
  } catch (err) {
    res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

apiRouter.put('/automation/settings', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    const body = z
      .object({
        enabled: z.boolean().optional(),
        niche: z.string().min(2).max(60).default('Facts'),
        language: z.string().min(2).max(16).default('en'),
        audienceCountry: z.string().min(2).max(16).default('US'),
        videoFormat: z.enum(['9:16', '16:9', '1:1']).default('9:16'),
        durationSeconds: z.number().int().min(15).max(1800).default(60),
        videosPerDay: z.number().int().min(1).max(10).default(1),
        publishingTimes: z.array(z.string().regex(/^\d{2}:\d{2}$/)).min(1).default(['14:00']),
        daysOfWeek: z.array(z.string()).min(1).default(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
        timezone: z.string().min(2).max(64).default('UTC'),
        preferences: z.record(z.string(), z.unknown()).default({}),
      })
      .parse(req.body);

    const nextRun = computeNextRunIso(body.publishingTimes[0]);
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('schedules')
      .upsert(
        {
          user_id: userId,
          enabled: body.enabled ?? false,
          niche: body.niche,
          language: body.language,
          audience_country: body.audienceCountry,
          video_format: body.videoFormat,
          duration_seconds: body.durationSeconds,
          videos_per_day: body.videosPerDay,
          publishing_times: body.publishingTimes,
          days_of_week: body.daysOfWeek,
          timezone: body.timezone,
          preferences: body.preferences,
          next_run_at: nextRun,
        },
        { onConflict: 'user_id' }
      )
      .select('*')
      .single();

    if (error) throw new Error(error.message);
    res.json({ schedule: data });
  } catch (err) {
    res.status(400).json({ error: sanitizeErrorMessage(err) });
  }
});

apiRouter.post('/automation/start', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    const supabase = getSupabaseAdmin();
    const nextRun = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('schedules')
      .upsert(
        { user_id: userId, enabled: true, next_run_at: nextRun },
        { onConflict: 'user_id' }
      )
      .select('*')
      .single();
    if (error) throw new Error(error.message);
    res.json({ schedule: data });
  } catch (err) {
    res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

apiRouter.post('/automation/pause', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('schedules')
      .upsert({ user_id: userId, enabled: false }, { onConflict: 'user_id' })
      .select('*')
      .single();
    if (error) throw new Error(error.message);
    res.json({ schedule: data });
  } catch (err) {
    res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

// ============================================================================
// UPLOADS & NOTIFICATIONS
// ============================================================================
apiRouter.get('/uploads', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('uploads')
      .select('*, projects(title, format)')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(40);
    if (error) throw new Error(error.message);
    res.json({ uploads: data || [] });
  } catch (err) {
    res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

apiRouter.get('/uploads/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    const id = z.string().uuid().parse(req.params.id);
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('uploads')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      res.status(404).json({ error: 'Upload record not found' });
      return;
    }
    res.json({ upload: data });
  } catch (err) {
    res.status(400).json({ error: sanitizeErrorMessage(err) });
  }
});

apiRouter.get('/notifications', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('user_notifications')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(30);
    if (error) throw new Error(error.message);
    res.json({ notifications: data || [] });
  } catch (err) {
    res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

function computeNextRunIso(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(Number.isFinite(h) ? h : 14, Number.isFinite(m) ? m : 0, 0, 0);
  if (next <= now) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.toISOString();
}
