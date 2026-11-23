-- ============================================================================
-- AutoTube Studio — Migration 003: Add Groq BYOK Provider Support
-- ============================================================================
-- Allows storing dedicated `groq` API credentials alongside `gemini` and
-- `openai_compatible` for high-throughput, 429-resistant script & scene generation.

ALTER TABLE public.api_credentials
  DROP CONSTRAINT IF EXISTS api_credentials_provider_check;

ALTER TABLE public.api_credentials
  ADD CONSTRAINT api_credentials_provider_check
  CHECK (provider IN ('gemini', 'groq', 'openai_compatible', 'elevenlabs', 'pexels', 'pixabay'));
