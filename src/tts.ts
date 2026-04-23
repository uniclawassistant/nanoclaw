import { execFileSync } from 'child_process';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export interface TtsResult {
  audio: Buffer;
  cleanText: string;
}

export interface VoiceControl {
  style?: string;
  pace?: string;
  accent?: string;
  profile?: string;
}

interface TtsDirective {
  ttsText: string;
  cleanText: string;
  voice?: VoiceControl;
}

const TTS_TAG_RE = /\[\[tts(?::([\s\S]*?))?\]\]|\[tts\]/i;

// Voice-control vocabulary. Gemini 3.1 Flash TTS accepts natural-language
// persona/pace/accent instructions via a prompt prefix (no dedicated API
// fields) — we map known slugs to prose phrases and prepend them to the text.
// OpenAI fallback ignores these because prepending "Say in a whisper:" would
// be spoken literally by gpt-4o-mini-tts.
const KNOWN_STYLES = new Set([
  'vocal-smile',
  'newscaster',
  'whisper',
  'empathetic',
  'promo-hype',
  'deadpan',
]);
const KNOWN_PACES = new Set(['natural', 'rapid-fire', 'drift', 'staccato']);
const KNOWN_ACCENTS = new Set([
  'american-gen',
  'american-valley',
  'american-south',
  'british-rp',
  'british-brixton',
  'transatlantic',
  'australian',
]);
const KNOWN_KEYS = new Set(['style', 'pace', 'accent', 'profile']);
const KEYWORD_RE = /^([a-z]+)=([a-z0-9_-]+)$/;

const STYLE_PROSE: Record<string, string> = {
  'vocal-smile': 'bright, sunny, and explicitly inviting ("vocal smile")',
  newscaster: 'professional, authoritative broadcast',
  whisper: 'intimate, breathy, close-to-mic whisper',
  empathetic: 'warm, understanding, soft',
  'promo-hype': 'high-energy promo with punchy consonants',
  deadpan: 'flat affect, dry delivery',
};
const PACE_PROSE: Record<string, string> = {
  natural: 'natural conversational pace',
  'rapid-fire': 'fast, energetic pace with no dead air',
  drift: 'slow, liquid pace with long pauses',
  staccato: 'short, clipped sentences with distinct pauses between words',
};
const ACCENT_PROSE: Record<string, string> = {
  'american-gen': 'General American',
  'american-valley': 'Californian Valley',
  'american-south': 'American Southern',
  'british-rp': 'British Received Pronunciation',
  'british-brixton': 'British Brixton',
  transatlantic: 'Transatlantic',
  australian: 'Australian',
};

function parseVoiceControl(segment: string): VoiceControl | null {
  const tokens = segment
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return null;
  const out: VoiceControl = {};
  for (const tok of tokens) {
    const m = tok.match(KEYWORD_RE);
    if (!m || !KNOWN_KEYS.has(m[1])) return null;
    const key = m[1] as keyof VoiceControl;
    const val = m[2];
    if (key === 'style' && !KNOWN_STYLES.has(val)) return null;
    if (key === 'pace' && !KNOWN_PACES.has(val)) return null;
    if (key === 'accent' && !KNOWN_ACCENTS.has(val)) return null;
    out[key] = val;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function splitVoiceAndBody(
  payload: string,
): { voice: VoiceControl | null; body: string } {
  // Look for "tokens:body" where tokens match the keyword shape; bail to
  // legacy (whole payload is text) if any token fails the strict gate.
  const m = payload.match(/^([a-z0-9_,=-]+)\s*:\s*([\s\S]*)$/);
  if (!m) return { voice: null, body: payload.trim() };
  const voice = parseVoiceControl(m[1]);
  if (!voice) return { voice: null, body: payload.trim() };
  return { voice, body: m[2].trim() };
}

function buildDirectivePrefix(voice: VoiceControl): string {
  const parts: string[] = [];
  if (voice.style) parts.push(`in a ${STYLE_PROSE[voice.style]} style`);
  if (voice.pace) parts.push(`with ${PACE_PROSE[voice.pace]}`);
  if (voice.accent)
    parts.push(`using a ${ACCENT_PROSE[voice.accent]} accent`);
  if (voice.profile)
    parts.push(`as a ${voice.profile.replace(/[_-]/g, ' ')} voice`);
  if (parts.length === 0) return '';
  return `Say the following ${parts.join(', ')}:\n\n`;
}

export function extractTtsDirective(text: string): TtsDirective | null {
  const match = text.match(TTS_TAG_RE);
  if (!match) return null;

  const cleanText = text.replace(TTS_TAG_RE, '').trim();
  const payload = match[1]?.trim() ?? '';

  // [[tts]] alone → speak the rest of the message, no voice control
  if (!payload) {
    if (!cleanText) return null;
    return { ttsText: cleanText, cleanText };
  }

  // [[tts:k=v,...: text]] → voice control + text; fall through on mismatch
  const { voice, body } = splitVoiceAndBody(payload);
  if (voice && body) {
    return { ttsText: body, cleanText, voice };
  }

  // [[tts:text]] legacy form — the whole payload is the spoken text
  return { ttsText: payload, cleanText };
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
  voice?: VoiceControl,
): Promise<Buffer> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent?key=${apiKey}`;

  const fullText = voice ? `${buildDirectivePrefix(voice)}${text}` : text;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: fullText }] }],
      generationConfig: {
        response_modalities: ['AUDIO'],
        speech_config: {
          voice_config: {
            prebuilt_voice_config: { voice_name: 'Enceladus' },
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

async function synthesizeOpenAI(
  text: string,
  apiKey: string,
): Promise<Buffer> {
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
  voice?: VoiceControl,
): Promise<Buffer | null> {
  const keys = getKeys();

  if (keys.google) {
    try {
      const audio = await synthesizeGemini(text, keys.google, voice);
      logger.info(
        { provider: 'gemini', chars: text.length, voice: voice ?? null },
        'TTS synthesized',
      );
      return audio;
    } catch (err) {
      logger.warn({ err }, 'Gemini TTS failed, trying OpenAI fallback');
    }
  }

  if (keys.openai) {
    try {
      // OpenAI fallback ignores voice control — prepending a persona
      // directive would be read aloud literally by gpt-4o-mini-tts.
      if (voice) {
        logger.warn(
          { voice },
          'TTS: voice control dropped on OpenAI fallback (unsupported)',
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
