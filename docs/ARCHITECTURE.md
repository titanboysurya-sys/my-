# AutoTube Studio — System Architecture

AutoTube Studio is a production-oriented, multi-user-ready automated YouTube content creation system combining a native **Kotlin / Jetpack Compose Android app** with a **Render + Supabase cloud backend**.

---

## High-Level Architecture Diagram

```text
+------------------------------------------------------------------------------+
|                       ANDROID CLIENT (Kotlin + Compose)                      |
|  - Material 3 Studio UI (Dashboard, Create, Autopilot, Projects, Job View)   |
|  - Media3 ExoPlayer Preview | Storage Access Framework | Custom Tabs OAuth   |
|  - Room Local Cache (user_id isolated) | Android Keystore AES-256 Sessions   |
|  - WorkManager Local Sync -> Android Notifications                           |
+------------------------+---------------------------------+-------------------+
                         | HTTPS (Supabase Auth)           | HTTPS + Bearer JWT
                         v                                 v
+----------------------------------+     +-------------------------------------+
|        SUPABASE CLOUD            |     |     RENDER WEB SERVICE (API)        |
|  - Supabase Auth (JWT + Users)   |<--->|  - Express + Helmet + Rate Limiter  |
|  - PostgreSQL + Strict RLS       |     |  - Zod Input Validation             |
|    (profiles, api_credentials,   |     |  - AES-256-GCM BYOK Credential Vault|
|     youtube_accounts, projects,  |     |  - YouTube OAuth 2.0 + HMAC State   |
|     scripts, scenes, jobs,       |     |  - Signed Storage URLs              |
|     media_assets, schedules,     |     +------------------+------------------+
|     uploads, notifications)      |                        |
|  - Private Storage Buckets:      |     +------------------+------------------+
|    source-media, voice-audio,    |<--->|  RENDER CRON SCHEDULER (*/5 min)    |
|    thumbnails, rendered-videos,  |     |  - Evaluates enabled user schedules |
|    subtitles, music-tracks       |     |  - Enforces concurrency & slot      |
+----------------+-----------------+     |    idempotency keys                 |
                 ^                       +-------------------------------------+
                 |
                 | Atomic `claim_next_video_job` (FOR UPDATE SKIP LOCKED)
                 v
+------------------------------------------------------------------------------+
|               RENDER BACKGROUND WORKER (Docker + FFmpeg + Node 22)           |
|  1. Topic Research (Verified RSS Feeds + Gemini/OpenAI)                      |
|  2. Script Generation (Duration-Calibrated Word Count, Multi-Language)       |
|  3. Scene Breakdown (English Visual Queries per Scene)                       |
|  4. Stock Media Search (Pexels -> Pixabay -> Wikimedia + Relevance Scoring)  |
|  5. Deduplicated Media Downloader (SSRF Guard + SHA-256 + Supabase Storage)  |
|  6. Voice-Over Synthesis (Gemini TTS / ElevenLabs + Fallback + ffprobe)      |
|  7. FFmpeg Renderer (9:16/16:9/1:1, Ken Burns, SRT Burn-in, Audio Ducking)   |
|  8. 16:9 High-Contrast Thumbnail Compositor & SEO Metadata Generator         |
|  9. Quality Check (ffprobe stream/duration verification)                     |
| 10. YouTube Data API v3 Chunked Resumable Upload & Scheduled Publishing      |
+------------------------------------------------------------------------------+
```

---

## Multi-User Readiness & Security Boundaries

1. **Tenant Isolation Everywhere**: Every PostgreSQL table carries `user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE` and Row Level Security (`auth.uid() = user_id`). Android's local Room cache also partitions every table by `userId`.
2. **Zero-Leak BYOK Credential Vault**: User API keys (Gemini, ElevenLabs, Pexels, Pixabay, OpenAI-compatible) and YouTube OAuth refresh tokens are encrypted server-side with **AES-256-GCM** using `CREDENTIAL_ENCRYPTION_KEY` and owner-bound AAD (`<userId>:<provider>`). Full keys are never stored in the APK or returned by the API.
3. **Crash-Recoverable Persistent Queue**: Jobs live in PostgreSQL (`video_jobs`), never in memory. Workers send periodic heartbeats and claim jobs via `claim_next_video_job` (`FOR UPDATE SKIP LOCKED`). If a Render worker restarts mid-render, stale jobs are reclaimed automatically and skip already-completed stages (`completed_stages`) so API credits are never wasted.
4. **SSRF & Command Injection Protection**: Outbound downloads enforce HTTPS + strict host allowlists + private IP blocking (`urlGuard.ts`). FFmpeg and FFprobe are executed via `execFile` argument arrays with zero shell interpolation, and temporary job directories are strictly confined and removed in `finally`.
