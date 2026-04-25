import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { transcribe } from './stt.js';

describe('transcribe', () => {
  const origStt = process.env.OPENAI_STT_API_KEY;
  const origTts = process.env.OPENAI_TTS_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENAI_STT_API_KEY;
    delete process.env.OPENAI_TTS_API_KEY;
  });

  afterEach(() => {
    if (origStt === undefined) delete process.env.OPENAI_STT_API_KEY;
    else process.env.OPENAI_STT_API_KEY = origStt;
    if (origTts === undefined) delete process.env.OPENAI_TTS_API_KEY;
    else process.env.OPENAI_TTS_API_KEY = origTts;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns null when no API key configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const out = await transcribe('/tmp/voice.oga');

    expect(out).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when source file missing', async () => {
    process.env.OPENAI_TTS_API_KEY = 'k';
    vi.spyOn(fs, 'statSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const out = await transcribe('/tmp/missing.oga');

    expect(out).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when source file is empty', async () => {
    process.env.OPENAI_TTS_API_KEY = 'k';
    vi.spyOn(fs, 'statSync').mockReturnValue({ size: 0 } as fs.Stats);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const out = await transcribe('/tmp/empty.oga');

    expect(out).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when file exceeds the 25MB cap', async () => {
    process.env.OPENAI_TTS_API_KEY = 'k';
    vi.spyOn(fs, 'statSync').mockReturnValue({
      size: 30 * 1024 * 1024,
    } as fs.Stats);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const out = await transcribe('/tmp/big.oga');

    expect(out).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the transcript on success', async () => {
    process.env.OPENAI_TTS_API_KEY = 'k';
    vi.spyOn(fs, 'statSync').mockReturnValue({ size: 1234 } as fs.Stats);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('audio-bytes'));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue('Привет, как дела?'),
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await transcribe('/tmp/v.oga');

    expect(out).toBe('Привет, как дела?');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/audio/transcriptions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer k',
        }),
      }),
    );
  });

  it('trims whitespace and treats empty transcripts as null', async () => {
    process.env.OPENAI_TTS_API_KEY = 'k';
    vi.spyOn(fs, 'statSync').mockReturnValue({ size: 100 } as fs.Stats);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('x'));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: vi.fn().mockResolvedValue('   \n\n   '),
      }),
    );

    const out = await transcribe('/tmp/v.oga');

    expect(out).toBeNull();
  });

  it('returns null on non-200 response', async () => {
    process.env.OPENAI_TTS_API_KEY = 'k';
    vi.spyOn(fs, 'statSync').mockReturnValue({ size: 100 } as fs.Stats);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('x'));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: vi.fn().mockResolvedValue('bad request'),
      }),
    );

    const out = await transcribe('/tmp/v.oga');

    expect(out).toBeNull();
  });

  it('returns null on fetch rejection', async () => {
    process.env.OPENAI_TTS_API_KEY = 'k';
    vi.spyOn(fs, 'statSync').mockReturnValue({ size: 100 } as fs.Stats);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('x'));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));

    const out = await transcribe('/tmp/v.oga');

    expect(out).toBeNull();
  });

  it('renames .oga uploads to .ogg (OpenAI whitelist quirk)', async () => {
    process.env.OPENAI_TTS_API_KEY = 'k';
    vi.spyOn(fs, 'statSync').mockReturnValue({ size: 100 } as fs.Stats);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('x'));

    let capturedName: string | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const form = init.body as FormData;
        const file = form.get('file') as File;
        capturedName = file?.name;
        return {
          ok: true,
          text: vi.fn().mockResolvedValue('hi'),
        };
      }),
    );

    await transcribe('/tmp/voice_42.oga');

    expect(capturedName).toBe('voice_42.ogg');
  });

  it('preserves non-.oga extensions verbatim', async () => {
    process.env.OPENAI_TTS_API_KEY = 'k';
    vi.spyOn(fs, 'statSync').mockReturnValue({ size: 100 } as fs.Stats);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('x'));

    let capturedName: string | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const form = init.body as FormData;
        const file = form.get('file') as File;
        capturedName = file?.name;
        return { ok: true, text: vi.fn().mockResolvedValue('hi') };
      }),
    );

    await transcribe('/tmp/song.mp3');

    expect(capturedName).toBe('song.mp3');
  });

  it('prefers OPENAI_STT_API_KEY over OPENAI_TTS_API_KEY', async () => {
    process.env.OPENAI_STT_API_KEY = 'stt-key';
    process.env.OPENAI_TTS_API_KEY = 'tts-key';
    vi.spyOn(fs, 'statSync').mockReturnValue({ size: 100 } as fs.Stats);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('x'));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue('hi'),
    });
    vi.stubGlobal('fetch', fetchMock);

    await transcribe('/tmp/v.oga');

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer stt-key',
        }),
      }),
    );
  });
});
