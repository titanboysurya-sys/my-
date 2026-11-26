/**
 * Strips all non-spoken production instructions, stage directions, scene headers,
 * camera cues, SFX/music tags, speaker labels, timestamps, and markdown from a script
 * BEFORE it is sent to TTS synthesis or burned into subtitles.
 *
 * Prevents TTS models (especially Gemini TTS) from reading visual/editing cues aloud.
 */
export function sanitizeSpokenNarration(rawText: string): string {
  if (!rawText) return '';

  let text = rawText
    // Normalize line endings
    .replace(/\r\n?/g, '\n')
    // Remove fenced code blocks if any leaked
    .replace(/```[\s\S]*?```/g, ' ')
    // Remove bracketed cues: [Visual: ...], [Scene 1], [SFX: whoosh], [Pause], [Cut to ...]
    .replace(/\[[^\]\n]{1,220}\]/g, ' ')
    // Remove curly-brace tags: {camera pan}, {cheerful}
    .replace(/\{[^}\n]{1,160}\}/g, ' ')
    // Remove parenthetical stage/camera/audio/voice cues anywhere in text
    .replace(
      /\([^)\n]{0,180}\b(?:scene|visual|camera|shot|cut|zoom|pan|fade|sfx|sound|music|bgm|pause|beat|laugh|sigh|gasp|whisper|tone|voiceover|narrator|overlay|text|caption|banner|b-roll|broll|transition|footage|clip|flash|boom|whoosh|dramatic|energetic|slow|fast|second|sec|s)\b[^)\n]{0,180}\)/gi,
      ' '
    )
    // Remove asterisk action cues like *camera zooms in* or *sighs*
    .replace(/\*[^*\n]{1,100}\*/g, ' ');

  const cleanedLines: string[] = [];
  for (const rawLine of text.split('\n')) {
    let line = rawLine.trim();
    if (!line) continue;

    // Strip markdown heading/bullet markers
    line = line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^[-*•]\s+/, '')
      .replace(/^\d+\.\s+(?=(?:scene|visual|shot|hook|cta|ending|narrator)\b)/i, '')
      .replace(/\*\*|__/g, '')
      .replace(/`/g, '')
      .trim();

    // Skip entire line if it is purely a production directive (e.g., "Visual: ...", "Camera: ...", "BGM: ...")
    if (
      /^(?:scene\s*\d+|visual(?:\s*cue|\s*description|\s*prompt)?|b-?roll|camera|shot|footage|clip|sfx|sound(?:\s*effect)?|music|bgm|audio\s*cue|transition|overlay|text\s*on\s*screen|note|direction|stage\s*direction|keyword|prompt)\s*[:\-–—]/i.test(
        line
      )
    ) {
      continue;
    }

    // Remove leading timestamps like "00:00 - 00:05:" or "0:03 -"
    line = line.replace(/^\d{1,2}:\d{2}(?:\s*[-–—to]+\s*\d{1,2}:\d{2})?\s*[:\-–—]?\s*/i, '');

    // Remove leading speaker/section labels while preserving the spoken words after the colon
    line = line.replace(
      /^(?:narrator|voice\s*over|voiceover|vo|host|anchor|speaker|hook|re-?hook|twist|body|intro|outro|ending|cta|call\s*to\s*action|script)\s*[:\-–—]\s*/i,
      ''
    );

    line = line.replace(/\s+/g, ' ').trim();
    if (line) {
      cleanedLines.push(line);
    }
  }

  return cleanedLines
    .join(' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
