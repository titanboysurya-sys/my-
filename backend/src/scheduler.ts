import { sanitizeErrorMessage } from './config/env.js';
import { getSupabaseAdmin } from './db/supabase.js';
import { normalizeSubtitlePreset } from './services/ffmpegRenderer.js';

export interface ChannelScheduleConfig {
  channelId: string;
  channelName?: string;
  enabled: boolean;
  niche: string;
  language: string;
  audienceCountry: string;
  videoFormat: '9:16' | '16:9' | '1:1';
  durationSeconds: number;
  videosPerDay: number;
  publishingTimes: string[];
  daysOfWeek: string[];
  timezone: string;
  voiceProvider?: string;
  voiceId?: string;
  subtitleStyle?: string;
  autoPublish?: boolean;
  uploadPrivacy?: 'private' | 'unlisted' | 'public';
  preferredTopics?: string[];
  avoidedTopics?: string[];
  contentStyle?: string;
  qualityPreset?: '720p' | '1080p';
  editingPace?: string;
  bgmMood?: string;
  sfxEnabled?: boolean;
  colorGrade?: string;
  whisperSync?: boolean;
  hookStyle?: string;
  hookBannerEnabled?: boolean;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
}

export interface DueScheduleRow {
  id: string;
  user_id: string;
  niche: string;
  language: string;
  audience_country: string;
  video_format: '9:16' | '16:9' | '1:1';
  duration_seconds: number;
  videos_per_day: number;
  publishing_times: string[];
  days_of_week: string[];
  timezone: string;
  preferences: Record<string, unknown>;
  next_run_at: string | null;
}

const VALID_WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

function resolveSafeTimeZone(tz?: string): string {
  const candidate = (tz || 'UTC').trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return 'UTC';
  }
}

function getZonedDateParts(
  date: Date,
  timeZone: string
): { year: number; month: number; day: number; hour: number; minute: number; weekday: string } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  });
  const parts = formatter.formatToParts(date);
  const read = (type: string) => parts.find((p) => p.type === type)?.value || '';
  const rawHour = Number(read('hour'));
  return {
    year: Number(read('year')),
    month: Number(read('month')),
    day: Number(read('day')),
    hour: rawHour === 24 ? 0 : rawHour,
    minute: Number(read('minute')),
    weekday: read('weekday').slice(0, 3).toLowerCase(),
  };
}

/**
 * Converts a local wall-clock timestamp (year, month, day, hour, minute) in any IANA timezone
 * (including half-hour offsets like Asia/Kolkata +05:30 and DST zones) into an exact UTC Date.
 */
function zonedWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): Date {
  const targetUtcAsWall = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let guess = new Date(targetUtcAsWall);

  // Two iterations converge to exact UTC instant even across DST / half-hour boundaries
  for (let i = 0; i < 2; i++) {
    const zoned = getZonedDateParts(guess, timeZone);
    const zonedAsWall = Date.UTC(
      zoned.year,
      zoned.month - 1,
      zoned.day,
      zoned.hour,
      zoned.minute,
      0,
      0
    );
    const diffMs = targetUtcAsWall - zonedAsWall;
    if (diffMs === 0) break;
    guess = new Date(guess.getTime() + diffMs);
  }
  return guess;
}

/**
 * Computes the next exact UTC ISO timestamp matching the user's chosen local publishingTimes,
 * daysOfWeek, and IANA timezone (e.g. Asia/Kolkata, America/New_York, UTC).
 */
export function computeNextScheduledSlotIso(params: {
  publishingTimes: string[];
  daysOfWeek?: string[];
  timezone?: string;
  now?: Date;
}): string {
  const tz = resolveSafeTimeZone(params.timezone);
  const now = params.now ?? new Date();
  const minFutureMs = now.getTime() + 60 * 1000;

  const allowedDays = new Set(
    (params.daysOfWeek && params.daysOfWeek.length > 0
      ? params.daysOfWeek
      : [...VALID_WEEKDAYS]
    ).map((d) => d.trim().slice(0, 3).toLowerCase())
  );
  if (allowedDays.size === 0) {
    for (const d of VALID_WEEKDAYS) allowedDays.add(d);
  }

  const parsedTimes = (params.publishingTimes && params.publishingTimes.length > 0
    ? params.publishingTimes
    : ['18:00']
  )
    .map((t) => {
      const [hRaw, mRaw] = t.trim().split(':');
      const h = Number(hRaw);
      const m = Number(mRaw);
      if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || h > 23 || m < 0 || m > 59) {
        return null;
      }
      return { hour: h, minute: m };
    })
    .filter((x): x is { hour: number; minute: number } => x !== null)
    .sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));

  const effectiveTimes = parsedTimes.length > 0 ? parsedTimes : [{ hour: 18, minute: 0 }];
  const nowLocal = getZonedDateParts(now, tz);

  let earliestCandidate: Date | null = null;

  for (let dayOffset = 0; dayOffset <= 8; dayOffset++) {
    // Advance calendar date cleanly using UTC calendar arithmetic on local Y-M-D
    const baseCal = new Date(Date.UTC(nowLocal.year, nowLocal.month - 1, nowLocal.day + dayOffset, 12, 0, 0));
    const y = baseCal.getUTCFullYear();
    const m = baseCal.getUTCMonth() + 1;
    const d = baseCal.getUTCDate();
    const weekday = VALID_WEEKDAYS[baseCal.getUTCDay()];

    if (!allowedDays.has(weekday)) continue;

    for (const slot of effectiveTimes) {
      const utcInstant = zonedWallClockToUtc(y, m, d, slot.hour, slot.minute, tz);
      if (utcInstant.getTime() >= minFutureMs) {
        if (!earliestCandidate || utcInstant.getTime() < earliestCandidate.getTime()) {
          earliestCandidate = utcInstant;
        }
      }
    }
    if (earliestCandidate) break;
  }

  if (earliestCandidate) {
    return earliestCandidate.toISOString();
  }
  return new Date(now.getTime() + 24 * 3600 * 1000).toISOString();
}

/**
 * Generates a deterministic idempotency key per user (+ optional channel) + UTC date + hour slot
 * so overlapping cron invocations can NEVER spawn duplicate scheduled videos while allowing
 * multiple channels under the same user to run independently.
 */
export function buildScheduleSlotIdempotencyKey(
  userId: string,
  runDate: Date,
  channelId?: string
): string {
  const day = runDate.toISOString().slice(0, 10);
  const hourBucket = String(runDate.getUTCHours()).padStart(2, '0');
  if (channelId) {
    return `sched-${userId}-${channelId}-${day}-h${hourBucket}`;
  }
  return `sched-${userId}-${day}-h${hourBucket}`;
}

export function computeFollowingRunIso(
  publishingTimes: string[],
  videosPerDay: number,
  now = new Date(),
  timezone = 'UTC',
  daysOfWeek?: string[]
): string {
  if (Array.isArray(publishingTimes) && publishingTimes.length > 0) {
    return computeNextScheduledSlotIso({
      publishingTimes,
      daysOfWeek,
      timezone,
      now,
    });
  }
  const intervalHours = Math.max(1, Math.floor(24 / Math.max(1, videosPerDay)));
  return new Date(now.getTime() + intervalHours * 3600 * 1000).toISOString();
}

export function extractChannelSchedules(
  preferences: Record<string, unknown> | null | undefined
): ChannelScheduleConfig[] {
  const raw = preferences?.channel_schedules;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is ChannelScheduleConfig =>
      Boolean(item && typeof item === 'object' && typeof (item as ChannelScheduleConfig).channelId === 'string')
  );
}

/**
 * Computes the earliest upcoming ISO run timestamp across all enabled channel schedules
 * (or falls back to the master schedule).
 */
export function resolveEarliestNextRunIso(
  channelSchedules: ChannelScheduleConfig[],
  fallbackNextRunAt: string | null
): string | null {
  const enabledTimes = channelSchedules
    .filter((c) => c.enabled && c.nextRunAt)
    .map((c) => new Date(c.nextRunAt as string).getTime())
    .filter((ms) => Number.isFinite(ms))
    .sort((a, b) => a - b);

  if (enabledTimes.length > 0) {
    return new Date(enabledTimes[0]).toISOString();
  }
  return fallbackNextRunAt;
}

/**
 * Render Cron Scheduler entry point (runs every 5 minutes).
 * Evaluates all enabled user schedules (including independent per-channel schedules),
 * respects max_concurrent_jobs, enforces duplicate-job prevention, and enqueues persistent jobs.
 */
export async function runSchedulerTick(): Promise<{ enqueued: number; skipped: number }> {
  const supabase = getSupabaseAdmin();
  const now = new Date();
  const nowIso = now.toISOString();

  const { data: dueSchedules, error } = await supabase
    .from('schedules')
    .select('*')
    .eq('enabled', true)
    .or(`next_run_at.is.null,next_run_at.lte.${nowIso}`);

  if (error) {
    throw new Error(`Scheduler query failed: ${error.message}`);
  }

  let enqueued = 0;
  let skipped = 0;

  for (const raw of dueSchedules || []) {
    const schedule = raw as DueScheduleRow;
    try {
      const prefs = (schedule.preferences || {}) as Record<string, unknown>;
      const maxConcurrent = Number(prefs.max_concurrent_jobs || 1);

      const { count: activeCount } = await supabase
        .from('video_jobs')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', schedule.user_id)
        .not('status', 'in', '("published","scheduled","failed","cancelled","awaiting_approval")');

      let remainingSlots = Math.max(0, maxConcurrent - (activeCount || 0));
      if (remainingSlots <= 0) {
        skipped++;
        continue;
      }

      const channelSchedules = extractChannelSchedules(prefs);

      // Multi-channel independent Autopilot mode
      if (channelSchedules.length > 0) {
        let mutated = false;
        const updatedChannels = channelSchedules.map((cs) => ({ ...cs }));

        for (let i = 0; i < updatedChannels.length; i++) {
          const cs = updatedChannels[i];
          if (!cs.enabled) continue;

          const isDue = !cs.nextRunAt || new Date(cs.nextRunAt).getTime() <= now.getTime();
          if (!isDue) continue;

          if (remainingSlots <= 0) {
            skipped++;
            continue;
          }

          const slotKey = buildScheduleSlotIdempotencyKey(schedule.user_id, now, cs.channelId);
          const { data: existingJob } = await supabase
            .from('video_jobs')
            .select('id')
            .eq('idempotency_key', slotKey)
            .maybeSingle();

          if (existingJob) {
            // Advance past this slot so we don't spin on it
            cs.nextRunAt = computeNextScheduledSlotIso({
              publishingTimes: cs.publishingTimes || schedule.publishing_times,
              daysOfWeek: cs.daysOfWeek || schedule.days_of_week,
              timezone: cs.timezone || schedule.timezone,
              now,
            });
            mutated = true;
            skipped++;
            continue;
          }

          const { data: project, error: projErr } = await supabase
            .from('projects')
            .insert({
              user_id: schedule.user_id,
              title: cs.channelName
                ? `Auto Scheduled (${cs.channelName})`
                : 'Auto Scheduled Video',
              topic: 'auto',
              niche: cs.niche || schedule.niche,
              language: cs.language || schedule.language,
              audience_country: cs.audienceCountry || schedule.audience_country,
              content_style: String(cs.contentStyle || prefs.content_style || 'documentary'),
              format: cs.videoFormat || schedule.video_format,
              duration_seconds: cs.durationSeconds || schedule.duration_seconds,
              quality_preset: cs.qualityPreset === '720p' ? '720p' : '1080p',
              auto_produce: true,
              voice_provider: String(cs.voiceProvider || prefs.voice_provider || 'gemini_tts'),
              voice_id: String(cs.voiceId || prefs.voice_id || 'Charon'),
              subtitle_style: {
                enabled: true,
                burn_in: true,
                preset: normalizeSubtitlePreset(
                  String(cs.subtitleStyle || prefs.subtitle_style || 'mrbeast')
                ),
                font_size: 44,
                primary_color: '#FFFFFF',
                highlight_color: '#FFE600',
                outline_color: '#000000',
                position: 'bottom_safe',
              },
              upload_config: {
                auto_upload: cs.autoPublish !== undefined ? Boolean(cs.autoPublish) : Boolean(prefs.auto_publish),
                review_before_upload: false,
                privacy_status: String(cs.uploadPrivacy || prefs.upload_privacy || 'private'),
                scheduled_publish_time: null,
                youtube_account_id: cs.channelId,
                media_source_mode: 'all',
                editing_pace: String(cs.editingPace || prefs.editing_pace || 'viral_fast'),
                bgm_mood: String(cs.bgmMood || prefs.bgm_mood || 'auto'),
                sfx_enabled: cs.sfxEnabled !== undefined ? Boolean(cs.sfxEnabled) : prefs.sfx_enabled !== false,
                color_grade: String(cs.colorGrade || prefs.color_grade || 'vibrant'),
                whisper_sync: cs.whisperSync !== undefined ? Boolean(cs.whisperSync) : prefs.whisper_sync !== false,
                hook_style: String(cs.hookStyle || prefs.hook_style || 'viral_retention'),
                hook_banner: cs.hookBannerEnabled !== undefined ? Boolean(cs.hookBannerEnabled) : prefs.hook_banner !== false,
              },
              status: 'queued',
            })
            .select('id')
            .single();

          if (projErr || !project) {
            throw new Error(projErr?.message || 'Failed to create channel-scheduled project');
          }

          await supabase.from('video_jobs').insert({
            user_id: schedule.user_id,
            project_id: project.id,
            job_type: 'scheduled_autopilot',
            status: 'queued',
            current_stage: 'queued',
            progress: 0,
            status_message: cs.channelName
              ? `Scheduled by Cloud Autopilot for ${cs.channelName}`
              : 'Scheduled by Cloud Autopilot',
            max_retries: Number(prefs.max_retries || 3),
            idempotency_key: slotKey,
          });

          cs.lastRunAt = nowIso;
          cs.nextRunAt = computeNextScheduledSlotIso({
            publishingTimes: cs.publishingTimes || schedule.publishing_times,
            daysOfWeek: cs.daysOfWeek || schedule.days_of_week,
            timezone: cs.timezone || schedule.timezone,
            now,
          });
          mutated = true;
          remainingSlots--;
          enqueued++;
        }

        if (mutated) {
          const earliest = resolveEarliestNextRunIso(updatedChannels, null);
          await supabase
            .from('schedules')
            .update({
              last_run_at: nowIso,
              next_run_at: earliest,
              preferences: { ...prefs, channel_schedules: updatedChannels },
            })
            .eq('id', schedule.id);
        }
        continue;
      }

      // Single-channel / legacy schedule mode
      const targetChannelId =
        typeof prefs.youtube_account_id === 'string' && prefs.youtube_account_id.trim()
          ? prefs.youtube_account_id.trim()
          : undefined;
      const slotKey = buildScheduleSlotIdempotencyKey(schedule.user_id, now, targetChannelId);
      const { data: existingJob } = await supabase
        .from('video_jobs')
        .select('id')
        .eq('idempotency_key', slotKey)
        .maybeSingle();

      if (existingJob) {
        skipped++;
        continue;
      }

      const { data: project, error: projErr } = await supabase
        .from('projects')
        .insert({
          user_id: schedule.user_id,
          title: 'Auto Scheduled Video',
          topic: 'auto',
          niche: schedule.niche,
          language: schedule.language,
          audience_country: schedule.audience_country,
          content_style: String(prefs.content_style || 'documentary'),
          format: schedule.video_format,
          duration_seconds: schedule.duration_seconds,
          quality_preset: prefs.quality_preset === '720p' ? '720p' : '1080p',
          auto_produce: true,
          voice_provider: String(prefs.voice_provider || 'gemini_tts'),
          voice_id: String(prefs.voice_id || 'Charon'),
          subtitle_style: {
            enabled: true,
            burn_in: true,
            preset: normalizeSubtitlePreset(String(prefs.subtitle_style || 'mrbeast')),
            font_size: 44,
            primary_color: '#FFFFFF',
            highlight_color: '#FFE600',
            outline_color: '#000000',
            position: 'bottom_safe',
          },
          upload_config: {
            auto_upload: Boolean(prefs.auto_publish),
            review_before_upload: false,
            privacy_status: String(prefs.upload_privacy || 'private'),
            scheduled_publish_time: null,
            youtube_account_id: targetChannelId || null,
            media_source_mode: 'all',
            editing_pace: String(prefs.editing_pace || 'viral_fast'),
            bgm_mood: String(prefs.bgm_mood || 'auto'),
            sfx_enabled: prefs.sfx_enabled !== false,
            color_grade: String(prefs.color_grade || 'vibrant'),
            whisper_sync: prefs.whisper_sync !== false,
            hook_style: String(prefs.hook_style || 'viral_retention'),
            hook_banner: prefs.hook_banner !== false,
          },
          status: 'queued',
        })
        .select('id')
        .single();

      if (projErr || !project) {
        throw new Error(projErr?.message || 'Failed to create scheduled project');
      }

      await supabase.from('video_jobs').insert({
        user_id: schedule.user_id,
        project_id: project.id,
        job_type: 'scheduled_autopilot',
        status: 'queued',
        current_stage: 'queued',
        progress: 0,
        status_message: 'Scheduled by Cloud Autopilot',
        max_retries: Number(prefs.max_retries || 3),
        idempotency_key: slotKey,
      });

      const nextRunAt = computeNextScheduledSlotIso({
        publishingTimes: schedule.publishing_times,
        daysOfWeek: schedule.days_of_week,
        timezone: schedule.timezone,
        now,
      });
      await supabase
        .from('schedules')
        .update({ last_run_at: nowIso, next_run_at: nextRunAt })
        .eq('id', schedule.id);

      enqueued++;
    } catch (err) {
      console.error(
        `[AutoTube Scheduler] Error processing schedule ${schedule.id}: ${sanitizeErrorMessage(err)}`
      );
      skipped++;
    }
  }

  return { enqueued, skipped };
}

const isMainModule =
  process.argv[1] &&
  (process.argv[1].endsWith('scheduler.js') || process.argv[1].endsWith('scheduler.ts'));

if (isMainModule) {
  runSchedulerTick()
    .then((res) => {
      console.log(
        `[AutoTube Scheduler] Completed tick: enqueued=${res.enqueued}, skipped=${res.skipped}`
      );
      process.exit(0);
    })
    .catch((err) => {
      console.error(`[AutoTube Scheduler] Fatal: ${sanitizeErrorMessage(err)}`);
      process.exit(1);
    });
}
