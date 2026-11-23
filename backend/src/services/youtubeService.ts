import fs from 'node:fs/promises';
import { config, sanitizeErrorMessage } from '../config/env.js';
import { getSupabaseAdmin } from '../db/supabase.js';
import {
  createSignedOAuthState,
  decryptSecret,
  encryptSecret,
  verifySignedOAuthState,
} from '../security/crypto.js';

const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
];

export interface YouTubeChannelSummary {
  id: string;
  channelId: string;
  channelName: string;
  channelHandle: string | null;
  channelThumbnailUrl: string | null;
  subscriberCount: number;
  tokenStatus: string;
  isDefault: boolean;
  connectedAt: string;
}

export function buildYouTubeOAuthConsentUrl(userId: string): string {
  if (!config.googleClientId || !config.youtubeOAuthRedirectUri) {
    throw new Error(
      'Google OAuth is not configured on the backend. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and YOUTUBE_OAUTH_REDIRECT_URI on Render.'
    );
  }

  const state = createSignedOAuthState(userId, config.oauthStateSecret, 900);
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', config.googleClientId);
  url.searchParams.set('redirect_uri', config.youtubeOAuthRedirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', YOUTUBE_SCOPES.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'select_account consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', state);
  return url.toString();
}

export async function handleYouTubeOAuthCallback(
  code: string,
  state: string
): Promise<{ userId: string; channels: YouTubeChannelSummary[] }> {
  const verified = verifySignedOAuthState(state, config.oauthStateSecret);
  const userId = verified.userId;

  if (!config.googleClientId || !config.googleClientSecret || !config.youtubeOAuthRedirectUri) {
    throw new Error(
      'Missing GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, or YOUTUBE_OAUTH_REDIRECT_URI on backend.'
    );
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      redirect_uri: config.youtubeOAuthRedirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    throw new Error(`Google OAuth token exchange failed: ${sanitizeErrorMessage(errText)}`);
  }

  const tokenData = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    scope?: string;
  };

  if (!tokenData.access_token) {
    throw new Error('Google OAuth response missing access_token.');
  }

  // Fetch user's YouTube channels via YouTube Data API v3
  const chanRes = await fetch(
    'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true',
    { headers: { Authorization: `Bearer ${tokenData.access_token}` } }
  );

  if (!chanRes.ok) {
    const chanErrBody = await chanRes.text().catch(() => '');
    throw new Error(
      `YouTube channel lookup failed (HTTP ${chanRes.status}): ${sanitizeErrorMessage(chanErrBody)}`
    );
  }

  const chanPayload = (await chanRes.json()) as {
    items?: Array<{
      id: string;
      snippet?: {
        title?: string;
        customUrl?: string;
        thumbnails?: { default?: { url?: string }; medium?: { url?: string } };
      };
      statistics?: { subscriberCount?: string };
    }>;
  };

  const items = chanPayload.items || [];
  if (items.length === 0) {
    throw new Error(
      'No YouTube channel found on this Google account. Open YouTube.com with this account, create a channel, and try connecting again.'
    );
  }

  const supabase = getSupabaseAdmin();
  const saved: YouTubeChannelSummary[] = [];

  const { data: existingAccounts } = await supabase
    .from('youtube_accounts')
    .select('id, channel_id, is_default')
    .eq('user_id', userId);
  const existingDefaultChannelId = (existingAccounts || []).find((a) => a.is_default)?.channel_id || null;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    // If reconnecting and Google did not reissue refresh_token, reuse existing stored token if present
    let encryptedPayload: { ciphertext: string; iv: string; authTag: string };
    if (tokenData.refresh_token) {
      encryptedPayload = encryptSecret(
        tokenData.refresh_token,
        config.credentialEncryptionKeyHex,
        `${userId}:youtube:${item.id}`
      );
    } else {
      const { data: existing } = await supabase
        .from('youtube_accounts')
        .select('encrypted_refresh_token, token_iv, token_auth_tag')
        .eq('user_id', userId)
        .eq('channel_id', item.id)
        .maybeSingle();

      if (!existing?.encrypted_refresh_token) {
        throw new Error(
          'Google did not return a refresh token. Go to myaccount.google.com/permissions, remove this app, and reconnect to grant offline upload permission.'
        );
      }
      encryptedPayload = {
        ciphertext: existing.encrypted_refresh_token,
        iv: existing.token_iv,
        authTag: existing.token_auth_tag,
      };
    }

    const shouldBeDefault = existingDefaultChannelId
      ? existingDefaultChannelId === item.id
      : i === 0;

    const { data, error } = await supabase
      .from('youtube_accounts')
      .upsert(
        {
          user_id: userId,
          channel_id: item.id,
          channel_name: item.snippet?.title || 'YouTube Channel',
          channel_handle: item.snippet?.customUrl || null,
          channel_thumbnail_url:
            item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || null,
          subscriber_count: Number(item.statistics?.subscriberCount || 0),
          encrypted_refresh_token: encryptedPayload.ciphertext,
          token_iv: encryptedPayload.iv,
          token_auth_tag: encryptedPayload.authTag,
          scopes: YOUTUBE_SCOPES,
          token_status: 'connected',
          is_default: shouldBeDefault,
          last_error: null,
        },
        { onConflict: 'user_id,channel_id' }
      )
      .select(
        'id, channel_id, channel_name, channel_handle, channel_thumbnail_url, subscriber_count, token_status, is_default, connected_at'
      )
      .single();

    if (error || !data) {
      throw new Error(`Failed to store YouTube channel connection: ${error?.message}`);
    }

    saved.push({
      id: data.id,
      channelId: data.channel_id,
      channelName: data.channel_name,
      channelHandle: data.channel_handle,
      channelThumbnailUrl: data.channel_thumbnail_url,
      subscriberCount: Number(data.subscriber_count || 0),
      tokenStatus: data.token_status,
      isDefault: Boolean(data.is_default),
      connectedAt: data.connected_at,
    });
  }

  return { userId, channels: saved };
}

export async function listUserYouTubeAccounts(userId: string): Promise<YouTubeChannelSummary[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('youtube_accounts')
    .select(
      'id, channel_id, channel_name, channel_handle, channel_thumbnail_url, subscriber_count, token_status, is_default, connected_at'
    )
    .eq('user_id', userId)
    .order('is_default', { ascending: false });

  if (error) {
    throw new Error(`Failed to load YouTube accounts: ${error.message}`);
  }

  return (data || []).map((row) => ({
    id: row.id,
    channelId: row.channel_id,
    channelName: row.channel_name,
    channelHandle: row.channel_handle,
    channelThumbnailUrl: row.channel_thumbnail_url,
    subscriberCount: Number(row.subscriber_count || 0),
    tokenStatus: row.token_status,
    isDefault: Boolean(row.is_default),
    connectedAt: row.connected_at,
  }));
}

export async function setDefaultYouTubeAccount(
  userId: string,
  accountId: string
): Promise<YouTubeChannelSummary[]> {
  const supabase = getSupabaseAdmin();
  const { data: target, error: checkErr } = await supabase
    .from('youtube_accounts')
    .select('id')
    .eq('user_id', userId)
    .eq('id', accountId)
    .maybeSingle();

  if (checkErr || !target) {
    throw new Error('Selected YouTube channel was not found.');
  }

  await supabase.from('youtube_accounts').update({ is_default: false }).eq('user_id', userId);
  const { error: setErr } = await supabase
    .from('youtube_accounts')
    .update({ is_default: true })
    .eq('user_id', userId)
    .eq('id', accountId);

  if (setErr) {
    throw new Error(`Failed to set default YouTube channel: ${setErr.message}`);
  }
  return listUserYouTubeAccounts(userId);
}

export async function disconnectYouTubeAccount(userId: string, accountId?: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  let query = supabase.from('youtube_accounts').delete().eq('user_id', userId);
  if (accountId) {
    query = query.eq('id', accountId);
  }
  const { error } = await query;
  if (error) {
    throw new Error(`Failed to disconnect YouTube account: ${error.message}`);
  }
}

/**
 * Refreshes an expired YouTube OAuth access token using the AES-256-GCM encrypted refresh token.
 */
export async function getFreshYouTubeAccessToken(
  userId: string,
  accountId?: string
): Promise<{ accessToken: string; accountRowId: string; channelName: string }> {
  const supabase = getSupabaseAdmin();
  let query = supabase
    .from('youtube_accounts')
    .select('id, channel_id, channel_name, encrypted_refresh_token, token_iv, token_auth_tag')
    .eq('user_id', userId);

  if (accountId) {
    query = query.eq('id', accountId);
  } else {
    query = query.order('is_default', { ascending: false }).limit(1);
  }

  const { data: account, error } = await query.maybeSingle();
  if (error || !account) {
    throw new Error(
      accountId
        ? 'Selected YouTube channel is disconnected or unavailable. Reconnect it in YouTube Settings.'
        : 'No connected YouTube channel found. Connect YouTube in Settings first.'
    );
  }

  const refreshToken = decryptSecret(
    {
      ciphertext: account.encrypted_refresh_token,
      iv: account.token_iv,
      authTag: account.token_auth_tag,
    },
    config.credentialEncryptionKeyHex,
    `${userId}:youtube:${account.channel_id}`
  );

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    const isRevoked = body.includes('invalid_grant');
    await supabase
      .from('youtube_accounts')
      .update({
        token_status: isRevoked ? 'revoked' : 'expired',
        last_error: sanitizeErrorMessage(body),
      })
      .eq('id', account.id);

    throw new Error(
      isRevoked
        ? 'YouTube authorization was revoked. Reconnect your channel in YouTube Settings.'
        : `Failed to refresh YouTube access token (HTTP ${tokenRes.status}).`
    );
  }

  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (!tokenJson.access_token) {
    throw new Error('Google OAuth refresh returned no access token.');
  }

  return {
    accessToken: tokenJson.access_token,
    accountRowId: account.id,
    channelName: account.channel_name,
  };
}

export interface YouTubeResumableUploadInput {
  userId: string;
  projectId: string;
  youtubeAccountId?: string | null;
  localVideoPath: string;
  localThumbnailPath?: string | null;
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  privacyStatus: 'private' | 'unlisted' | 'public';
  scheduledPublishTimeIso?: string | null;
  idempotencyKey: string;
  onProgress?: (percent: number) => Promise<void>;
}

/**
 * Official YouTube Data API v3 Resumable Upload protocol with chunk retries,
 * duplicate upload protection via idempotency key, scheduled publishAt, and thumbnail upload.
 */
export async function uploadVideoToYouTubeResumable(
  input: YouTubeResumableUploadInput
): Promise<{
  youtubeVideoId: string;
  videoUrl: string;
  status: 'scheduled' | 'published';
  channelName?: string;
}> {
  const supabase = getSupabaseAdmin();

  // Duplicate upload protection
  const { data: existingUpload } = await supabase
    .from('uploads')
    .select('youtube_video_id, video_url, upload_status')
    .eq('user_id', input.userId)
    .eq('idempotency_key', input.idempotencyKey)
    .maybeSingle();

  if (existingUpload?.youtube_video_id && existingUpload.video_url) {
    return {
      youtubeVideoId: existingUpload.youtube_video_id,
      videoUrl: existingUpload.video_url,
      status: existingUpload.upload_status === 'scheduled' ? 'scheduled' : 'published',
    };
  }

  const { accessToken, accountRowId, channelName } = await getFreshYouTubeAccessToken(
    input.userId,
    input.youtubeAccountId || undefined
  );
  const videoBuffer = await fs.readFile(input.localVideoPath);
  const totalBytes = videoBuffer.length;

  // YouTube API requires privacyStatus='private' when scheduling publishAt
  const isScheduled = Boolean(input.scheduledPublishTimeIso);
  const effectivePrivacy = isScheduled ? 'private' : input.privacyStatus;

  const metadataBody = {
    snippet: {
      title: input.title.slice(0, 100),
      description: input.description.slice(0, 5000),
      tags: input.tags.slice(0, 25),
      categoryId: input.categoryId || '27',
    },
    status: {
      privacyStatus: effectivePrivacy,
      selfDeclaredMadeForKids: false,
      ...(isScheduled && input.scheduledPublishTimeIso
        ? { publishAt: input.scheduledPublishTimeIso }
        : {}),
    },
  };

  // Step 1: Initiate resumable upload session
  const initRes = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(totalBytes),
        'X-Upload-Content-Type': 'video/mp4',
      },
      body: JSON.stringify(metadataBody),
    }
  );

  if (!initRes.ok) {
    if (initRes.status === 403) {
      throw new Error('YouTube API upload quota exceeded or insufficient channel permissions (HTTP 403).');
    }
    throw new Error(`Failed to initiate YouTube resumable upload (HTTP ${initRes.status}).`);
  }

  const sessionUri = initRes.headers.get('location');
  if (!sessionUri) {
    throw new Error('YouTube did not return a resumable upload session URI.');
  }

  await supabase.from('uploads').upsert(
    {
      user_id: input.userId,
      project_id: input.projectId,
      youtube_account_id: accountRowId,
      upload_session_uri: sessionUri,
      upload_status: 'uploading',
      upload_progress: 5,
      privacy_status: effectivePrivacy,
      scheduled_publish_time: input.scheduledPublishTimeIso || null,
      idempotency_key: input.idempotencyKey,
    },
    { onConflict: 'idempotency_key' }
  );

  // Step 2: Upload in 8MB chunks (multiple of 256KB per YouTube resumable spec) with retry
  const chunkSize = 8 * 1024 * 1024;
  let offset = 0;
  let uploadedVideoId = '';

  while (offset < totalBytes) {
    const end = Math.min(offset + chunkSize, totalBytes);
    const chunk = videoBuffer.subarray(offset, end);
    const rangeHeader = `bytes ${offset}-${end - 1}/${totalBytes}`;

    let chunkResponse: Response | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      chunkResponse = await fetch(sessionUri, {
        method: 'PUT',
        headers: {
          'Content-Length': String(chunk.length),
          'Content-Type': 'video/mp4',
          'Content-Range': rangeHeader,
        },
        body: chunk,
      });

      if (chunkResponse.status === 308 || chunkResponse.ok) {
        break;
      }
      if (chunkResponse.status >= 500 && attempt < 3) {
        await new Promise((r) => setTimeout(r, attempt * 2000));
        continue;
      }
      throw new Error(`YouTube chunk upload failed (HTTP ${chunkResponse.status}).`);
    }

    if (!chunkResponse) {
      throw new Error('YouTube chunk upload received no response.');
    }

    offset = end;
    const progressPct = Math.min(95, Math.round((offset / totalBytes) * 100));
    await input.onProgress?.(progressPct);

    if (chunkResponse.ok) {
      const uploaded = (await chunkResponse.json()) as { id?: string };
      uploadedVideoId = uploaded.id || '';
      break;
    }
  }

  if (!uploadedVideoId) {
    throw new Error('YouTube upload completed without returning a video ID.');
  }

  // Step 3: Upload custom thumbnail if available
  if (input.localThumbnailPath) {
    try {
      const thumbBytes = await fs.readFile(input.localThumbnailPath);
      await fetch(
        `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(
          uploadedVideoId
        )}&uploadType=media`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'image/jpeg',
          },
          body: thumbBytes,
        }
      );
    } catch {
      // Non-fatal: some unverified YouTube channels restrict custom thumbnail API
    }
  }

  const videoUrl = `https://www.youtube.com/watch?v=${uploadedVideoId}`;
  const finalStatus = isScheduled ? 'scheduled' : 'published';

  await supabase
    .from('uploads')
    .update({
      youtube_video_id: uploadedVideoId,
      upload_status: finalStatus,
      upload_progress: 100,
      video_url: videoUrl,
      error_message: null,
    })
    .eq('idempotency_key', input.idempotencyKey);

  return { youtubeVideoId: uploadedVideoId, videoUrl, status: finalStatus, channelName };
}
