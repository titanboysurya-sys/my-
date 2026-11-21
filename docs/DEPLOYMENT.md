# AutoTube Studio — Setup & Production Deployment Guide

This guide walks through deploying **Supabase**, **Render (API + FFmpeg Worker + Cron Scheduler)**, **Google YouTube OAuth 2.0**, and connecting the **Android app**.

---

## 1. Supabase Setup (Database, Auth & Private Storage)

1. Create a new project at [supabase.com](https://supabase.com).
2. In **Authentication → Providers**, ensure **Email** sign-in is enabled.
3. Open **SQL Editor** and run the two migration files in order:
   - `supabase/migrations/001_initial_schema.sql` (creates all 12 multi-user tables, indexes, triggers, `claim_next_video_job` RPC, and strict RLS policies).
   - `supabase/migrations/002_storage_buckets.sql` (creates private storage buckets: `source-media`, `voice-audio`, `thumbnails`, `rendered-videos`, `subtitles`, `music-tracks` with user-scoped policies).
4. Copy the following values from **Project Settings → API & Database**:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY` (public key used by Android & backend)
   - `SUPABASE_SERVICE_ROLE_KEY` (**server-only secret** for Render)
   - `DATABASE_URL` (**server-only secret** for Render)

---

## 2. Generate Server Encryption Key

Generate a cryptographically secure 32-byte hex key for AES-256-GCM BYOK & OAuth token encryption:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Save this value as `CREDENTIAL_ENCRYPTION_KEY` in Render (never commit it to Git or place it in the Android app).

---

## 3. Google Cloud & YouTube Data API v3 OAuth 2.0 Setup

1. Open [Google Cloud Console](https://console.cloud.google.com) and create/select a project.
2. Enable **YouTube Data API v3**.
3. Configure the **OAuth Consent Screen**:
   - Add minimal scopes:
     - `https://www.googleapis.com/auth/youtube.upload`
     - `https://www.googleapis.com/auth/youtube.readonly`
   - Add your owner Google account under **Test Users** while in testing mode.
4. Under **Credentials → Create Credentials → OAuth Client ID (Web Application)**:
   - Add Authorized Redirect URI:
     `https://<your-render-api-domain>.onrender.com/api/youtube/oauth/callback`
   - Save `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` for Render.

---

## 4. Deploy Cloud Backend on Render

This repository includes a complete Render Blueprint (`/render.yaml`) and FFmpeg-enabled Docker image (`/backend/Dockerfile`).

1. Push the repository to GitHub/GitLab.
2. In Render Dashboard, click **New → Blueprint** and select your repository.
3. Render automatically creates 3 services:
   - **`autotube-studio-api`** (Web Service with `/health` check)
   - **`autotube-studio-worker`** (Background Worker running `node dist/worker.js` with FFmpeg)
   - **`autotube-studio-scheduler`** (Cron Job running `node dist/scheduler.js` every 5 minutes)
4. Populate the secret environment variables on Render (using `backend/.env.example` as reference):
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `DATABASE_URL`
   - `CREDENTIAL_ENCRYPTION_KEY`
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `YOUTUBE_OAUTH_REDIRECT_URI` (`https://<your-api>.onrender.com/api/youtube/oauth/callback`)
   - `ANDROID_OAUTH_CALLBACK_URI` (`autotubestudio://oauth/youtube`)
5. Verify deployment by visiting `https://<your-api>.onrender.com/health`.

---

## 5. Local Backend Development & Tests

```bash
cd backend
cp .env.example .env
# Fill backend/.env with your Supabase & encryption values
npm install
npm test
npm run build
npm run dev           # API server
npm run dev:worker    # Background FFmpeg worker
npm run dev:scheduler # One-shot scheduler run
```

---

## 6. Configure & Use the Android App

1. Open **AutoTube Studio** on your Android device.
2. On the Sign-In screen, expand **Cloud Backend & Supabase** and enter:
   - **Render Backend API URL** (`https://<your-api>.onrender.com`)
   - **Supabase Project URL** (`https://<ref>.supabase.co`)
   - **Supabase Public Anon Key**
3. Tap **Test Backend Health** to verify connectivity, then **Create Account** or **Sign In**.
4. Go to **Settings → AI Providers & API Keys** and add your own keys:
   - **Gemini** (for Topic Research, Scripts, Scene Breakdown, SEO, and Gemini TTS)
   - **Pexels** and/or **Pixabay** (for stock video & image footage)
   - **ElevenLabs** (optional premium narration voice)
5. Go to **Settings → YouTube Account & Channel** and tap **Connect YouTube Channel**.
6. Go to **Autopilot**, configure your niche, language, format, schedule, and tap **Save**, then toggle **Enable Cloud Autopilot** (or press **Start Automation** on the Dashboard).
