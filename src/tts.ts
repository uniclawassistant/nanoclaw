import { execFileSync } from 'child_process';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export interface VoiceDirective {
  voice?: string;
  profile?: string;
  scene?: string;
  director?: string;
}

export interface TtsDirective {
  ttsText: string;
  cleanText: string;
  directive?: VoiceDirective;
}

// Gemini 3.1 Flash TTS voice catalog. Case-sensitive — a voice slug in a
// tag that doesn't exactly match one of these falls through to director
// prose (voice stays at DEFAULT). Source: memory/tools-reference.md
// "TTS / Gemini Flash — voices catalog".
export const KNOWN_VOICES = new Set([
  'Achernar',
  'Achird',
  'Algenib',
  'Algieba',
  'Alnilam',
  'Aoede',
  'Autonoe',
  'Callirrhoe',
  'Charon',
  'Despina',
  'Enceladus',
  'Erinome',
  'Fenrir',
  'Gacrux',
  'Iapetus',
  'Kore',
  'Laomedeia',
  'Leda',
  'Orus',
  'Puck',
  'Pulcherrima',
  'Rasalgethi',
  'Sadachbia',
  'Sadaltager',
  'Schedar',
  'Sulafat',
  'Umbriel',
  'Vindemiatrix',
  'Zephyr',
  'Zubenelgenubi',
]);

// Per-instance default voice via env. Lets Unic (e.g. Algenib) and Chef
// (default Enceladus) share the codebase while speaking with different
// baseline voices. Resolved once at module init — change requires a
// process restart, which matches how the rest of .env is treated.
function resolveDefaultVoice(): string {
  const env = process.env.TTS_DEFAULT_VOICE;
  if (!env) return 'Enceladus';
  if (KNOWN_VOICES.has(env)) return env;
  logger.warn(
    { env },
    'TTS_DEFAULT_VOICE: unknown voice name, falling back to Enceladus',
  );
  return 'Enceladus';
}
export const DEFAULT_VOICE = resolveDefaultVoice();

// Outer tag matches four shapes via a first-char discriminator:
//   [[tts]]                → baseline, no payload
//   [[tts:text]]           → legacy, payload starts with ':'
//   [[tts(spec): text]]    → simple mode, payload starts with '('
//   [[tts\nkey: val\n...]] → block mode, payload starts with '\n'
// The lookahead [:\n(] keeps malformed tags like "[[ttsfoo]]" from
// matching, so dispatch below doesn't handle an "other" branch.
const TTS_TAG_RE = /\[\[tts(?:([:\n(][\s\S]*?))?\]\]|\[tts\]/i;

const BLOCK_KEY_RE = /^(voice|profile|scene|director):\s+(.+)$/;
const SIMPLE_MODE_RE = /^\(([^)]*)\)\s*:\s*([\s\S]*)$/;

function parseSimpleMode(raw: string, cleanText: string): TtsDirective {
  const m = raw.match(SIMPLE_MODE_RE);
  if (!m) {
    // Payload started with '(' but shape isn't (<spec>): <text>.
    // Whole raw becomes spoken text. e.g. "[[tts(unclosed]]".
    return { ttsText: raw.trim(), cleanText };
  }
  const inner = m[1].trim();
  const text = m[2].trim();
  if (!inner) {
    // Empty parens — malformed, fall through to legacy.
    return { ttsText: raw.trim(), cleanText };
  }
  const tokens = inner
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  let voice: string | undefined;
  const directorTokens: string[] = [];
  for (const tok of tokens) {
    if (!voice && KNOWN_VOICES.has(tok)) {
      voice = tok;
    } else {
      directorTokens.push(tok);
    }
  }
  const directive: VoiceDirective = {};
  if (voice) directive.voice = voice;
  if (directorTokens.length > 0) directive.director = directorTokens.join(', ');
  return {
    ttsText: text,
    cleanText,
    directive: Object.keys(directive).length > 0 ? directive : undefined,
  };
}

function parseBlockMode(body: string, cleanText: string): TtsDirective {
  // body is the payload with the leading '\n' already stripped.
  const lines = body.split('\n');
  const directive: VoiceDirective = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const m = lines[i].match(BLOCK_KEY_RE);
    if (!m) break;
    const key = m[1] as keyof VoiceDirective;
    const val = m[2].trim();
    if (key === 'voice' && !KNOWN_VOICES.has(val)) {
      logger.warn(
        { voice: val },
        'TTS block: unknown voice name, ignoring (voice stays default)',
      );
      continue;
    }
    // last-write-wins for duplicate keys, per brief §Rich mode.
    directive[key] = val;
  }
  const transcript = lines.slice(i).join('\n').trim();
  return {
    ttsText: transcript,
    cleanText,
    directive: Object.keys(directive).length > 0 ? directive : undefined,
  };
}

export function extractTtsDirective(text: string): TtsDirective | null {
  const match = text.match(TTS_TAG_RE);
  if (!match) return null;

  const cleanText = text.replace(TTS_TAG_RE, '').trim();
  const raw = match[1]; // undefined for `[[tts]]` / `[tts]`

  if (!raw) {
    if (!cleanText) return null;
    return { ttsText: cleanText, cleanText };
  }

  if (raw[0] === '(') return parseSimpleMode(raw, cleanText);
  if (raw[0] === '\n') return parseBlockMode(raw.slice(1), cleanText);

  // raw[0] === ':' — legacy form [[tts:text]]
  const payload = raw.slice(1).trim();
  if (!payload) {
    if (!cleanText) return null;
    return { ttsText: cleanText, cleanText };
  }
  return { ttsText: payload, cleanText };
}

/**
 * Compose the natural-language prefix that carries profile/scene/director
 * into the Gemini prompt. Gemini TTS reads these as persona/context/stage
 * directions and applies them to the spoken text that follows.
 */
export function buildPromptPrefix(directive: VoiceDirective): string {
  const parts: string[] = [];
  if (directive.profile) parts.push(`[Audio Profile] ${directive.profile}`);
  if (directive.scene) parts.push(`[Scene] ${directive.scene}`);
  if (directive.director) parts.push(`[Director's Note] ${directive.director}`);
  return parts.length > 0 ? parts.join('\n') + '\n\n' : '';
}

function getKeys(): { openai?: string; google?: string } {
  const env = readEnvFile(['OPENAI_TTS_API_KEY', 'GOOGLE_AI_API_KEY']);
  return {
    openai: process.env.OPENAI_TTS_API_KEY || env.OPENAI_TTS_API_KEY,
    google: process.env.GOOGLE_AI_API_KEY || env.GOOGLE_AI_API_KEY,
  };
}

async function synthesizeGemini(
  text: string,
  apiKey: string,
  directive?: VoiceDirective,
): Promise<Buffer> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent?key=${apiKey}`;

  const prefix = directive ? buildPromptPrefix(directive) : '';
  const fullText = prefix + text;
  const voiceName = directive?.voice ?? DEFAULT_VOICE;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: fullText }] }],
      generationConfig: {
        response_modalities: ['AUDIO'],
        speech_config: {
          voice_config: {
            prebuilt_voice_config: { voice_name: voiceName },
          },
        },
      },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Gemini TTS ${resp.status}: ${body.slice(0, 200)}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = await resp.json();
  const part = json.candidates?.[0]?.content?.parts?.[0];
  if (!part?.inlineData?.data) {
    throw new Error('Gemini TTS: no audio in response');
  }

  const pcmBuffer = Buffer.from(part.inlineData.data as string, 'base64');
  return pcmToOggOpus(pcmBuffer);
}

function pcmToOggOpus(pcm: Buffer): Buffer {
  return Buffer.from(
    execFileSync(
      'ffmpeg',
      [
        '-f',
        's16le',
        '-ar',
        '24000',
        '-ac',
        '1',
        '-i',
        'pipe:0',
        '-c:a',
        'libopus',
        '-b:a',
        '48k',
        '-f',
        'ogg',
        'pipe:1',
      ],
      { input: pcm, maxBuffer: 10 * 1024 * 1024, timeout: 15000 },
    ),
  );
}

async function synthesizeOpenAI(text: string, apiKey: string): Promise<Buffer> {
  const resp = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      input: text,
      voice: 'ash',
      response_format: 'opus',
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`OpenAI TTS ${resp.status}: ${body.slice(0, 200)}`);
  }

  return Buffer.from(await resp.arrayBuffer());
}

export async function synthesize(
  text: string,
  directive?: VoiceDirective,
): Promise<Buffer | null> {
  const keys = getKeys();

  if (keys.google) {
    try {
      const audio = await synthesizeGemini(text, keys.google, directive);
      logger.info(
        {
          provider: 'gemini',
          chars: text.length,
          voice: directive?.voice ?? DEFAULT_VOICE,
          directive: directive ?? null,
        },
        'TTS synthesized',
      );
      return audio;
    } catch (err) {
      logger.warn({ err }, 'Gemini TTS failed, trying OpenAI fallback');
    }
  }

  if (keys.openai) {
    try {
      // OpenAI fallback drops voice control — prepending persona prose
      // would be read aloud by gpt-4o-mini-tts (see tts-v2 brief
      // §OpenAI fallback). Raw text only.
      if (directive) {
        logger.warn(
          { directive },
          'TTS: directive dropped on OpenAI fallback (unsupported)',
        );
      }
      const audio = await synthesizeOpenAI(text, keys.openai);
      logger.info(
        { provider: 'openai', chars: text.length },
        'TTS synthesized',
      );
      return audio;
    } catch (err) {
      logger.error({ err }, 'OpenAI TTS failed');
    }
  }

  if (!keys.google && !keys.openai) {
    logger.warn(
      'TTS: no API keys configured (GOOGLE_AI_API_KEY / OPENAI_TTS_API_KEY)',
    );
  }

  return null;
}
