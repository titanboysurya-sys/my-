import crypto from 'node:crypto';
import { config, sanitizeErrorMessage } from './config/env.js';
import { getSupabaseAdmin } from './db/supabase.js';
import { executeVideoJob, type VideoJobRow } from './services/pipelineExecutor.js';

export function startWorkerLoop(): { stop: () => void } {
  const workerId = `worker-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  let shuttingDown = false;

  async function pollLoop(): Promise<void> {
    console.log(`[AutoTube Worker] Started ${workerId} (poll=${config.workerPollIntervalMs}ms)`);

    while (!shuttingDown) {
      try {
        if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
          await new Promise((resolve) => setTimeout(resolve, config.workerPollIntervalMs));
          continue;
        }
        const supabase = getSupabaseAdmin();
        const { data, error } = await supabase.rpc('claim_next_video_job', {
          p_worker_id: workerId,
          p_stale_seconds: config.workerStaleJobSeconds,
        });

        if (error) {
          console.error(`[AutoTube Worker] Queue poll error: ${sanitizeErrorMessage(error.message)}`);
        } else if (Array.isArray(data) && data.length > 0) {
          const job = data[0] as VideoJobRow;
          console.log(`[AutoTube Worker] Claimed job ${job.id} (stage=${job.current_stage})`);
          await executeVideoJob(job);
          console.log(`[AutoTube Worker] Finished cycle for job ${job.id}`);
          continue; // Immediately check for another queued job
        }
      } catch (err) {
        console.error(`[AutoTube Worker] Loop exception: ${sanitizeErrorMessage(err)}`);
      }

      await new Promise((resolve) => setTimeout(resolve, config.workerPollIntervalMs));
    }

    console.log(`[AutoTube Worker] ${workerId} exited cleanly.`);
  }

  void pollLoop();
  return {
    stop: () => {
      shuttingDown = true;
    },
  };
}

const isMainModule =
  process.argv[1] &&
  (process.argv[1].endsWith('worker.js') || process.argv[1].endsWith('worker.ts'));

if (isMainModule) {
  const handle = startWorkerLoop();
  const stopWorker = () => {
    console.log('[AutoTube Worker] Shutdown signal received — draining current job before exit');
    handle.stop();
  };
  process.on('SIGTERM', stopWorker);
  process.on('SIGINT', stopWorker);
}
