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

// [[image: prompt text here]] or [[image:portrait,hd: prompt text here]]
const IMAGE_GEN_RE = /\[\[image:\s*([\s\S]*?)\]\]/i;
// [[image-edit: path | prompt]] or [[image-edit:portrait,hd: path | prompt]]
const IMAGE_EDIT_RE = /\[\[image-edit:\s*([\s\S]*?)\]\]/i;
// [[image-file: path/to/file.png]] — no presets, works on existing files
const IMAGE_FILE_RE = /\[\[image-file:\s*([\s\S]*?)\]\]/i;

// Known preset vocabulary. Kept as the single source of truth — resolvePresets
// validates against this set and logs+ignores unknown tokens.
export const KNOWN_PRESETS = new Set([
  'portrait',
  'landscape',
  'auto',
  'hd',
  'med',
  'transparent',
]);
const SIZE_PRESETS = new Set(['portrait', 'landscape', 'auto']);

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
  if (
    candidates.length === 0 ||
    !candidates.every((p) => KNOWN_PRESETS.has(p))
  ) {
    return { presets: [], body: inner.trim() };
  }
  return { presets: candidates, body: m[2].trim() };
}

export interface ResolvedPresets {
  size: '1024x1024' | '1024x1536' | '1536x1024' | 'auto';
  quality: 'low' | 'medium' | 'high';
  background?: 'transparent';
  output_format?: 'png';
}

/**
 * Resolve raw preset tokens to OpenAI API params. Unknown tokens log a
 * warning and are ignored. Conflicting size presets fall back to default
 * with a warning. Quality "last wins" among hd/med.
 */
export function resolvePresets(presets: string[] | undefined): ResolvedPresets {
  const out: ResolvedPresets = { size: '1024x1024', quality: 'low' };
  if (!presets || presets.length === 0) return out;

  const sizeTokens: string[] = [];
  const qualityTokens: string[] = [];
  let transparent = false;

  for (const p of presets) {
    if (!KNOWN_PRESETS.has(p)) {
      logger.warn({ preset: p }, 'image-gen: unknown preset, ignoring');
      continue;
    }
    if (SIZE_PRESETS.has(p)) sizeTokens.push(p);
    else if (p === 'hd' || p === 'med') qualityTokens.push(p);
    else if (p === 'transparent') transparent = true;
  }

  if (sizeTokens.length > 1) {
    logger.warn(
      { sizeTokens },
      'image-gen: conflicting size presets, falling back to default size',
    );
  } else if (sizeTokens.length === 1) {
    const s = sizeTokens[0];
    if (s === 'portrait') out.size = '1024x1536';
    else if (s === 'landscape') out.size = '1536x1024';
    else if (s === 'auto') out.size = 'auto';
  }

  // Last quality token wins (explicit per spec)
  for (const q of qualityTokens) {
    if (q === 'hd') out.quality = 'high';
    else if (q === 'med') out.quality = 'medium';
  }

  if (transparent) {
    out.background = 'transparent';
    out.output_format = 'png';
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
): Promise<ImageGenResult | null> {
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
    if (resolved.background) body.background = resolved.background;
    if (resolved.output_format) body.output_format = resolved.output_format;

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
    return null;
  }

  if (!resp.ok) {
    const body = await resp.text();
    logger.error(
      { status: resp.status, body: body.slice(0, 300) },
      'Image gen failed',
    );
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = await resp.json();
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) {
    logger.error('Image gen: no b64_json in response');
    return null;
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
  return { previewPath, originalPath: pngPath };
}

export async function editImage(
  sourcePath: string,
  prompt: string,
  attachmentsDir: string,
  presets?: string[],
): Promise<ImageGenResult | null> {
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
  if (resolved.background) form.append('background', resolved.background);
  if (resolved.output_format)
    form.append('output_format', resolved.output_format);

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
    return null;
  }

  if (!resp.ok) {
    const body = await resp.text();
    logger.error(
      { status: resp.status, body: body.slice(0, 300) },
      'Image edit failed',
    );
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = await resp.json();
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) {
    logger.error('Image edit: no b64_json in response');
    return null;
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
  return { previewPath, originalPath: pngPath };
}
