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
vi.mock('child_process', () => ({
  execFileSync: vi.fn(() => Buffer.from('OggS-fake-ogg')),
}));

import {
  _resetTtsModelCache,
  buildPromptPrefix,
  buildVoiceDirective,
  pickLatestFlashTtsModel,
  synthesize,
} from './tts.js';

function modelsResponse(names: string[]): Response {
  return new Response(
    JSON.stringify({ models: names.map((name) => ({ name })) }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function audioResponse(): Response {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: {
            parts: [
              {
                inlineData: {
                  data: Buffer.from('pcm-fake').toString('base64'),
                },
              },
            ],
          },
        },
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function errorResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

describe('pickLatestFlashTtsModel', () => {
  it('picks the highest gemini-x.y Flash TTS entry', () => {
    expect(
      pickLatestFlashTtsModel([
        { name: 'models/gemini-2.5-flash-tts-preview' },
        { name: 'models/gemini-3.1-flash-tts-preview' },
        { name: 'models/gemini-3.5-flash-tts-preview' },
      ]),
    ).toBe('gemini-3.5-flash-tts-preview');
  });

  it('strips the models/ prefix from the returned id', () => {
    expect(
      pickLatestFlashTtsModel([
        { name: 'models/gemini-3.5-flash-tts-preview' },
      ]),
    ).toBe('gemini-3.5-flash-tts-preview');
  });

  it('accepts entries without the models/ prefix as-is', () => {
    expect(pickLatestFlashTtsModel([{ name: 'gemini-4.0-flash-tts' }])).toBe(
      'gemini-4.0-flash-tts',
    );
  });

  it('ignores non-flash and non-tts entries', () => {
    expect(
      pickLatestFlashTtsModel([
        { name: 'models/gemini-3.5-flash' }, // flash but not tts
        { name: 'models/gemini-3.5-pro-tts-preview' }, // tts but not flash
        { name: 'models/text-embedding-004' },
        { name: 'models/gemini-3.5-flash-tts-preview' },
      ]),
    ).toBe('gemini-3.5-flash-tts-preview');
  });

  it('returns null when no Flash TTS candidate exists', () => {
    expect(
      pickLatestFlashTtsModel([
        { name: 'models/gemini-3.5-flash' },
        { name: 'models/gemini-3.5-pro' },
      ]),
    ).toBeNull();
  });

  it('returns null on empty list', () => {
    expect(pickLatestFlashTtsModel([])).toBeNull();
  });

  it('skips entries missing a parseable gemini-x.y version', () => {
    expect(
      pickLatestFlashTtsModel([
        { name: 'models/some-flash-tts-noversion' },
        { name: 'models/gemini-3.5-flash-tts-preview' },
      ]),
    ).toBe('gemini-3.5-flash-tts-preview');
  });
});

describe('buildPromptPrefix', () => {
  it('returns empty string for empty directive', () => {
    expect(buildPromptPrefix({})).toBe('');
  });

  it('formats profile + scene + director with blank-line tail', () => {
    expect(
      buildPromptPrefix({
        profile: 'warm storyteller',
        scene: 'late evening',
        director: 'unhurried',
      }),
    ).toBe(
      "[Audio Profile] warm storyteller\n[Scene] late evening\n[Director's Note] unhurried\n\n",
    );
  });
});

describe('buildVoiceDirective', () => {
  it('keeps known voices', () => {
    expect(buildVoiceDirective({ voice: 'Algenib' })).toEqual({
      voice: 'Algenib',
    });
  });

  it('drops unknown voices (directive without voice key)', () => {
    expect(buildVoiceDirective({ voice: 'NotARealVoice' })).toBeUndefined();
  });

  it('passes through director/profile/scene unconditionally', () => {
    expect(
      buildVoiceDirective({
        director: 'whisper',
        profile: 'narrator',
        scene: 'studio',
      }),
    ).toEqual({ director: 'whisper', profile: 'narrator', scene: 'studio' });
  });

  it('returns undefined when nothing was specified', () => {
    expect(buildVoiceDirective({})).toBeUndefined();
  });
});

describe('synthesize — happy path with auto-discovery', () => {
  const origKey = process.env.GOOGLE_AI_API_KEY;
  const origModel = process.env.GEMINI_TTS_MODEL;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetTtsModelCache();
    process.env.GOOGLE_AI_API_KEY = 'k';
    delete process.env.GEMINI_TTS_MODEL;
  });

  afterEach(() => {
    if (origKey === undefined) delete process.env.GOOGLE_AI_API_KEY;
    else process.env.GOOGLE_AI_API_KEY = origKey;
    if (origModel === undefined) delete process.env.GEMINI_TTS_MODEL;
    else process.env.GEMINI_TTS_MODEL = origModel;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    _resetTtsModelCache();
  });

  it('probes /v1beta/models, picks latest Flash TTS, then synthesizes', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        modelsResponse([
          'models/gemini-2.5-flash-tts-preview',
          'models/gemini-3.5-flash-tts-preview',
        ]),
      )
      .mockResolvedValueOnce(audioResponse());
    vi.stubGlobal('fetch', fetchMock);

    const out = await synthesize('hi');
    expect(out).toBeInstanceOf(Buffer);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // First call = listing
    expect(String(fetchMock.mock.calls[0][0])).toContain('/v1beta/models?key=');
    // Second call = generateContent on the picked model
    expect(String(fetchMock.mock.calls[1][0])).toContain(
      'gemini-3.5-flash-tts-preview:generateContent',
    );
  });

  it('caches the resolved model — second call skips listing', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        modelsResponse(['models/gemini-3.5-flash-tts-preview']),
      )
      .mockResolvedValueOnce(audioResponse())
      .mockResolvedValueOnce(audioResponse());
    vi.stubGlobal('fetch', fetchMock);

    await synthesize('one');
    await synthesize('two');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2][0])).toContain(
      'gemini-3.5-flash-tts-preview:generateContent',
    );
  });
});

describe('synthesize — self-heal on model-name error', () => {
  const origKey = process.env.GOOGLE_AI_API_KEY;
  const origModel = process.env.GEMINI_TTS_MODEL;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetTtsModelCache();
    process.env.GOOGLE_AI_API_KEY = 'k';
    delete process.env.GEMINI_TTS_MODEL;
  });

  afterEach(() => {
    if (origKey === undefined) delete process.env.GOOGLE_AI_API_KEY;
    else process.env.GOOGLE_AI_API_KEY = origKey;
    if (origModel === undefined) delete process.env.GEMINI_TTS_MODEL;
    else process.env.GEMINI_TTS_MODEL = origModel;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    _resetTtsModelCache();
  });

  it('invalidates cache + re-probes + retries on 404 model-name error', async () => {
    // 1: initial listing returns an old name (simulating stale state)
    // 2: synthesis on old name → 404 "model not found"
    // 3: re-probe listing returns the new name
    // 4: synthesis on new name → success
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        modelsResponse(['models/gemini-3.1-flash-tts-preview']),
      )
      .mockResolvedValueOnce(errorResponse(404, 'model not found'))
      .mockResolvedValueOnce(
        modelsResponse(['models/gemini-3.5-flash-tts-preview']),
      )
      .mockResolvedValueOnce(audioResponse());
    vi.stubGlobal('fetch', fetchMock);

    const out = await synthesize('hi');
    expect(out).toBeInstanceOf(Buffer);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(String(fetchMock.mock.calls[1][0])).toContain(
      'gemini-3.1-flash-tts-preview:generateContent',
    );
    expect(String(fetchMock.mock.calls[3][0])).toContain(
      'gemini-3.5-flash-tts-preview:generateContent',
    );
  });

  it('gives up if re-probe returns the same failing name', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        modelsResponse(['models/gemini-3.1-flash-tts-preview']),
      )
      .mockResolvedValueOnce(errorResponse(404, 'model not found'))
      .mockResolvedValueOnce(
        modelsResponse(['models/gemini-3.1-flash-tts-preview']),
      );
    vi.stubGlobal('fetch', fetchMock);

    const out = await synthesize('hi');
    expect(out).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does NOT re-probe when GEMINI_TTS_MODEL is pinned', async () => {
    process.env.GEMINI_TTS_MODEL = 'gemini-9.9-flash-tts-preview';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(404, 'model not found'));
    vi.stubGlobal('fetch', fetchMock);

    const out = await synthesize('hi');
    expect(out).toBeNull();
    // Exactly one call: no listing (env override), no re-probe (pin honoured)
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      'gemini-9.9-flash-tts-preview:generateContent',
    );
  });

  it('does NOT self-heal on non-model errors (e.g. 500)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        modelsResponse(['models/gemini-3.5-flash-tts-preview']),
      )
      .mockResolvedValueOnce(errorResponse(500, 'internal'));
    vi.stubGlobal('fetch', fetchMock);

    const out = await synthesize('hi');
    expect(out).toBeNull();
    // 2 calls only: listing + 1 failed synthesis. No re-probe on 500.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('synthesize — failure modes', () => {
  const origKey = process.env.GOOGLE_AI_API_KEY;
  const origModel = process.env.GEMINI_TTS_MODEL;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetTtsModelCache();
    delete process.env.GEMINI_TTS_MODEL;
  });

  afterEach(() => {
    if (origKey === undefined) delete process.env.GOOGLE_AI_API_KEY;
    else process.env.GOOGLE_AI_API_KEY = origKey;
    if (origModel === undefined) delete process.env.GEMINI_TTS_MODEL;
    else process.env.GEMINI_TTS_MODEL = origModel;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    _resetTtsModelCache();
  });

  it('returns null when GOOGLE_AI_API_KEY is missing', async () => {
    delete process.env.GOOGLE_AI_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const out = await synthesize('hi');
    expect(out).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when /v1beta/models lists no Flash TTS candidate', async () => {
    process.env.GOOGLE_AI_API_KEY = 'k';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        modelsResponse([
          'models/gemini-3.5-flash',
          'models/gemini-3.5-pro',
          'models/text-embedding-004',
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const out = await synthesize('hi');
    expect(out).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses GEMINI_TTS_MODEL override and skips listing', async () => {
    process.env.GOOGLE_AI_API_KEY = 'k';
    process.env.GEMINI_TTS_MODEL = 'gemini-pinned-flash-tts';
    const fetchMock = vi.fn().mockResolvedValueOnce(audioResponse());
    vi.stubGlobal('fetch', fetchMock);

    const out = await synthesize('hi');
    expect(out).toBeInstanceOf(Buffer);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      'gemini-pinned-flash-tts:generateContent',
    );
  });
});
