import { Router, type Request, type Response } from 'express';

export const publicPagesRouter = Router();

function renderLayout(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${title} — AutoTube Studio</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      background: #0b0e14;
      color: #f3f4f6;
      line-height: 1.65;
    }
    .wrap {
      max-width: 760px;
      margin: 0 auto;
      padding: 40px 20px 64px;
    }
    .card {
      background: #141923;
      border: 1px solid #263042;
      border-radius: 18px;
      padding: 28px;
      box-shadow: 0 18px 40px rgba(0, 0, 0, 0.35);
    }
    .badge {
      display: inline-block;
      background: rgba(230, 57, 70, 0.16);
      color: #ff6b78;
      border: 1px solid rgba(230, 57, 70, 0.35);
      border-radius: 999px;
      padding: 4px 12px;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      margin-bottom: 12px;
    }
    h1 { margin: 0 0 12px; font-size: 28px; line-height: 1.25; }
    h2 { margin: 24px 0 8px; font-size: 18px; color: #e2e8f0; }
    p, li { color: #cbd5e1; font-size: 15px; }
    ul { padding-left: 20px; }
    a { color: #38bdf8; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .nav {
      display: flex;
      gap: 18px;
      flex-wrap: wrap;
      margin-top: 24px;
      padding-top: 18px;
      border-top: 1px solid #263042;
      font-size: 14px;
    }
    .muted { color: #94a3b8; font-size: 13px; margin-top: 20px; }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="card">
      <div class="badge">AutoTube Studio</div>
      ${bodyHtml}
      <nav class="nav">
        <a href="/">Home</a>
        <a href="/privacy">Privacy Policy</a>
        <a href="/terms">Terms of Service</a>
        <a href="/health">Service Status</a>
      </nav>
    </section>
  </main>
</body>
</html>`;
}

publicPagesRouter.get('/', (_req: Request, res: Response) => {
  res.status(200).type('html').send(
    renderLayout(
      'Home',
      `<h1>AutoTube Studio</h1>
      <p>AutoTube Studio is a cloud-backed Android studio for automating YouTube video scripting, voiceover synthesis, stock media assembly, FFmpeg rendering, and scheduled YouTube channel publishing.</p>
      <h2>Core Capabilities</h2>
      <ul>
        <li><strong>BYOK AI &amp; Media Pipeline:</strong> Users connect their own API keys (Gemini, Pexels, Pixabay, ElevenLabs) encrypted at rest with AES-256-GCM.</li>
        <li><strong>Official YouTube Data API v3 Integration:</strong> Connects via Google OAuth 2.0 least-privilege scopes (<code>youtube.upload</code> and <code>youtube.readonly</code>) to publish rendered videos directly to the user's authorized YouTube channel.</li>
        <li><strong>Cloud Autopilot &amp; Zero-Bloat Cleanup:</strong> Background cloud workers render videos automatically on schedule and purge heavy temporary media files after successful upload.</li>
      </ul>
      <p class="muted">Need help or data deletion? Sign in to the AutoTube Studio Android app and open Settings &rarr; Delete Account &amp; Cloud Data.</p>`
    )
  );
});

publicPagesRouter.get('/privacy', (_req: Request, res: Response) => {
  res.status(200).type('html').send(
    renderLayout(
      'Privacy Policy',
      `<h1>Privacy Policy</h1>
      <p><strong>Effective Date:</strong> November 2026</p>
      <p>AutoTube Studio respects your privacy and is committed to protecting your personal data and connected YouTube account credentials.</p>

      <h2>1. Data We Collect</h2>
      <ul>
        <li><strong>Account Identity:</strong> Your email address and basic profile identifier provided via Supabase Auth / Google Sign-In to isolate your workspace.</li>
        <li><strong>User-Provided API Keys (BYOK):</strong> Optional third-party API keys you enter (e.g., Gemini, Pexels, Pixabay, ElevenLabs) are encrypted server-side using AES-256-GCM before storage.</li>
        <li><strong>YouTube Account Data:</strong> When you authorize YouTube via Google OAuth 2.0, we request only <code>youtube.upload</code> and <code>youtube.readonly</code> scopes to fetch your channel title/metadata and upload videos you schedule or trigger. OAuth refresh tokens are encrypted at rest with AES-256-GCM.</li>
        <li><strong>Generated Project Content:</strong> Scripts, titles, schedules, and temporary render assets created by your jobs. Rendered video/audio files are automatically purged from cloud storage after successful YouTube upload.</li>
      </ul>

      <h2>2. How We Use Your Data</h2>
      <p>Your data is used strictly to generate, render, and upload videos to your chosen YouTube channel according to your manual requests or Autopilot schedule. We never sell your personal data, never access your Google password, and never share your tokens or API keys with unauthorized third parties.</p>

      <h2>3. Google API Services User Data Policy (Limited Use)</h2>
      <p>AutoTube Studio's use and transfer to any other app of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noopener noreferrer">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>

      <h2>4. Revoking Access &amp; Data Deletion</h2>
      <ul>
        <li>You can disconnect your YouTube channel at any time inside the AutoTube Studio app (Settings &rarr; YouTube Integration &rarr; Disconnect Channel) or via your <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener noreferrer">Google Account Permissions</a> page.</li>
        <li>You can permanently delete your account, encrypted API keys, YouTube tokens, projects, and stored files at any time inside the app via <strong>Settings &rarr; Delete Account &amp; Cloud Data</strong>.</li>
      </ul>`
    )
  );
});

publicPagesRouter.get('/terms', (_req: Request, res: Response) => {
  res.status(200).type('html').send(
    renderLayout(
      'Terms of Service',
      `<h1>Terms of Service</h1>
      <p><strong>Effective Date:</strong> November 2026</p>
      <p>By using AutoTube Studio, you agree to these terms and to comply with applicable platform rules.</p>

      <h2>1. YouTube API &amp; Platform Compliance</h2>
      <p>AutoTube Studio integrates with YouTube API Services. By connecting a YouTube channel and publishing videos, you also agree to be bound by the <a href="https://www.youtube.com/t/terms" target="_blank" rel="noopener noreferrer">YouTube Terms of Service</a> and <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">Google Privacy Policy</a>.</p>

      <h2>2. User Content &amp; API Keys</h2>
      <ul>
        <li>You retain full responsibility for the scripts, topics, media, and videos published to your YouTube channel.</li>
        <li>You are responsible for keeping your third-party provider accounts (Gemini, Pexels, Pixabay, ElevenLabs) in good standing and respecting their rate limits and usage policies.</li>
        <li>You must not use AutoTube Studio to publish unlawful, infringing, spam, or policy-violating content.</li>
      </ul>

      <h2>3. Service Availability &amp; Account Termination</h2>
      <p>AutoTube Studio is provided on an "as-is" basis. You may stop using the service and permanently delete your account and cloud data at any time from within the application settings.</p>`
    )
  );
});
