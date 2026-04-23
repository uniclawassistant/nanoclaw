import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const execFileP = promisify(execFile);

export interface ImageDirective {
  type: 'generate' | 'edit' | 'file';
  prompt: string;
  sourcePath?: string; // For edit: relative path within group dir. For file: relative path to existing image.
  cleanText: string;
  presets?: string[]; // Raw preset tokens before validation, e.g. ['portrait', 'hd']
}

export interface ImageGenResult {
  previewPath: string; // jpeg if conversion succeeded, otherwise the original png — this is what ships as photo
  originalPath: string; // the untouched png file — for [[image-file: ...]] follow-ups
}

// Outcome of a generate/edit call that actually reached the API. `null` is
// still returned for pre-flight failures (no API key, missing source) so
// callers don't have to special-case those.
export type ImageGenOutcome =
  | ({ ok: true } & ImageGenResult)
  | {
      ok: false;
      // 'moderation' — OpenAI safety system rejection (code moderation_block).
      // 'generic'    — any other API-level user error (bad param, size, etc).
      // 'transient'  — network/timeout/5xx; agent-side signalling is pointless.
      reason: 'moderation' | 'generic' | 'transient';
      code?: string;
      message?: string;
    };

// Parse an OpenAI error JSON body for the shape used by /v1/images/*.
// Returns `null` if the body can't be parsed.
function classifyApiError(
  status: number,
  body: string,
): { reason: 'moderation' | 'generic'; code?: string; message?: string } {
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: string; message?: string };
    };
    const code = parsed.error?.code;
    const message = parsed.error?.message;
    if (code === 'moderation_block')
      return { reason: 'moderation', code, message };
    if (status === 400) return { reason: 'generic', code, message };
  } catch {
    // Fallthrough
  }
  return { reason: 'generic', message: body.slice(0, 300) };
}

// [[image: prompt text here]] or [[image:portrait,hd: prompt text here]]
const IMAGE_GEN_RE = /\[\[image:\s*([\s\S]*?)\]\]/i;
// [[image-edit: path | prompt]] or [[image-edit:portrait,hd: path | prompt]]
const IMAGE_EDIT_RE = /\[\[image-edit:\s*([\s\S]*?)\]\]/i;
// [[image-file: path/to/file.png]] — no presets, works on existing files
const IMAGE_FILE_RE = /\[\[image-file:\s*([\s\S]*?)\]\]/i;

// Known preset vocabulary. Kept as the single source of truth — resolvePresets
// validates against this set and logs+ignores unknown tokens. Custom WxH
// size tokens (e.g. "1920x1080") are accepted via CUSTOM_SIZE_RE in
// addition to this set.
export const KNOWN_PRESETS = new Set([
  'portrait',
  'landscape',
  'auto',
  'hd',
  'med',
]);
const SIZE_PRESETS = new Set(['portrait', 'landscape', 'auto']);
// Custom WxH override, e.g. "1920x1080". Bounds are validated in
// resolvePresets against gpt-image-2 constraints (see validateCustomSize).
const CUSTOM_SIZE_RE = /^\d+x\d+$/;

function isPresetToken(p: string): boolean {
  return KNOWN_PRESETS.has(p) || CUSTOM_SIZE_RE.test(p);
}

// gpt-image-2 size constraints (per OpenAI docs):
// - each edge ≤ 3840
// - each edge a multiple of 16
// - aspect ratio max/min ≤ 3
// - total pixels in [655_360, 8_388_608]
function validateCustomSize(w: number, h: number): string | null {
  if (w > 3840 || h > 3840) return 'edge exceeds 3840px';
  if (w % 16 !== 0 || h % 16 !== 0) return 'edge not a multiple of 16';
  if (Math.max(w, h) / Math.min(w, h) > 3) return 'aspect ratio exceeds 3:1';
  const total = w * h;
  if (total < 655_360) return 'total pixels below 655360';
  if (total > 8_388_608) return 'total pixels above 8388608';
  return null;
}

/**
 * If the inner body starts with a comma-separated list of lowercase ASCII
 * tokens followed by a colon, strip it off and return as presets. Otherwise
 * the entire inner is prompt/body and presets are empty.
 *
 * Examples:
 *   "a cat"                     → { presets: [],                body: "a cat" }
 *   "portrait: a cat"           → { presets: ["portrait"],      body: "a cat" }
 *   "portrait,hd: a cat"        → { presets: ["portrait","hd"], body: "a cat" }
 *   "Plot: a graph"             → { presets: [],                body: "Plot: a graph" }  (uppercase → not preset syntax)
 *   "foo bar: text"             → { presets: [],                body: "foo bar: text" } (space → not preset syntax)
 */
function splitPresetsAndBody(inner: string): {
  presets: string[];
  body: string;
} {
  // Match even an empty body after the preset colon, so callers can
  // distinguish "presets present, prompt missing" (→ null directive) from
  // "no preset section at all" (→ body is whole inner).
  const m = inner.match(/^([a-z0-9_,-]+)\s*:\s*([\s\S]*)$/);
  if (!m) return { presets: [], body: inner.trim() };
  const candidates = m[1]
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  // Require EVERY token to be a known preset. Otherwise assume the leading
  // "word:" (e.g. "sunset:", "plan:", "cat:") is actually part of the
  // prompt — safer than silently dropping it under an "unknown preset"
  // warning. Covers the lowercase-word-colon-phrase false positive the
  // uppercase guard doesn't catch. Programmatic callers of resolvePresets
  // still get their warning if they pass unknown tokens directly.
  if (candidates.length === 0 || !candidates.every(isPresetToken)) {
    return { presets: [], body: inner.trim() };
  }
  return { presets: candidates, body: m[2].trim() };
}

export interface ResolvedPresets {
  // Resolved size string ready to send to OpenAI. Named presets map to fixed
  // dimensions; custom WxH tokens pass through verbatim after validation.
  size: string;
  quality: 'low' | 'medium' | 'high';
}

/**
 * Resolve raw preset tokens to OpenAI API params. Unknown tokens log a
 * warning and are ignored. Conflicting size presets fall back to default
 * with a warning. Quality "last wins" among hd/med.
 */
export function resolvePresets(presets: string[] | undefined): ResolvedPresets {
  const out: ResolvedPresets = { size: '1024x1024', quality: 'low' };
  if (!presets || presets.length === 0) return out;

  // Each entry is the final resolved size string (e.g. "1024x1536",
  // "1920x1080", "auto"). Used to detect conflicts across both named and
  // custom size tokens.
  const resolvedSizes: string[] = [];
  const qualityTokens: string[] = [];

  for (const p of presets) {
    if (SIZE_PRESETS.has(p)) {
      if (p === 'portrait') resolvedSizes.push('1024x1536');
      else if (p === 'landscape') resolvedSizes.push('1536x1024');
      else if (p === 'auto') resolvedSizes.push('auto');
    } else if (p === 'hd' || p === 'med') {
      qualityTokens.push(p);
    } else if (CUSTOM_SIZE_RE.test(p)) {
      const [w, h] = p.split('x').map((n) => parseInt(n, 10));
      const reason = validateCustomSize(w, h);
      if (reason) {
        logger.warn(
          { wxh: p, reason },
          'image-gen: custom size out of bounds, ignoring',
        );
        continue;
      }
      resolvedSizes.push(p);
    } else {
      // Parser already enforces that tokens are known; reaching here means a
      // programmatic caller passed something unexpected.
      logger.warn({ preset: p }, 'image-gen: unknown preset, ignoring');
    }
  }

  if (resolvedSizes.length > 1) {
    logger.warn(
      { sizeTokens: resolvedSizes },
      'image-gen: conflicting size presets, falling back to default size',
    );
  } else if (resolvedSizes.length === 1) {
    out.size = resolvedSizes[0];
  }

  // Last quality token wins (explicit per spec)
  for (const q of qualityTokens) {
    if (q === 'hd') out.quality = 'high';
    else if (q === 'med') out.quality = 'medium';
  }

  return out;
}

export function extractImageDirective(text: string): ImageDirective | null {
  const fileMatch = text.match(IMAGE_FILE_RE);
  if (fileMatch) {
    const sourcePath = fileMatch[1].trim();
    if (!sourcePath) return null;
    const cleanText = text.replace(IMAGE_FILE_RE, '').trim();
    return { type: 'file', prompt: '', sourcePath, cleanText };
  }

  const editMatch = text.match(IMAGE_EDIT_RE);
  if (editMatch) {
    const { presets, body } = splitPresetsAndBody(editMatch[1].trim());
    const pipeIdx = body.indexOf('|');
    if (pipeIdx === -1) return null;
    const sourcePath = body.slice(0, pipeIdx).trim();
    const prompt = body.slice(pipeIdx + 1).trim();
    if (!sourcePath || !prompt) return null;
    const cleanText = text.replace(IMAGE_EDIT_RE, '').trim();
    return { type: 'edit', prompt, sourcePath, cleanText, presets };
  }

  const genMatch = text.match(IMAGE_GEN_RE);
  if (genMatch) {
    const { presets, body } = splitPresetsAndBody(genMatch[1].trim());
    if (!body) return null;
    const cleanText = text.replace(IMAGE_GEN_RE, '').trim();
    return { type: 'generate', prompt: body, cleanText, presets };
  }

  return null;
}

function getApiKey(): string | undefined {
  const env = readEnvFile(['OPENAI_TTS_API_KEY']);
  return process.env.OPENAI_TTS_API_KEY || env.OPENAI_TTS_API_KEY;
}

/**
 * Convert PNG → JPEG (q=85) via macOS native sips. Returns the jpeg path on
 * success, null on failure. The png is left untouched on disk.
 */
async function convertToJpegPreview(pngPath: string): Promise<string | null> {
  const jpegPath = pngPath.replace(/\.png$/i, '.jpg');
  try {
    await execFileP('sips', [
      '-s',
      'format',
      'jpeg',
      '-s',
      'formatOptions',
      '85',
      pngPath,
      '--out',
      jpegPath,
    ]);
    fs.statSync(jpegPath); // assert the file exists, throw otherwise
    return jpegPath;
  } catch (err) {
    logger.warn(
      { err, pngPath },
      'sips conversion failed, falling back to PNG',
    );
    return null;
  }
}

export async function generateImage(
  prompt: string,
  attachmentsDir: string,
  presets?: string[],
): Promise<ImageGenOutcome | null> {
  const apiKey = getApiKey();
  if (!apiKey) {
    logger.warn('Image gen: no OPENAI_TTS_API_KEY configured');
    return null;
  }

  const resolved = resolvePresets(presets);

  let resp: Response;
  try {
    const body: Record<string, unknown> = {
      model: 'gpt-image-2',
      prompt,
      n: 1,
      size: resolved.size,
      quality: resolved.quality,
    };

    resp = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (err) {
    logger.error(
      { err, promptLen: prompt.length, resolved },
      'Image gen: fetch failed',
    );
    return { ok: false, reason: 'transient' };
  }

  if (!resp.ok) {
    const body = await resp.text();
    logger.error(
      { status: resp.status, body: body.slice(0, 300) },
      'Image gen failed',
    );
    // 5xx and 429 are transient — don't bother the agent with a signal.
    if (resp.status >= 500 || resp.status === 429) {
      return { ok: false, reason: 'transient' };
    }
    return { ok: false, ...classifyApiError(resp.status, body) };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = await resp.json();
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) {
    logger.error('Image gen: no b64_json in response');
    return { ok: false, reason: 'transient' };
  }

  fs.mkdirSync(attachmentsDir, { recursive: true });
  const filename = `image_${Date.now()}.png`;
  const pngPath = path.join(attachmentsDir, filename);
  const buf = Buffer.from(b64, 'base64');
  fs.writeFileSync(pngPath, buf);

  const jpegPath = await convertToJpegPreview(pngPath);
  const previewPath = jpegPath ?? pngPath;
  const previewBytes = fs.statSync(previewPath).size;

  logger.info(
    {
      pngPath,
      pngBytes: buf.length,
      previewPath,
      previewBytes,
      jpegConverted: jpegPath !== null,
      promptLen: prompt.length,
      resolved,
    },
    'Image generated',
  );
  return { ok: true, previewPath, originalPath: pngPath };
}

export async function editImage(
  sourcePath: string,
  prompt: string,
  attachmentsDir: string,
  presets?: string[],
): Promise<ImageGenOutcome | null> {
  const apiKey = getApiKey();
  if (!apiKey) {
    logger.warn('Image edit: no OPENAI_TTS_API_KEY configured');
    return null;
  }

  if (!fs.existsSync(sourcePath)) {
    logger.error({ sourcePath }, 'Image edit: source file not found');
    return null;
  }

  const resolved = resolvePresets(presets);

  const imageBuffer = fs.readFileSync(sourcePath);
  const imageFile = new File([imageBuffer], path.basename(sourcePath), {
    type: 'image/png',
  });

  const form = new FormData();
  form.append('model', 'gpt-image-2');
  form.append('image[]', imageFile);
  form.append('prompt', prompt);
  form.append('size', resolved.size);
  form.append('quality', resolved.quality);

  let resp: Response;
  try {
    resp = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(180_000),
    });
  } catch (err) {
    logger.error({ err, sourcePath, resolved }, 'Image edit: fetch failed');
    return { ok: false, reason: 'transient' };
  }

  if (!resp.ok) {
    const body = await resp.text();
    logger.error(
      { status: resp.status, body: body.slice(0, 300) },
      'Image edit failed',
    );
    if (resp.status >= 500 || resp.status === 429) {
      return { ok: false, reason: 'transient' };
    }
    return { ok: false, ...classifyApiError(resp.status, body) };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = await resp.json();
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) {
    logger.error('Image edit: no b64_json in response');
    return { ok: false, reason: 'transient' };
  }

  fs.mkdirSync(attachmentsDir, { recursive: true });
  const filename = `image_${Date.now()}.png`;
  const pngPath = path.join(attachmentsDir, filename);
  const buf = Buffer.from(b64, 'base64');
  fs.writeFileSync(pngPath, buf);

  const jpegPath = await convertToJpegPreview(pngPath);
  const previewPath = jpegPath ?? pngPath;
  const previewBytes = fs.statSync(previewPath).size;

  logger.info(
    {
      pngPath,
      pngBytes: buf.length,
      previewPath,
      previewBytes,
      jpegConverted: jpegPath !== null,
      sourcePath,
      promptLen: prompt.length,
      resolved,
    },
    'Image edited',
  );
  return { ok: true, previewPath, originalPath: pngPath };
}
