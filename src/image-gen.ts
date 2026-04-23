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

// Named size vocabulary. All other parameters (quality, format, compression)
// are expressed via explicit key=value tokens (see KNOWN_KEYWORDS below) —
// we deliberately avoid quality/format shortcut presets so the agent has to
// think about what it actually needs per task instead of picking from a menu.
export const KNOWN_PRESETS = new Set([
  'portrait',
  'landscape',
  'square',
  'auto',
]);
const SIZE_PRESETS = KNOWN_PRESETS;

// Custom WxH override, e.g. "1920x1088". Bounds are validated in
// resolvePresets against gpt-image-2 constraints (see validateCustomSize).
const CUSTOM_SIZE_RE = /^\d+x\d+$/;

// Explicit key=value parameter syntax. Each known key has a validator for
// the value that can warn-and-ignore without killing the whole directive.
const KNOWN_KEYWORDS = new Set(['format', 'quality', 'compression', 'size']);
const KEYWORD_RE = /^([a-z]+)=([a-z0-9x]+)$/;

function isPresetToken(p: string): boolean {
  if (KNOWN_PRESETS.has(p)) return true;
  if (CUSTOM_SIZE_RE.test(p)) return true;
  const kw = p.match(KEYWORD_RE);
  // Only accept a key=value token if the key is one we know — keeps natural
  // prompts like "[[image: author=Fedor: biography]]" intact (author isn't
  // a known keyword so the whole inner falls through as prompt).
  return kw !== null && KNOWN_KEYWORDS.has(kw[1]);
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
 * tokens (named size, custom WxH, or key=value pair with a known key) followed
 * by a colon, strip it off and return as presets. Otherwise the entire inner
 * is prompt/body and presets are empty.
 *
 * Examples:
 *   "a cat"                              → { presets: [],                       body: "a cat" }
 *   "portrait: a cat"                    → { presets: ["portrait"],             body: "a cat" }
 *   "portrait,quality=high: a cat"       → { presets: ["portrait","quality=high"], body: "a cat" }
 *   "format=png,size=1536x1024: prompt"  → { presets: ["format=png","size=1536x1024"], body: "prompt" }
 *   "Plot: a graph"                      → { presets: [],                       body: "Plot: a graph" } (uppercase → not preset syntax)
 *   "author=Fedor: bio"                  → { presets: [],                       body: "author=Fedor: bio" } (unknown key → not preset syntax)
 *   "foo bar: text"                      → { presets: [],                       body: "foo bar: text" } (space → not preset syntax)
 */
function splitPresetsAndBody(inner: string): {
  presets: string[];
  body: string;
} {
  // Character class covers named presets (letters), custom WxH (digits + x),
  // underscores/hyphens (none used today but safe), and "=" for keyword form.
  const m = inner.match(/^([a-z0-9_,=-]+)\s*:\s*([\s\S]*)$/);
  if (!m) return { presets: [], body: inner.trim() };
  const candidates = m[1]
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  // Strict: every token must be shape-valid (known preset / custom WxH /
  // key=value with known key). If any is off, treat the whole inner as a
  // prompt — protects natural text like "sunset: golden hour" or
  // "author=Fedor: biography" from silent loss. resolvePresets still warns
  // on SEMANTIC problems (bad size bounds, bad format value, png+compression).
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
  // Output format sent to the API. Default 'jpeg' lets OpenAI return a
  // JPEG directly at output_compression quality, skipping local sips.
  // 'png' opts into the legacy PNG-plus-sips-preview path for lossless
  // cases. 'webp' also supported.
  output_format: 'jpeg' | 'png' | 'webp';
  // Only applies to jpeg/webp (PNG ignores it). 1..100, defaults to 85.
  output_compression?: number;
}

const NAMED_SIZE_MAP: Record<string, string> = {
  portrait: '1024x1536',
  landscape: '1536x1024',
  square: '1024x1024',
  auto: 'auto',
};

/**
 * Resolve raw preset tokens to OpenAI API params.
 *
 * Strict at the parser level (splitPresetsAndBody), lenient here: invalid
 * keyword VALUES (e.g. format=tiff, compression=0) warn and are ignored
 * but don't kill the whole directive — other tokens still apply. Last
 * write wins for same-key keyword tokens (e.g. quality=low,quality=high).
 * Conflicting size tokens (multiple sizes specified) fall back to default
 * size with a warning.
 */
export function resolvePresets(presets: string[] | undefined): ResolvedPresets {
  const out: ResolvedPresets = {
    size: '1024x1024',
    quality: 'medium',
    output_format: 'jpeg',
    output_compression: 85,
  };
  if (!presets || presets.length === 0) return out;

  // Each entry is the final resolved size string (e.g. "1024x1536",
  // "1920x1080", "auto"). Used to detect conflicts across both named and
  // custom size tokens plus size=WxH keyword.
  const resolvedSizes: string[] = [];
  // Track whether user explicitly set compression to distinguish default
  // from explicit in the png+compression conflict warning.
  let compressionSetExplicitly = false;

  for (const p of presets) {
    if (SIZE_PRESETS.has(p)) {
      resolvedSizes.push(NAMED_SIZE_MAP[p]);
      continue;
    }
    if (CUSTOM_SIZE_RE.test(p)) {
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
      continue;
    }
    const kw = p.match(KEYWORD_RE);
    if (kw && KNOWN_KEYWORDS.has(kw[1])) {
      const [, key, value] = kw;
      if (key === 'format') {
        if (value === 'jpeg' || value === 'png' || value === 'webp') {
          out.output_format = value;
        } else {
          logger.warn(
            { key, value },
            'image-gen: unknown format value, ignoring',
          );
        }
      } else if (key === 'quality') {
        if (value === 'low' || value === 'medium' || value === 'high') {
          out.quality = value;
        } else {
          logger.warn(
            { key, value },
            'image-gen: unknown quality value, ignoring',
          );
        }
      } else if (key === 'compression') {
        const n = parseInt(value, 10);
        if (Number.isFinite(n) && n >= 1 && n <= 100) {
          out.output_compression = n;
          compressionSetExplicitly = true;
        } else {
          logger.warn(
            { key, value },
            'image-gen: compression must be an integer in 1..100, ignoring',
          );
        }
      } else if (key === 'size') {
        if (CUSTOM_SIZE_RE.test(value)) {
          const [w, h] = value.split('x').map((n) => parseInt(n, 10));
          const reason = validateCustomSize(w, h);
          if (reason) {
            logger.warn(
              { key, value, reason },
              'image-gen: size= out of bounds, ignoring',
            );
          } else {
            resolvedSizes.push(value);
          }
        } else if (NAMED_SIZE_MAP[value]) {
          resolvedSizes.push(NAMED_SIZE_MAP[value]);
        } else {
          logger.warn(
            { key, value },
            'image-gen: unknown size value, ignoring',
          );
        }
      }
      continue;
    }
    // Shape-valid token that didn't match any category — shouldn't happen
    // once the parser gate is in place, but log it defensively.
    logger.warn({ preset: p }, 'image-gen: unhandled preset token, ignoring');
  }

  if (resolvedSizes.length > 1) {
    logger.warn(
      { sizeTokens: resolvedSizes },
      'image-gen: conflicting size presets, falling back to default size',
    );
  } else if (resolvedSizes.length === 1) {
    out.size = resolvedSizes[0];
  }

  // PNG doesn't use output_compression. If the user set it explicitly,
  // warn that it's being dropped; otherwise just strip the default silently.
  if (out.output_format === 'png') {
    if (compressionSetExplicitly) {
      logger.warn(
        { compression: out.output_compression },
        'image-gen: compression has no effect with format=png, ignoring',
      );
    }
    delete out.output_compression;
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
  const wantsPng = resolved.output_format === 'png';

  let resp: Response;
  try {
    const body: Record<string, unknown> = {
      model: 'gpt-image-2',
      prompt,
      n: 1,
      size: resolved.size,
      quality: resolved.quality,
      output_format: resolved.output_format,
    };
    // output_compression only applies to jpeg/webp; resolvePresets guarantees
    // it's already stripped for png.
    if (resolved.output_compression !== undefined) {
      body.output_compression = resolved.output_compression;
    }

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
  const ext = extensionForFormat(resolved.output_format);
  const filename = `image_${Date.now()}.${ext}`;
  const imagePath = path.join(attachmentsDir, filename);
  const buf = Buffer.from(b64, 'base64');
  fs.writeFileSync(imagePath, buf);

  // For PNG mode: convert to a JPEG preview so the photo upload stays small,
  // keep the PNG as "original" for [[image-file:...]] re-sends.
  // For JPEG/WebP: the API-returned file is compact enough to ship directly —
  // preview and "original" are the same path.
  let previewPath: string;
  let originalPath: string;
  if (wantsPng) {
    const jpegPath = await convertToJpegPreview(imagePath);
    previewPath = jpegPath ?? imagePath;
    originalPath = imagePath;
  } else {
    previewPath = imagePath;
    originalPath = imagePath;
  }
  const previewBytes = fs.statSync(previewPath).size;

  logger.info(
    {
      imagePath,
      imageBytes: buf.length,
      previewPath,
      previewBytes,
      promptLen: prompt.length,
      resolved,
    },
    'Image generated',
  );
  return { ok: true, previewPath, originalPath };
}

function extensionForFormat(fmt: ResolvedPresets['output_format']): string {
  if (fmt === 'png') return 'png';
  if (fmt === 'webp') return 'webp';
  return 'jpg';
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
  const wantsPng = resolved.output_format === 'png';

  // Tag the input MIME by actual extension so OpenAI parses it correctly —
  // the source may be a JPEG (default output format) or a legacy PNG.
  const sourceExt = path.extname(sourcePath).toLowerCase();
  const sourceMime = sourceExt === '.png' ? 'image/png' : 'image/jpeg';
  const imageBuffer = fs.readFileSync(sourcePath);
  const imageFile = new File([imageBuffer], path.basename(sourcePath), {
    type: sourceMime,
  });

  const form = new FormData();
  form.append('model', 'gpt-image-2');
  form.append('image[]', imageFile);
  form.append('prompt', prompt);
  form.append('size', resolved.size);
  form.append('quality', resolved.quality);
  form.append('output_format', resolved.output_format);
  if (resolved.output_compression !== undefined) {
    form.append('output_compression', String(resolved.output_compression));
  }

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
  const ext = extensionForFormat(resolved.output_format);
  const filename = `image_${Date.now()}.${ext}`;
  const imagePath = path.join(attachmentsDir, filename);
  const buf = Buffer.from(b64, 'base64');
  fs.writeFileSync(imagePath, buf);

  let previewPath: string;
  let originalPath: string;
  if (wantsPng) {
    const jpegPath = await convertToJpegPreview(imagePath);
    previewPath = jpegPath ?? imagePath;
    originalPath = imagePath;
  } else {
    previewPath = imagePath;
    originalPath = imagePath;
  }
  const previewBytes = fs.statSync(previewPath).size;

  logger.info(
    {
      imagePath,
      imageBytes: buf.length,
      previewPath,
      previewBytes,
      wantsPng,
      sourcePath,
      sourceMime,
      promptLen: prompt.length,
      resolved,
    },
    'Image edited',
  );
  return { ok: true, previewPath, originalPath };
}
