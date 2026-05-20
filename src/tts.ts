import { execFileSync } from 'child_process';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export interface VoiceDirective {
  voice?: string;
  profile?: string;
  scene?: string;
  director?: string;
}

// Gemini Flash TTS voice catalog. Case-sensitive — voices passed via
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

function getGoogleKey(): string | undefined {
  const env = readEnvFile(['GOOGLE_AI_API_KEY']);
  return process.env.GOOGLE_AI_API_KEY || env.GOOGLE_AI_API_KEY;
}

interface GoogleModelEntry {
  name?: string;
  supportedGenerationMethods?: string[];
}

/**
 * Pick the highest-version Flash TTS model name from a `/v1beta/models`
 * listing. Matches names containing both `flash` and `tts` (case-insensitive),
 * parses the `gemini-<major>.<minor>` token, returns the entry with the
 * largest (major, minor). Returns null if no candidate exists.
 *
 * Exported for unit testing — the picker is the only piece of model
 * resolution that needs deterministic fixture coverage.
 */
export function pickLatestFlashTtsModel(
  models: GoogleModelEntry[],
): string | null {
  const ttsRe = /tts/i;
  const flashRe = /flash/i;
  const versionRe = /gemini-(\d+)\.(\d+)/i;

  let best: { name: string; major: number; minor: number } | null = null;
  for (const m of models) {
    const raw = m?.name;
    if (!raw) continue;
    // `name` comes back as `models/<id>` from the listing endpoint;
    // strip the prefix for both matching and what we return.
    const id = raw.startsWith('models/') ? raw.slice('models/'.length) : raw;
    if (!ttsRe.test(id) || !flashRe.test(id)) continue;
    const v = versionRe.exec(id);
    if (!v) continue;
    const major = Number(v[1]);
    const minor = Number(v[2]);
    if (
      !best ||
      major > best.major ||
      (major === best.major && minor > best.minor)
    ) {
      best = { name: id, major, minor };
    }
  }
  return best?.name ?? null;
}

// In-memory cache of the resolved Gemini TTS model name. Resolved on first
// synthesize() call per process; invalidated on 404/400 model-name errors
// so the next call re-probes. Restart resets the cache — that's intentional
// (container rebuild = fresh discovery, no on-disk state).
let cachedModel: string | undefined;

/** Test-only: drop the cached model name so re-resolution probes again. */
export function _resetTtsModelCache(): void {
  cachedModel = undefined;
}

/**
 * Resolve the Gemini Flash TTS model name to use. Order of preference:
 *   1. `GEMINI_TTS_MODEL` env override (emergency pin — skips discovery).
 *   2. In-memory cached value from a prior probe in this process.
 *   3. Live probe of `/v1beta/models` filtered to Flash TTS candidates.
 * Returns null if all three paths fail.
 */
async function resolveModel(apiKey: string): Promise<string | null> {
  const override = process.env.GEMINI_TTS_MODEL;
  if (override) return override;
  if (cachedModel) return cachedModel;

  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
  let resp: Response;
  try {
    resp = await fetch(url);
  } catch (err) {
    logger.error({ err }, 'Gemini TTS: model listing fetch threw');
    return null;
  }
  if (!resp.ok) {
    const body = await resp.text();
    logger.error(
      { status: resp.status, body: body.slice(0, 200) },
      'Gemini TTS: model listing returned non-2xx',
    );
    return null;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = await resp.json();
  const models: GoogleModelEntry[] = Array.isArray(json?.models)
    ? json.models
    : [];
  const picked = pickLatestFlashTtsModel(models);
  if (!picked) {
    logger.error(
      { count: models.length },
      'Gemini TTS: no Flash TTS model found in /v1beta/models listing',
    );
    return null;
  }
  cachedModel = picked;
  logger.info({ model: picked }, 'Gemini TTS: model resolved');
  return picked;
}

function isModelNameError(status: number, body: string): boolean {
  if (status !== 400 && status !== 404) return false;
  return /model|not found|deprecated|unsupported|unavailable/i.test(body);
}

async function synthesizeGemini(
  text: string,
  apiKey: string,
  modelName: string,
  directive?: VoiceDirective,
): Promise<{ audio?: Buffer; status: number; body: string }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

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
    return { status: resp.status, body: body.slice(0, 500) };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = await resp.json();
  const part = json.candidates?.[0]?.content?.parts?.[0];
  if (!part?.inlineData?.data) {
    return { status: resp.status, body: 'no inlineData in response' };
  }

  const pcmBuffer = Buffer.from(part.inlineData.data as string, 'base64');
  return { audio: pcmToOggOpus(pcmBuffer), status: resp.status, body: '' };
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

export async function synthesize(
  text: string,
  directive?: VoiceDirective,
): Promise<Buffer | null> {
  const apiKey = getGoogleKey();
  if (!apiKey) {
    logger.warn('TTS: GOOGLE_AI_API_KEY not configured');
    return null;
  }

  let model = await resolveModel(apiKey);
  if (!model) return null;

  let result;
  try {
    result = await synthesizeGemini(text, apiKey, model, directive);
  } catch (err) {
    logger.error({ err, model }, 'Gemini TTS: synthesis threw');
    return null;
  }

  // Self-heal: if the cached/env model returned a model-name-related
  // failure, drop the cache, re-probe `/v1beta/models` once, retry on the
  // freshly resolved name. Env override is NOT re-probed — if Fedor pinned
  // a name explicitly, honour the pin and surface the failure.
  if (!result.audio && isModelNameError(result.status, result.body)) {
    if (process.env.GEMINI_TTS_MODEL) {
      logger.error(
        { status: result.status, body: result.body, model },
        'Gemini TTS: GEMINI_TTS_MODEL pin returned model-name error; not re-probing (pin honoured)',
      );
      return null;
    }
    logger.warn(
      { status: result.status, body: result.body, model },
      'Gemini TTS: model-name error; invalidating cache and re-probing',
    );
    cachedModel = undefined;
    const fresh = await resolveModel(apiKey);
    if (!fresh) return null;
    if (fresh === model) {
      logger.error(
        { model: fresh },
        'Gemini TTS: re-probe resolved to the same failing model',
      );
      return null;
    }
    model = fresh;
    try {
      result = await synthesizeGemini(text, apiKey, model, directive);
    } catch (err) {
      logger.error({ err, model }, 'Gemini TTS: retry synthesis threw');
      return null;
    }
  }

  if (!result.audio) {
    logger.error(
      { status: result.status, body: result.body, model },
      'Gemini TTS: synthesis failed',
    );
    return null;
  }

  logger.info(
    {
      provider: 'gemini',
      model,
      chars: text.length,
      voice: directive?.voice ?? DEFAULT_VOICE,
      directive: directive ?? null,
    },
    'TTS synthesized',
  );
  return result.audio;
}
