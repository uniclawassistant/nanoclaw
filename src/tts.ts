import { execFileSync } from 'child_process';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export interface VoiceDirective {
  voice?: string;
  profile?: string;
  scene?: string;
  director?: string;
}

// Gemini 3.1 Flash TTS voice catalog. Case-sensitive — voices passed via
// send_voice that don't exactly match one of these are ignored (voice stays
// at DEFAULT) with a warn log. Source: memory/tools-reference.md
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

/**
 * Build a clean VoiceDirective from MCP-tool input. Validates the voice
 * against KNOWN_VOICES (warn-and-ignore unknowns, voice stays default).
 * Returns undefined when nothing was specified so callers can pass through
 * directly to synthesize().
 */
export function buildVoiceDirective(input: {
  voice?: string;
  director?: string;
  profile?: string;
  scene?: string;
}): VoiceDirective | undefined {
  const directive: VoiceDirective = {};
  if (input.voice) {
    if (KNOWN_VOICES.has(input.voice)) {
      directive.voice = input.voice;
    } else {
      logger.warn(
        { voice: input.voice },
        'send_voice: unknown voice name, ignoring (voice stays default)',
      );
    }
  }
  if (input.director) directive.director = input.director;
  if (input.profile) directive.profile = input.profile;
  if (input.scene) directive.scene = input.scene;
  return Object.keys(directive).length > 0 ? directive : undefined;
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
