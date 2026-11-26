export const VOICEOVER_SCRIPT_START = '<<<VOICEOVER_SCRIPT_START>>>';
export const VOICEOVER_SCRIPT_END = '<<<VOICEOVER_SCRIPT_END>>>';
export const VIDEO_VISUAL_INSTRUCTIONS_START = '<<<VIDEO_VISUAL_INSTRUCTIONS_START>>>';
export const VIDEO_VISUAL_INSTRUCTIONS_END = '<<<VIDEO_VISUAL_INSTRUCTIONS_END>>>';

export interface ParsedScriptSections {
  voiceoverScript: string;
  videoVisualInstructions: string;
  hasExplicitDelimiters: boolean;
}

const VISUAL_BLOCK_REGEX =
  /<<<\s*VIDEO_VISUAL_INSTRUCTIONS_START\s*>>>([\s\S]*?)(?:<<<\s*VIDEO_VISUAL_INSTRUCTIONS_END\s*>>>|(?=<<<\s*VOICEOVER_SCRIPT_START\s*>>>)|$)/gi;

const VOICEOVER_BLOCK_REGEX =
  /<<<\s*VOICEOVER_SCRIPT_START\s*>>>([\s\S]*?)(?:<<<\s*VOICEOVER_SCRIPT_END\s*>>>|(?=<<<\s*VIDEO_VISUAL_INSTRUCTIONS_START\s*>>>)|$)/i;

const FALLBACK_VISUAL_HEADING_REGEX =
  /(?:^|\n)\s*(?:={2,}|-{2,}|#{1,4})?\s*\[?\s*VIDEO\s+VISUAL\s+INSTRUCTIONS\s*\]?\s*(?:={2,}|-{2,})?\s*\n([\s\S]*?)(?=(?:\n\s*(?:={2,}|-{2,}|#{1,4})?\s*\[?\s*VOICEOVER\s+SCRIPT\s*\]?\s*(?:={2,}|-{2,})?\s*(?:\n|$))|$)/gi;

const FALLBACK_VOICEOVER_HEADING_REGEX =
  /(?:^|\n)\s*(?:={2,}|-{2,}|#{1,4})?\s*\[?\s*VOICEOVER\s+SCRIPT\s*\]?\s*(?:={2,}|-{2,})?\s*\n([\s\S]*?)(?=(?:\n\s*(?:={2,}|-{2,}|#{1,4})?\s*\[?\s*VIDEO\s+VISUAL\s+INSTRUCTIONS\s*\]?\s*(?:={2,}|-{2,})?\s*(?:\n|$))|$)/i;

/**
 * Strips delimiter marker tokens while keeping text clean.
 */
function stripDelimiterMarkers(text: string): string {
  return text
    .replace(/<<<\s*(?:VOICEOVER_SCRIPT|VIDEO_VISUAL_INSTRUCTIONS)_(?:START|END)\s*>>>/gi, ' ')
    .trim();
}

/**
 * Parses a script payload into two strictly independent sections using explicit delimiters:
 * 1) `videoVisualInstructions`: <<<VIDEO_VISUAL_INSTRUCTIONS_START>>> ... <<<VIDEO_VISUAL_INSTRUCTIONS_END>>>
 * 2) `voiceoverScript`: <<<VOICEOVER_SCRIPT_START>>> ... <<<VOICEOVER_SCRIPT_END>>>
 *
 * Ensures visual/camera/editing instructions are NEVER mixed into the spoken voiceover text.
 */
export function parseDelimitedScriptSections(rawText: string): ParsedScriptSections {
  if (!rawText || !rawText.trim()) {
    return {
      voiceoverScript: '',
      videoVisualInstructions: '',
      hasExplicitDelimiters: false,
    };
  }

  const normalized = rawText.replace(/\r\n?/g, '\n');

  // 1. Extract all Video Visual Instructions blocks independently
  const visualChunks: string[] = [];
  for (const match of normalized.matchAll(VISUAL_BLOCK_REGEX)) {
    const chunk = stripDelimiterMarkers(match[1] || '');
    if (chunk) visualChunks.push(chunk);
  }

  let hasExplicitDelimiters =
    /<<<\s*(?:VOICEOVER_SCRIPT|VIDEO_VISUAL_INSTRUCTIONS)_START\s*>>>/i.test(normalized);

  if (visualChunks.length === 0) {
    for (const match of normalized.matchAll(FALLBACK_VISUAL_HEADING_REGEX)) {
      const chunk = (match[1] || '').trim();
      if (chunk) {
        visualChunks.push(chunk);
        hasExplicitDelimiters = true;
      }
    }
  }

  // 2. Extract Voiceover Script exclusively from its delimited section when present
  let rawVoiceover = '';
  const voMatch = normalized.match(VOICEOVER_BLOCK_REGEX);
  if (voMatch && voMatch[1]) {
    rawVoiceover = voMatch[1];
    hasExplicitDelimiters = true;
  } else {
    const fallbackVoMatch = normalized.match(FALLBACK_VOICEOVER_HEADING_REGEX);
    if (fallbackVoMatch && fallbackVoMatch[1]) {
      rawVoiceover = fallbackVoMatch[1];
      hasExplicitDelimiters = true;
    } else {
      // Remove any visual instructions blocks completely from the residual text
      rawVoiceover = normalized
        .replace(VISUAL_BLOCK_REGEX, ' ')
        .replace(FALLBACK_VISUAL_HEADING_REGEX, ' ');
    }
  }

  const cleanVoiceover = sanitizeSpokenNarration(stripDelimiterMarkers(rawVoiceover));
  const cleanVisualInstructions = visualChunks.join('\n\n').trim();

  return {
    voiceoverScript: cleanVoiceover,
    videoVisualInstructions: cleanVisualInstructions,
    hasExplicitDelimiters,
  };
}

/**
 * Formats separated visual instructions and pure voiceover script into one clearly
 * delimited production document for inspection/storage in `scripts.script_text`.
 */
export function formatDelimitedScriptDocument(
  voiceoverScript: string,
  videoVisualInstructions: string
): string {
  const cleanVo = sanitizeSpokenNarration(voiceoverScript);
  const cleanVis = stripDelimiterMarkers(videoVisualInstructions || '');
  if (!cleanVis) {
    return `${VOICEOVER_SCRIPT_START}\n${cleanVo}\n${VOICEOVER_SCRIPT_END}`;
  }
  return [
    VIDEO_VISUAL_INSTRUCTIONS_START,
    cleanVis,
    VIDEO_VISUAL_INSTRUCTIONS_END,
    '',
    VOICEOVER_SCRIPT_START,
    cleanVo,
    VOICEOVER_SCRIPT_END,
  ].join('\n');
}

/**
 * Strips all non-spoken production instructions, delimited visual blocks, stage directions,
 * scene headers, camera cues, SFX/music tags, speaker labels, timestamps, and markdown
 * from a script BEFORE it is sent to TTS synthesis or burned into subtitles.
 *
 * Prevents TTS models (especially Gemini TTS) from reading visual/editing cues aloud.
 */
export function sanitizeSpokenNarration(rawText: string): string {
  if (!rawText) return '';

  // First remove any delimited Video Visual Instructions sections completely
  let text = rawText
    .replace(/\r\n?/g, '\n')
    .replace(VISUAL_BLOCK_REGEX, ' ')
    .replace(FALLBACK_VISUAL_HEADING_REGEX, ' ')
    .replace(/<<<\s*(?:VOICEOVER_SCRIPT|VIDEO_VISUAL_INSTRUCTIONS)_(?:START|END)\s*>>>/gi, ' ')
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

    // Skip section heading lines if leftover
    if (/^(?:={2,}|-{2,})?\s*(?:video\s+visual\s+instructions|voiceover\s+script)\s*(?:={2,}|-{2,})?$/i.test(line)) {
      continue;
    }

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
