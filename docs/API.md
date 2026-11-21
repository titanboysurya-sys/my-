# AutoTube Studio — REST API Documentation

All `/api/*` endpoints (except `GET /api/youtube/oauth/callback` and `GET /health`) require:

```http
Authorization: Bearer <supabase_access_token>
Content-Type: application/json
```

The backend verifies the JWT against Supabase Auth and scopes every database query strictly to `req.user.id`.

---

## System Health

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/health` | Public liveness & configuration check for Render health checks and Android setup verification. |

---

## Dashboard & Profile

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/api/dashboard` | Returns connected channel, Autopilot status, next scheduled run, today's/completed/scheduled/failed stats, recent jobs, and recent notifications. |
| `GET` | `/api/profile` | Fetches authenticated user's profile, quotas, and preferences. |
| `PUT` | `/api/profile/preferences` | Updates user preferences (default provider routing, language, quality). |

---

## BYOK API Credentials

Full keys are encrypted with AES-256-GCM and **never returned** in responses. Only `maskedKey` and live validation statuses are returned.

| Method | Path | Body / Notes |
| :--- | :--- | :--- |
| `GET` | `/api/credentials` | Lists all supported providers (`gemini`, `elevenlabs`, `pexels`, `pixabay`, `openai_compatible`) with status, masked key, usage info, and docs URL. |
| `POST` | `/api/credentials/validate` | `{ provider, apiKey, providerConfig? }` — Live-validates key against the provider without saving. |
| `POST` | `/api/credentials` | `{ provider, apiKey, providerConfig?, skipValidation? }` — Validates, encrypts, and stores the key. |
| `DELETE` | `/api/credentials/:provider` | Permanently removes the stored key for the authenticated user. |

---

## YouTube Account Integration (OAuth 2.0)

| Method | Path | Description |
| :--- | :--- | :--- |
| `POST` | `/api/youtube/connect` | Returns `{ authUrl }` with HMAC-signed state and minimal scopes (`youtube.upload`, `youtube.readonly`). |
| `GET` | `/api/youtube/oauth/callback` | Google OAuth redirect handler; exchanges code, fetches channels, encrypts refresh token, and redirects back to `autotubestudio://oauth/youtube`. |
| `GET` | `/api/youtube/accounts` | Lists connected YouTube channels for the current user. |
| `GET` | `/api/youtube/status` | Returns active connection status and default channel summary. |
| `POST` | `/api/youtube/disconnect` | `{ accountId? }` — Removes stored YouTube OAuth connection(s). |

---

## Topic Research, Projects & Scripts

| Method | Path | Description |
| :--- | :--- | :--- |
| `POST` | `/api/research/topics` | Fetches verified RSS items (for `news`/`trending`) + generates structured topic suggestions with references. |
| `POST` | `/api/projects` | Creates a video project and optionally queues a `full_pipeline` job (`startImmediately: true`). |
| `GET` | `/api/projects` | Lists user projects enriched with 1-hour signed Storage URLs for thumbnails and rendered MP4s. |
| `GET` | `/api/projects/:id` | Returns project metadata, signed URLs, versioned scripts, scene breakdown, media manifest, jobs, and uploads. |
| `PUT` | `/api/projects/:id/script` | `{ narrationText, titleIdea?, approveAndContinue }` — Saves edited script version and optionally resumes an `awaiting_approval` job. |
| `POST` | `/api/projects/:id/script/regenerate` | `{ tone?, durationSeconds? }` — Regenerates a new script version via user's AI provider. |
| `DELETE` | `/api/projects/:id` | Deletes a project and cascades scripts, scenes, jobs, and uploads. |

---

## Persistent Jobs

| Method | Path | Description |
| :--- | :--- | :--- |
| `POST` | `/api/jobs/create` | `{ projectId, jobType?, idempotencyKey? }` — Enqueues a job idempotently. |
| `GET` | `/api/jobs` | Lists user's jobs ordered newest first. |
| `GET` | `/api/jobs/:id` | Gets detailed job status, progress, `completed_stages`, retry count, and error message. |
| `POST` | `/api/jobs/:id/retry` | Re-queues a failed job while preserving `completed_stages` so completed work is skipped. |
| `POST` | `/api/jobs/:id/cancel` | Cancels a queued or active job. |

---

## Cloud Autopilot Automation & Uploads

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/api/automation/settings` | Fetches user's Autopilot schedule configuration. |
| `PUT` | `/api/automation/settings` | Upserts schedule (niche, language, format, duration, videos/day, times, days, timezone, preferences). |
| `POST` | `/api/automation/start` | Enables Autopilot and schedules next run. |
| `POST` | `/api/automation/pause` | Pauses Autopilot scheduling. |
| `GET` | `/api/uploads` | Lists YouTube uploads and scheduled publish status. |
| `GET` | `/api/uploads/:id` | Fetches a specific upload record. |
| `GET` | `/api/notifications` | Lists recent pipeline and YouTube status events for Android notification sync. |
