-- ============================================================================
-- AutoTube Studio — Migration 001: Multi-User Core Schema, Indexes, RLS & Queue
-- ============================================================================
-- Multi-user-ready from day one: every user-owned record carries user_id and
-- strict Row Level Security policies. Designed for Supabase PostgreSQL.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- Helper trigger: automatically update updated_at timestamps
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- ----------------------------------------------------------------------------
-- 1. profiles (1:1 with auth.users, ready for multi-user quotas & tiers)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL DEFAULT '',
  email TEXT,
  preferences JSONB NOT NULL DEFAULT '{
    "script_provider": "gemini",
    "research_provider": "gemini",
    "voice_provider": "gemini_tts",
    "media_providers": ["pexels", "pixabay"],
    "default_language": "en",
    "default_format": "9:16",
    "default_quality": "1080p",
    "notifications_enabled": true
  }'::jsonb,
  plan_tier TEXT NOT NULL DEFAULT 'owner' CHECK (plan_tier IN ('owner', 'free', 'pro', 'studio')),
  monthly_video_quota INTEGER NOT NULL DEFAULT 100 CHECK (monthly_video_quota >= 0),
  max_concurrent_jobs INTEGER NOT NULL DEFAULT 2 CHECK (max_concurrent_jobs BETWEEN 1 AND 10),
  fcm_token TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Auto-create profile when a user signs up via Supabase Auth
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (user_id, email, display_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(COALESCE(NEW.email, 'Creator'), '@', 1))
  )
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ----------------------------------------------------------------------------
-- 2. api_credentials (Encrypted BYOK credentials; never returned raw to clients)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.api_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (
    provider IN ('gemini', 'groq', 'openai_compatible', 'elevenlabs', 'pexels', 'pixabay')
  ),
  encrypted_key TEXT NOT NULL,
  key_iv TEXT NOT NULL,
  key_auth_tag TEXT NOT NULL,
  masked_key TEXT NOT NULL,
  key_status TEXT NOT NULL DEFAULT 'not_connected' CHECK (
    key_status IN ('not_connected', 'validating', 'connected', 'invalid_key', 'rate_limited', 'provider_unavailable')
  ),
  provider_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  usage_info JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_validated_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_api_credentials_user ON public.api_credentials(user_id);

CREATE TRIGGER trg_api_credentials_updated_at
  BEFORE UPDATE ON public.api_credentials
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 3. youtube_accounts (Encrypted OAuth 2.0 refresh tokens & connected channels)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.youtube_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  channel_name TEXT NOT NULL,
  channel_handle TEXT,
  channel_thumbnail_url TEXT,
  subscriber_count BIGINT DEFAULT 0,
  encrypted_refresh_token TEXT NOT NULL,
  token_iv TEXT NOT NULL,
  token_auth_tag TEXT NOT NULL,
  scopes TEXT[] NOT NULL DEFAULT ARRAY[
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube.readonly'
  ],
  token_status TEXT NOT NULL DEFAULT 'connected' CHECK (
    token_status IN ('connected', 'expired', 'revoked', 'error')
  ),
  is_default BOOLEAN NOT NULL DEFAULT TRUE,
  last_error TEXT,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_youtube_accounts_user ON public.youtube_accounts(user_id);

CREATE TRIGGER trg_youtube_accounts_updated_at
  BEFORE UPDATE ON public.youtube_accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 4. projects (Video production projects)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  topic TEXT NOT NULL,
  niche TEXT NOT NULL DEFAULT 'Facts',
  language TEXT NOT NULL DEFAULT 'en',
  audience_country TEXT NOT NULL DEFAULT 'US',
  content_style TEXT NOT NULL DEFAULT 'documentary',
  topic_type TEXT NOT NULL DEFAULT 'evergreen' CHECK (topic_type IN ('evergreen', 'trending', 'news')),
  format TEXT NOT NULL DEFAULT '9:16' CHECK (format IN ('9:16', '16:9', '1:1')),
  duration_seconds INTEGER NOT NULL DEFAULT 60 CHECK (duration_seconds BETWEEN 15 AND 1800),
  quality_preset TEXT NOT NULL DEFAULT '1080p' CHECK (quality_preset IN ('720p', '1080p')),
  auto_produce BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'queued',
  voice_provider TEXT NOT NULL DEFAULT 'gemini_tts',
  voice_id TEXT NOT NULL DEFAULT 'Kore',
  voice_speed REAL NOT NULL DEFAULT 1.0 CHECK (voice_speed BETWEEN 0.5 AND 2.0),
  subtitle_style JSONB NOT NULL DEFAULT '{
    "enabled": true,
    "burn_in": true,
    "font_name": "DejaVu Sans Bold",
    "font_size": 44,
    "primary_color": "#FFFFFF",
    "highlight_color": "#FFD43B",
    "outline_color": "#000000",
    "background_opacity": 0.45,
    "position": "bottom_safe"
  }'::jsonb,
  music_config JSONB NOT NULL DEFAULT '{
    "enabled": false,
    "track_id": null,
    "music_volume": 0.16,
    "narration_volume": 1.0,
    "ducking_enabled": true,
    "fade_in_sec": 1.5,
    "fade_out_sec": 2.0
  }'::jsonb,
  upload_config JSONB NOT NULL DEFAULT '{
    "auto_upload": false,
    "privacy_status": "private",
    "scheduled_publish_time": null,
    "playlist_id": null
  }'::jsonb,
  research_references JSONB NOT NULL DEFAULT '[]'::jsonb,
  seo_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  narration_audio_path TEXT,
  subtitle_srt_path TEXT,
  thumbnail_storage_path TEXT,
  final_video_storage_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_projects_user_created ON public.projects(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_projects_status ON public.projects(user_id, status);

CREATE TRIGGER trg_projects_updated_at
  BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 5. scripts (Versioned scripts per project)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.scripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  title_idea TEXT NOT NULL DEFAULT '',
  hook TEXT NOT NULL DEFAULT '',
  narration_text TEXT NOT NULL DEFAULT '',
  script_text TEXT NOT NULL,
  ending TEXT NOT NULL DEFAULT '',
  call_to_action TEXT NOT NULL DEFAULT '',
  tone TEXT NOT NULL DEFAULT 'engaging',
  word_count INTEGER NOT NULL DEFAULT 0,
  approved BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, version)
);

CREATE INDEX IF NOT EXISTS idx_scripts_project ON public.scripts(project_id, version DESC);

-- ----------------------------------------------------------------------------
-- 6. scenes (Scene breakdown & synchronization metadata)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.scenes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  scene_number INTEGER NOT NULL CHECK (scene_number > 0),
  narration TEXT NOT NULL,
  visual_description TEXT NOT NULL,
  primary_keyword TEXT NOT NULL,
  search_keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
  media_type_preference TEXT NOT NULL DEFAULT 'video' CHECK (media_type_preference IN ('video', 'image')),
  transition TEXT NOT NULL DEFAULT 'fade',
  subtitle_text TEXT NOT NULL DEFAULT '',
  duration REAL NOT NULL DEFAULT 5.0 CHECK (duration > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'media_found', 'downloaded', 'fallback_image', 'ready', 'failed')
  ),
  fallback_used BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, scene_number)
);

CREATE INDEX IF NOT EXISTS idx_scenes_project ON public.scenes(project_id, scene_number);

CREATE TRIGGER trg_scenes_updated_at
  BEFORE UPDATE ON public.scenes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 7. media_assets (Media manifest + deduplication hash + attribution metadata)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.media_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  scene_id UUID REFERENCES public.scenes(id) ON DELETE SET NULL,
  provider TEXT NOT NULL CHECK (provider IN ('pexels', 'pixabay', 'wikimedia', 'nasa', 'user_upload', 'ai_generated')),
  external_id TEXT,
  original_url TEXT NOT NULL,
  download_url TEXT NOT NULL,
  storage_path TEXT,
  sha256_hash TEXT,
  file_size_bytes BIGINT DEFAULT 0,
  license_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  author_name TEXT,
  media_type TEXT NOT NULL CHECK (media_type IN ('video', 'image', 'audio')),
  duration REAL DEFAULT 0,
  resolution TEXT DEFAULT '',
  width INTEGER DEFAULT 0,
  height INTEGER DEFAULT 0,
  relevance_score REAL NOT NULL DEFAULT 0.0 CHECK (relevance_score BETWEEN 0.0 AND 1.0),
  is_fallback BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_media_assets_project ON public.media_assets(project_id, scene_id);
CREATE INDEX IF NOT EXISTS idx_media_assets_dedup ON public.media_assets(user_id, provider, external_id);
CREATE INDEX IF NOT EXISTS idx_media_assets_hash ON public.media_assets(user_id, sha256_hash);

-- ----------------------------------------------------------------------------
-- 8. video_jobs (Persistent, crash-recoverable job pipeline queue)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.video_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL DEFAULT 'full_pipeline' CHECK (
    job_type IN ('full_pipeline', 'script_only', 'render_only', 'upload_only', 'scheduled_autopilot')
  ),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (
    status IN (
      'queued',
      'researching',
      'generating_script',
      'generating_scenes',
      'searching_media',
      'downloading_media',
      'generating_voice',
      'preparing_timeline',
      'rendering',
      'generating_thumbnail',
      'generating_metadata',
      'quality_check',
      'uploading',
      'scheduled',
      'published',
      'awaiting_approval',
      'failed',
      'cancelled'
    )
  ),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  current_stage TEXT NOT NULL DEFAULT 'queued',
  status_message TEXT NOT NULL DEFAULT 'Waiting for cloud worker',
  completed_stages JSONB NOT NULL DEFAULT '[]'::jsonb,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  next_retry_at TIMESTAMPTZ,
  locked_by TEXT,
  locked_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  error_code TEXT,
  error_message TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_video_jobs_user_created ON public.video_jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_video_jobs_queue ON public.video_jobs(status, next_retry_at, created_at);
CREATE INDEX IF NOT EXISTS idx_video_jobs_project ON public.video_jobs(project_id);

CREATE TRIGGER trg_video_jobs_updated_at
  BEFORE UPDATE ON public.video_jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 9. schedules (Per-user Autopilot automation schedules)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  niche TEXT NOT NULL DEFAULT 'Facts',
  language TEXT NOT NULL DEFAULT 'en',
  audience_country TEXT NOT NULL DEFAULT 'US',
  video_format TEXT NOT NULL DEFAULT '9:16' CHECK (video_format IN ('9:16', '16:9', '1:1')),
  duration_seconds INTEGER NOT NULL DEFAULT 60 CHECK (duration_seconds BETWEEN 15 AND 1800),
  videos_per_day INTEGER NOT NULL DEFAULT 1 CHECK (videos_per_day BETWEEN 1 AND 10),
  publishing_times JSONB NOT NULL DEFAULT '["14:00"]'::jsonb,
  days_of_week JSONB NOT NULL DEFAULT '["mon","tue","wed","thu","fri","sat","sun"]'::jsonb,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  preferences JSONB NOT NULL DEFAULT '{
    "topic_preferences": [],
    "avoided_topics": [],
    "voice_provider": "gemini_tts",
    "voice_id": "Kore",
    "visual_sources": ["pexels", "pixabay"],
    "music_enabled": false,
    "subtitle_style": "bold_shorts",
    "thumbnail_style": "cinematic_contrast",
    "upload_privacy": "private",
    "auto_publish": false,
    "max_concurrent_jobs": 1,
    "max_retries": 3,
    "content_style": "documentary",
    "quality_preset": "1080p"
  }'::jsonb,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_schedules_due ON public.schedules(enabled, next_run_at);

CREATE TRIGGER trg_schedules_updated_at
  BEFORE UPDATE ON public.schedules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 10. uploads (YouTube Data API v3 upload records & scheduling state)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.uploads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  youtube_account_id UUID REFERENCES public.youtube_accounts(id) ON DELETE SET NULL,
  youtube_video_id TEXT,
  upload_session_uri TEXT,
  upload_status TEXT NOT NULL DEFAULT 'pending' CHECK (
    upload_status IN ('pending', 'uploading', 'processing', 'scheduled', 'published', 'failed')
  ),
  upload_progress INTEGER NOT NULL DEFAULT 0 CHECK (upload_progress BETWEEN 0 AND 100),
  privacy_status TEXT NOT NULL DEFAULT 'private' CHECK (privacy_status IN ('private', 'unlisted', 'public')),
  scheduled_publish_time TIMESTAMPTZ,
  video_url TEXT,
  error_message TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_uploads_user_created ON public.uploads(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_uploads_project ON public.uploads(project_id);

CREATE TRIGGER trg_uploads_updated_at
  BEFORE UPDATE ON public.uploads
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 11. user_notifications (Event feed synced to Android notifications & FCM)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE,
  job_id UUID REFERENCES public.video_jobs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_notifications_user ON public.user_notifications(user_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- 12. background_music_tracks (User-uploaded or licensed royalty-free tracks)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.background_music_tracks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  license_type TEXT NOT NULL DEFAULT 'user_owned',
  storage_path TEXT NOT NULL,
  duration_sec REAL DEFAULT 0,
  mood TEXT DEFAULT 'cinematic',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_music_tracks_user ON public.background_music_tracks(user_id);

-- ============================================================================
-- Atomic Crash-Recoverable Job Claim Function (Used by Render Background Worker)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.claim_next_video_job(
  p_worker_id TEXT,
  p_stale_seconds INTEGER DEFAULT 180
)
RETURNS SETOF public.video_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job_id UUID;
BEGIN
  -- Recover stale jobs from restarted/crashed workers and claim next eligible job
  SELECT vj.id INTO v_job_id
  FROM public.video_jobs vj
  WHERE
    (
      vj.status = 'queued'
      AND (vj.next_retry_at IS NULL OR vj.next_retry_at <= NOW())
    )
    OR (
      vj.status NOT IN ('queued', 'published', 'scheduled', 'awaiting_approval', 'failed', 'cancelled')
      AND vj.heartbeat_at IS NOT NULL
      AND vj.heartbeat_at < NOW() - make_interval(secs => p_stale_seconds)
    )
  ORDER BY vj.created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_job_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  UPDATE public.video_jobs
  SET
    locked_by = p_worker_id,
    locked_at = NOW(),
    heartbeat_at = NOW(),
    updated_at = NOW()
  WHERE id = v_job_id
  RETURNING *;
END;
$$;

-- ============================================================================
-- Row Level Security (RLS) — Multi-User Isolation Enforced at Database Layer
-- ============================================================================
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.youtube_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scenes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.background_music_tracks ENABLE ROW LEVEL SECURITY;

-- Profiles
CREATE POLICY "Users read own profile" ON public.profiles
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users update own profile" ON public.profiles
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users insert own profile" ON public.profiles
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- API Credentials: deny direct PostgREST client reads so encrypted keys stay strictly server-side
-- Backend accesses via service_role and returns only masked_key & status via REST API.
CREATE POLICY "Deny direct client access to api_credentials" ON public.api_credentials
  FOR ALL USING (FALSE) WITH CHECK (FALSE);

-- YouTube Accounts: deny direct client reads of encrypted_refresh_token; accessed via backend API
CREATE POLICY "Deny direct client access to youtube_accounts" ON public.youtube_accounts
  FOR ALL USING (FALSE) WITH CHECK (FALSE);

-- Projects
CREATE POLICY "Users manage own projects" ON public.projects
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Scripts
CREATE POLICY "Users manage own scripts" ON public.scripts
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Scenes
CREATE POLICY "Users manage own scenes" ON public.scenes
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Media Assets
CREATE POLICY "Users manage own media_assets" ON public.media_assets
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Video Jobs
CREATE POLICY "Users manage own video_jobs" ON public.video_jobs
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Schedules
CREATE POLICY "Users manage own schedules" ON public.schedules
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Uploads
CREATE POLICY "Users manage own uploads" ON public.uploads
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- User Notifications
CREATE POLICY "Users manage own notifications" ON public.user_notifications
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Background Music Tracks
CREATE POLICY "Users manage own music tracks" ON public.background_music_tracks
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
