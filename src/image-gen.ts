import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const execFileP = promisify(execFile);

export interface ImageGenResult {
  previewPath: string; // jpeg if conversion succeeded, otherwise the original — this is what ships as photo
  originalPath: string; // full-fidelity source kept for re-send via send_image
}

// Outcome of a generate/edit call. `null` is returned only when there's
// nothing useful to signal back to the agent (e.g. missing API key — a
// config issue, not an agent-visible failure).
export type ImageGenOutcome =
  | ({ ok: true } & ImageGenResult)
  | {
      ok: false;
      // 'moderation'      — OpenAI safety system rejection (code moderation_block).
      // 'generic'         — any other API-level user error (bad param, size, etc).
      // 'transient'       — network/timeout/5xx; agent-side signalling is pointless.
      // 'source_missing'  — pre-flight: edit source file not found / unreadable / empty.
      reason: 'moderation' | 'generic' | 'transient' | 'source_missing';
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

// Dynamic API timeout tuning. Current 180s blanket was too aggressive for
// hd + large + png edits (observed 3072x2304 high-png edit timing out) and
// too generous for low-quality small jobs. Formula scales base seconds by
// pixel count × quality × format × edit factors, then clamps to a sane
// range. Constants live here so the operator can tune from logs.
const TIMEOUT_BASE_S = 60;
const TIMEOUT_PER_MP_S = 40;
const TIMEOUT_FLOOR_S = 120;
const TIMEOUT_CAP_S = 600; // 10 min hard ceiling
const QUALITY_MULT = { low: 1, medium: 2, high: 3.5 } as const;
const PNG_MULT = 1.5;
const EDIT_MULT = 1.2;

function sizeToMegapixels(size: string): number {
  if (size === 'auto') return 1.05; // 1024x1024 baseline
  const m = size.match(/^(\d+)x(\d+)$/);
  if (!m) return 1.05;
  return (parseInt(m[1], 10) * parseInt(m[2], 10)) / 1_000_000;
}

/**
 * Timeout for /v1/images/{generations,edits} scaled by the resolved
 * presets. Returns ms. Exported for tests and for log inspection.
 */
export function computeApiTimeoutMs(
  resolved: ResolvedPresets,
  isEdit: boolean,
): number {
  const mp = sizeToMegapixels(resolved.size);
  const qMult = QUALITY_MULT[resolved.quality];
  const fMult = resolved.output_format === 'png' ? PNG_MULT : 1;
  const eMult = isEdit ? EDIT_MULT : 1;
  const seconds =
    TIMEOUT_BASE_S + TIMEOUT_PER_MP_S * mp * qMult * fMult * eMult;
  const clamped = Math.max(TIMEOUT_FLOOR_S, Math.min(TIMEOUT_CAP_S, seconds));
  return Math.round(clamped) * 1000;
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
 * Lenient: invalid keyword VALUES (e.g. format=tiff, compression=0) warn
 * and are ignored but don't kill the whole directive — other tokens still
 * apply. Last write wins for same-key keyword tokens (e.g.
 * quality=low,quality=high). Conflicting size tokens (multiple sizes
 * specified) fall back to default size with a warning.
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
  const timeoutMs = computeApiTimeoutMs(resolved, /*isEdit=*/ false);

  logger.info(
    {
      size: resolved.size,
      quality: resolved.quality,
      format: resolved.output_format,
      compression: resolved.output_compression,
      isEdit: false,
      timeoutMs,
    },
    'Image gen request starting',
  );

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
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    logger.error(
      { err, promptLen: prompt.length, resolved, timeoutMs },
      'Image gen: fetch failed',
    );
    return { ok: false, reason: 'transient' };
  }

  const requestId = resp.headers.get('x-request-id') ?? undefined;

  if (!resp.ok) {
    const body = await resp.text();
    logger.error(
      { status: resp.status, body: body.slice(0, 300), requestId, timeoutMs },
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
  // keep the PNG as the full-fidelity "original" for re-send via send_image.
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
      requestId,
      timeoutMs,
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

  // Pre-flight source checks. Failures here are the single most common
  // agent-side slip (typo'd path, wrong extension, cached reference to a
  // file that got rotated, etc). The MCP edit_image tool surfaces these
  // back to the agent as { ok: false, error } so it can fix the call.
  const baseName = path.basename(sourcePath);
  if (!fs.existsSync(sourcePath)) {
    logger.error({ sourcePath }, 'Image edit: source file not found');
    return {
      ok: false,
      reason: 'source_missing',
      message: `Source file not found: ${baseName}`,
    };
  }
  let imageBuffer: Buffer;
  try {
    imageBuffer = fs.readFileSync(sourcePath);
  } catch (err) {
    logger.error({ err, sourcePath }, 'Image edit: source file unreadable');
    return {
      ok: false,
      reason: 'source_missing',
      message: `Source file unreadable: ${baseName}`,
    };
  }
  if (imageBuffer.length === 0) {
    logger.error({ sourcePath }, 'Image edit: source file is empty');
    return {
      ok: false,
      reason: 'source_missing',
      message: `Source file is empty: ${baseName}`,
    };
  }

  const resolved = resolvePresets(presets);
  const wantsPng = resolved.output_format === 'png';

  // Tag the input MIME by actual extension so OpenAI parses it correctly —
  // the source may be a JPEG (default output format) or a legacy PNG.
  const sourceExt = path.extname(sourcePath).toLowerCase();
  const sourceMime = sourceExt === '.png' ? 'image/png' : 'image/jpeg';
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

  const timeoutMs = computeApiTimeoutMs(resolved, /*isEdit=*/ true);

  logger.info(
    {
      sourcePath,
      sourceMime,
      sourceBytes: imageBuffer.length,
      size: resolved.size,
      quality: resolved.quality,
      format: resolved.output_format,
      compression: resolved.output_compression,
      isEdit: true,
      timeoutMs,
    },
    'Image edit request starting',
  );

  let resp: Response;
  try {
    resp = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    logger.error(
      { err, sourcePath, resolved, timeoutMs },
      'Image edit: fetch failed',
    );
    return { ok: false, reason: 'transient' };
  }

  const requestId = resp.headers.get('x-request-id') ?? undefined;

  if (!resp.ok) {
    const body = await resp.text();
    logger.error(
      { status: resp.status, body: body.slice(0, 300), requestId, timeoutMs },
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
      requestId,
      timeoutMs,
    },
    'Image edited',
  );
  return { ok: true, previewPath, originalPath };
}
