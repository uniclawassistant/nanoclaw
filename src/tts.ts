import { execFileSync } from 'child_process';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export const GEMINI_TTS_MODEL = 'gemini-3.8-flash-tts';

export interface VoicePart {
  speaker: string;
  voice: string;
  text: string;
  style?: string;
}

export interface VoiceDirective {
  voice?: string;
  style?: string;
  language?: string;
  parts?: VoicePart[];
}

export interface VoiceDirectiveInput {
  voice?: string;
  style?: string;
  language?: string;
  director?: string;
  profile?: string;
  scene?: string;
  parts?: Array<Partial<VoicePart>>;
}

export interface ResolvedVoiceDirective {
  directive?: VoiceDirective;
  warnings: string[];
  error?: string;
}

// Gemini Flash TTS prebuilt voice catalog. Case-sensitive — voices passed via
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

const BCP47 = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const MAX_SPEAKERS = 2;

/**
 * Turn MCP-tool input into a VoiceDirective for Gemini 3.8 TTS.
 *
 * 3.8 speaks the text field verbatim, so persona/scene/director prose is never
 * prepended to the transcript. `director` becomes the turn-level `style`
 * (speechMetadata.style) unless an explicit `style` is given; `profile` and
 * `scene` have no per-request field and are dropped with a warning.
 */
export function buildVoiceDirective(
  input: VoiceDirectiveInput,
): ResolvedVoiceDirective {
  const warnings: string[] = [];
  const directive: VoiceDirective = {};

  if (input.voice) {
    if (KNOWN_VOICES.has(input.voice)) {
      directive.voice = input.voice;
    } else {
      warnings.push(
        `unknown voice "${input.voice}" ignored, using ${DEFAULT_VOICE}`,
      );
    }
  }

  const style = input.style?.trim();
  const director = input.director?.trim();
  if (style) {
    directive.style = style;
    if (director) {
      warnings.push('director ignored: explicit style takes precedence');
    }
  } else if (director) {
    directive.style = director;
  }
  if (input.profile?.trim()) {
    warnings.push(
      'profile ignored: Gemini 3.8 reads prompt prose aloud; pick a voice and a short style instead',
    );
  }
  if (input.scene?.trim()) {
    warnings.push(
      'scene ignored: Gemini 3.8 reads prompt prose aloud; pick a voice and a short style instead',
    );
  }

  const language = input.language?.trim();
  if (language) {
    if (BCP47.test(language)) {
      directive.language = language;
    } else {
      warnings.push(`language "${language}" is not BCP-47, ignored`);
    }
  }

  if (input.parts !== undefined) {
    const parsed = parseParts(input.parts);
    if ('error' in parsed) return { warnings, error: parsed.error };
    directive.parts = parsed.parts;
    if (directive.voice) {
      warnings.push('voice ignored: each part carries its own voice');
      delete directive.voice;
    }
    if (directive.style) {
      warnings.push('style ignored: set style per part');
      delete directive.style;
    }
  }

  for (const warning of warnings) logger.warn({ warning }, 'send_voice');
  return {
    directive: Object.keys(directive).length > 0 ? directive : undefined,
    warnings,
  };
}

function parseParts(
  raw: Array<Partial<VoicePart>>,
): { parts: VoicePart[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'parts must be a non-empty array' };
  }
  const voiceBySpeaker = new Map<string, string>();
  const parts: VoicePart[] = [];
  for (const [index, part] of raw.entries()) {
    const speaker = part.speaker?.trim();
    const text = part.text?.trim();
    const voice = part.voice?.trim();
    if (!speaker) return { error: `parts[${index}].speaker is required` };
    if (!text) return { error: `parts[${index}].text is required` };
    const known = voiceBySpeaker.get(speaker);
    if (voice && !KNOWN_VOICES.has(voice)) {
      return { error: `parts[${index}].voice "${voice}" is not a known voice` };
    }
    if (known && voice && voice !== known) {
      return {
        error: `parts[${index}]: speaker "${speaker}" already uses voice ${known}`,
      };
    }
    const resolvedVoice = voice ?? known;
    if (!resolvedVoice) {
      return { error: `parts[${index}].voice is required for a new speaker` };
    }
    voiceBySpeaker.set(speaker, resolvedVoice);
    const style = part.style?.trim();
    parts.push({
      speaker,
      voice: resolvedVoice,
      text,
      ...(style ? { style } : {}),
    });
  }
  if (voiceBySpeaker.size > MAX_SPEAKERS) {
    return { error: `parts support at most ${MAX_SPEAKERS} speakers` };
  }
  return { parts };
}

/**
 * Build the generateContent request body. camelCase is the canonical REST
 * JSON form. One speaker uses voiceConfig; two speakers use
 * multiSpeakerVoiceConfig, and every part names its speaker.
 */
export function buildGeminiRequest(
  text: string,
  directive?: VoiceDirective,
): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const speechConfig: Record<string, any> = {};
  if (directive?.language) speechConfig.languageCode = directive.language;

  let contentParts: Array<Record<string, unknown>>;
  const parts = directive?.parts;
  const speakers = parts ? [...new Set(parts.map((p) => p.speaker))] : [];

  if (parts && speakers.length > 1) {
    contentParts = parts.map((p) => ({
      text: p.text,
      speechMetadata: {
        speaker: p.speaker,
        ...(p.style ? { style: p.style } : {}),
      },
    }));
    speechConfig.multiSpeakerVoiceConfig = {
      speakerVoiceConfigs: speakers.map((speaker) => ({
        speaker,
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: parts.find((p) => p.speaker === speaker)!.voice,
          },
        },
      })),
    };
  } else if (parts) {
    contentParts = parts.map((p) => ({
      text: p.text,
      ...(p.style ? { speechMetadata: { style: p.style } } : {}),
    }));
    speechConfig.voiceConfig = {
      prebuiltVoiceConfig: { voiceName: parts[0].voice },
    };
  } else {
    contentParts = [
      {
        text,
        ...(directive?.style
          ? { speechMetadata: { style: directive.style } }
          : {}),
      },
    ];
    speechConfig.voiceConfig = {
      prebuiltVoiceConfig: { voiceName: directive?.voice ?? DEFAULT_VOICE },
    };
  }

  return {
    contents: [{ role: 'user', parts: contentParts }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig },
  };
}

export interface DecodedAudio {
  pcm: Buffer;
  sampleRate: number;
  channels: number;
}

/**
 * Normalize Gemini inline audio to raw s16le PCM. 3.1 returned headerless PCM
 * (`audio/L16;codec=pcm;rate=24000`); 3.8 returns `audio/wav`. A RIFF header
 * is detected by content as well as by mime type, so it is never fed to the
 * s16le encoder as samples.
 */
export function decodeGeminiAudio(
  data: Buffer,
  mimeType?: string,
): DecodedAudio {
  const isRiff =
    data.length >= 12 &&
    data.toString('latin1', 0, 4) === 'RIFF' &&
    data.toString('latin1', 8, 12) === 'WAVE';
  if (isRiff) return parseWav(data);
  if (mimeType && /wav/i.test(mimeType)) {
    throw new Error(`Gemini TTS: ${mimeType} without a RIFF/WAVE header`);
  }
  const rate = mimeType?.match(/rate=(\d+)/i)?.[1];
  return { pcm: data, sampleRate: rate ? Number(rate) : 24000, channels: 1 };
}

function parseWav(data: Buffer): DecodedAudio {
  let offset = 12;
  let format: {
    channels: number;
    sampleRate: number;
    bits: number;
    tag: number;
  } | null = null;
  while (offset + 8 <= data.length) {
    const id = data.toString('latin1', offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > data.length) {
        throw new Error('Gemini TTS: truncated WAV fmt chunk');
      }
      format = {
        tag: data.readUInt16LE(body),
        channels: data.readUInt16LE(body + 2),
        sampleRate: data.readUInt32LE(body + 4),
        bits: data.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!format) throw new Error('Gemini TTS: WAV data before fmt chunk');
      if (format.tag !== 1 || format.bits !== 16) {
        throw new Error(
          `Gemini TTS: unsupported WAV format tag=${format.tag} bits=${format.bits}`,
        );
      }
      const end =
        size === 0xffffffff || body + size > data.length
          ? data.length
          : body + size;
      return {
        pcm: data.subarray(body, end),
        sampleRate: format.sampleRate,
        channels: format.channels,
      };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('Gemini TTS: WAV without data chunk');
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
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TTS_MODEL}:generateContent`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(buildGeminiRequest(text, directive)),
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

  const decoded = decodeGeminiAudio(
    Buffer.from(part.inlineData.data as string, 'base64'),
    part.inlineData.mimeType,
  );
  return pcmToOggOpus(decoded);
}

/**
 * Remove Gemini 3.8 inline markup that other engines would read aloud:
 * angle-bracket vocal tags and |pipe| listener reactions.
 */
export function stripInlineMarkup(text: string): string {
  return text
    .replace(/<[^<>]*>/g, ' ')
    .replace(/\|[^|\n]*\|/g, ' ')
    .replace(/\s+([.,!?;:…])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function pcmToOggOpus({ pcm, sampleRate, channels }: DecodedAudio): Buffer {
  return Buffer.from(
    execFileSync(
      'ffmpeg',
      [
        '-f',
        's16le',
        '-ar',
        String(sampleRate),
        '-ac',
        String(channels),
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
      if (directive?.parts) throw err;
      logger.warn({ err }, 'Gemini TTS failed, trying OpenAI fallback');
    }
  }

  if (directive?.parts) {
    logger.warn('TTS: multi-part speech needs GOOGLE_AI_API_KEY');
    return null;
  }

  if (keys.openai) {
    try {
      // OpenAI fallback drops voice control: style/language/voice are not
      // mapped onto gpt-4o-mini-tts. Raw text only.
      if (directive) {
        logger.warn(
          { directive },
          'TTS: directive dropped on OpenAI fallback (unsupported)',
        );
      }
      const audio = await synthesizeOpenAI(
        stripInlineMarkup(text),
        keys.openai,
      );
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
