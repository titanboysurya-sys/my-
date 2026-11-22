import cors from 'cors';
import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import { config, sanitizeErrorMessage } from './config/env.js';
import { ensureAllCoreBuckets } from './db/supabase.js';
import { apiRateLimiter } from './middleware/auth.js';
import { apiRouter } from './routes/apiRoutes.js';
import { publicPagesRouter } from './routes/publicPages.js';
import { runSchedulerTick } from './scheduler.js';
import { startWorkerLoop } from './worker.js';

const embeddedWorkerEnabled = process.env.EMBEDDED_WORKER_ENABLED !== 'false';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(
    cors({
      origin: (origin, callback) => {
        // Mobile native clients (Android OkHttp/Retrofit) omit Origin header; allow them.
        if (!origin) {
          callback(null, true);
          return;
        }
        if (config.corsAllowedOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error('Origin not permitted by CORS policy'));
      },
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Authorization', 'Content-Type'],
    })
  );

  app.use(express.json({ limit: '2mb' }));
  app.use(apiRateLimiter);

  app.use('/', publicPagesRouter);

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'autotube-studio-api',
      timestamp: new Date().toISOString(),
      supabaseConfigured: Boolean(config.supabaseUrl && config.supabaseServiceRoleKey),
      encryptionConfigured: Boolean(config.credentialEncryptionKeyHex),
      youtubeOAuthConfigured: Boolean(config.googleClientId && config.googleClientSecret),
      embeddedWorkerEnabled,
    });
  });

  app.use('/api', apiRouter);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: sanitizeErrorMessage(err) });
  });

  return app;
}

const isMainModule =
  process.argv[1] &&
  (process.argv[1].endsWith('server.js') || process.argv[1].endsWith('server.ts'));

if (isMainModule) {
  const app = createApp();
  let workerHandle: { stop: () => void } | null = null;
  let schedulerTimer: NodeJS.Timeout | null = null;

  const server = app.listen(config.port, () => {
    console.log(
      `[AutoTube API] Listening on port ${config.port} (${config.nodeEnv}, embeddedWorker=${embeddedWorkerEnabled})`
    );
    void ensureAllCoreBuckets();
    if (embeddedWorkerEnabled) {
      workerHandle = startWorkerLoop();
      schedulerTimer = setInterval(() => {
        if (!config.supabaseUrl || !config.supabaseServiceRoleKey) return;
        runSchedulerTick().catch((err) => {
          console.error(`[AutoTube Embedded Scheduler] Tick error: ${sanitizeErrorMessage(err)}`);
        });
      }, 5 * 60 * 1000);
    }
  });

  const shutdown = () => {
    console.log('[AutoTube API] Shutting down gracefully...');
    workerHandle?.stop();
    if (schedulerTimer) clearInterval(schedulerTimer);
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
