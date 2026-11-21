import { sanitizeErrorMessage } from './config/env.js';
import { getSupabaseAdmin } from './db/supabase.js';

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

/**
 * Generates a deterministic idempotency key per user + UTC date + publishing slot
 * so overlapping cron invocations can NEVER spawn duplicate scheduled videos.
 */
export function buildScheduleSlotIdempotencyKey(userId: string, runDate: Date): string {
  const day = runDate.toISOString().slice(0, 10);
  const hourBucket = String(runDate.getUTCHours()).padStart(2, '0');
  return `sched-${userId}-${day}-h${hourBucket}`;
}

export function computeFollowingRunIso(
  publishingTimes: string[],
  videosPerDay: number,
  now = new Date()
): string {
  const intervalHours = Math.max(1, Math.floor(24 / Math.max(1, videosPerDay)));
  const firstTime = Array.isArray(publishingTimes) && publishingTimes[0] ? publishingTimes[0] : '14:00';
  const [hh, mm] = firstTime.split(':').map(Number);

  const candidate = new Date(now);
  if (videosPerDay <= 1) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
    candidate.setUTCHours(Number.isFinite(hh) ? hh : 14, Number.isFinite(mm) ? mm : 0, 0, 0);
    return candidate.toISOString();
  }

  return new Date(now.getTime() + intervalHours * 3600 * 1000).toISOString();
}

/**
 * Render Cron Scheduler entry point (runs every 5 minutes).
 * Evaluates all enabled user schedules due now, respects max_concurrent_jobs,
 * enforces duplicate-job prevention, and enqueues persistent jobs in PostgreSQL.
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
      const prefs = schedule.preferences || {};
      const maxConcurrent = Number(prefs.max_concurrent_jobs || 1);

      // Check active running jobs for this user to enforce per-user concurrency limit
      const { count: activeCount } = await supabase
        .from('video_jobs')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', schedule.user_id)
        .not('status', 'in', '("published","scheduled","failed","cancelled","awaiting_approval")');

      if ((activeCount || 0) >= maxConcurrent) {
        skipped++;
        continue;
      }

      const slotKey = buildScheduleSlotIdempotencyKey(schedule.user_id, now);
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
          voice_id: String(prefs.voice_id || 'Kore'),
          upload_config: {
            auto_upload: Boolean(prefs.auto_publish),
            privacy_status: String(prefs.upload_privacy || 'private'),
            scheduled_publish_time: null,
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

      const nextRunAt = computeFollowingRunIso(
        schedule.publishing_times,
        schedule.videos_per_day,
        now
      );
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
