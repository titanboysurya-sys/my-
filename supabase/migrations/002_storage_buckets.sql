-- ============================================================================
-- AutoTube Studio — Migration 002: Private Storage Buckets & User-Scoped Policies
-- ============================================================================
-- All buckets are private. The Android client receives short-lived signed URLs
-- from the backend API after ownership verification.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  ('source-media', 'source-media', FALSE, 262144000, ARRAY['video/mp4', 'video/webm', 'image/jpeg', 'image/png', 'image/webp']),
  ('voice-audio', 'voice-audio', FALSE, 52428800, ARRAY['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/ogg']),
  ('thumbnails', 'thumbnails', FALSE, 10485760, ARRAY['image/jpeg', 'image/png', 'image/webp']),
  ('rendered-videos', 'rendered-videos', FALSE, 524288000, ARRAY['video/mp4']),
  ('subtitles', 'subtitles', FALSE, 5242880, ARRAY['text/plain', 'application/x-subrip', 'text/vtt']),
  ('music-tracks', 'music-tracks', FALSE, 52428800, ARRAY['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/ogg'])
ON CONFLICT (id) DO NOTHING;

-- Enforce user-folder isolation: objects must be stored under `<user_id>/...`
CREATE POLICY "Users read own bucket files"
  ON storage.objects
  FOR SELECT
  USING (
    bucket_id IN ('source-media', 'voice-audio', 'thumbnails', 'rendered-videos', 'subtitles', 'music-tracks')
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

CREATE POLICY "Users upload own bucket files"
  ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id IN ('source-media', 'voice-audio', 'thumbnails', 'rendered-videos', 'subtitles', 'music-tracks')
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

CREATE POLICY "Users delete own bucket files"
  ON storage.objects
  FOR DELETE
  USING (
    bucket_id IN ('source-media', 'voice-audio', 'thumbnails', 'rendered-videos', 'subtitles', 'music-tracks')
    AND auth.uid()::text = (storage.foldername(name))[1]
  );
