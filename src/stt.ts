import fs from 'fs';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

// OpenAI /v1/audio/transcriptions caps file size at 25MB. Cut off
// slightly below to leave multipart-encoding headroom.
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

// Telegram voice messages are seconds-to-minutes; 120s is generous for
// gpt-4o-mini-transcribe even on slow uploads.
const TIMEOUT_MS = 120_000;

const STT_MODEL = 'gpt-4o-mini-transcribe';

function getKey(): string | undefined {
  // OPENAI_STT_API_KEY lets ops separate STT billing/usage from TTS;
  // OPENAI_TTS_API_KEY is the existing OpenAI key already provisioned
  // for TTS fallback and image-gen, so it's the natural default.
  const env = readEnvFile(['OPENAI_STT_API_KEY', 'OPENAI_TTS_API_KEY']);
  return (
    process.env.OPENAI_STT_API_KEY ||
    env.OPENAI_STT_API_KEY ||
    process.env.OPENAI_TTS_API_KEY ||
    env.OPENAI_TTS_API_KEY
  );
}

/**
 * Transcribe an audio file (Telegram voice .oga, .ogg, .mp3, .m4a, etc.) via
 * OpenAI /v1/audio/transcriptions. Host-side; the container needs neither
 * ffmpeg nor whisper. The file is uploaded as-is.
 *
 * Returns null on any failure (missing key, missing/empty/oversize file,
 * network/API error, empty transcript) — callers fall back to the bare
 * placeholder so the agent at least sees that audio arrived.
 */
export async function transcribe(localPath: string): Promise<string | null> {
  const apiKey = getKey();
  if (!apiKey) {
    logger.warn(
      'STT: no API key configured (OPENAI_STT_API_KEY / OPENAI_TTS_API_KEY)',
    );
    return null;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(localPath);
  } catch (err) {
    logger.warn({ err, localPath }, 'STT: source file not found');
    return null;
  }

  if (stat.size === 0) {
    logger.warn({ localPath }, 'STT: source file is empty');
    return null;
  }

  if (stat.size > MAX_AUDIO_BYTES) {
    logger.warn(
      { localPath, size: stat.size, max: MAX_AUDIO_BYTES },
      'STT: source file exceeds OpenAI 25MB limit, skipping',
    );
    return null;
  }

  let buf: Buffer;
  try {
    buf = fs.readFileSync(localPath);
  } catch (err) {
    logger.warn({ err, localPath }, 'STT: failed to read source file');
    return null;
  }

  // OpenAI's transcription whitelist accepts `.ogg` but NOT `.oga`, even
  // though Telegram voice messages use the latter and the bytes are
  // identical OGG-Opus. Rename at upload time so the API doesn't 400 with
  // "Unsupported file format oga". On-disk file keeps its original name.
  let uploadName = path.basename(localPath);
  if (uploadName.toLowerCase().endsWith('.oga')) {
    uploadName = uploadName.slice(0, -4) + '.ogg';
  }
  const form = new FormData();
  form.append('file', new Blob([buf]), uploadName);
  form.append('model', STT_MODEL);
  form.append('response_format', 'text');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: ctrl.signal,
    });

    if (!resp.ok) {
      const body = await resp.text();
      logger.error(
        { status: resp.status, body: body.slice(0, 300), localPath },
        'STT: OpenAI transcription failed',
      );
      return null;
    }

    const text = (await resp.text()).trim();
    if (!text) {
      logger.warn({ localPath }, 'STT: empty transcript');
      return null;
    }

    logger.info(
      {
        provider: 'openai',
        model: STT_MODEL,
        bytes: stat.size,
        chars: text.length,
      },
      'STT transcribed',
    );
    return text;
  } catch (err) {
    logger.error({ err, localPath }, 'STT: transcription failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}
