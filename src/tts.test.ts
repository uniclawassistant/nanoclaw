import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock before importing tts.js — child_process can't be spyOn'd on macOS
// (readonly ESM module binding); env.js otherwise reads the real .env and
// leaks real API keys into process.env, breaking provider-selection tests.
vi.mock('child_process', () => ({
  execFileSync: vi.fn(() => Buffer.from('ogg-stub')),
}));
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

import {
  buildPromptPrefix,
  DEFAULT_VOICE,
  extractTtsDirective,
  KNOWN_VOICES,
  synthesize,
} from './tts.js';

describe('extractTtsDirective — baseline / legacy', () => {
  it('returns null when no tag present', () => {
    expect(extractTtsDirective('hello')).toBeNull();
  });

  it('[[tts]] alone speaks surrounding text with no directive', () => {
    const d = extractTtsDirective('hey there [[tts]]');
    expect(d).toEqual({ ttsText: 'hey there', cleanText: 'hey there' });
    expect(d?.directive).toBeUndefined();
  });

  it('[[tts]] with no surrounding text returns null', () => {
    expect(extractTtsDirective('[[tts]]')).toBeNull();
  });

  it('[[tts:text]] legacy form speaks the payload', () => {
    const d = extractTtsDirective('[[tts:hello world]]');
    expect(d).toEqual({ ttsText: 'hello world', cleanText: '' });
    expect(d?.directive).toBeUndefined();
  });

  it('[tts] single-bracket legacy still works', () => {
    const d = extractTtsDirective('before [tts] after');
    expect(d?.ttsText).toBe('before  after'); // double-space from stripped tag
    expect(d?.directive).toBeUndefined();
  });

  it('[[tts:(вдох) слушай]] — leading colon keeps parens literal', () => {
    // Per user decision: leading `:` disambiguates legacy from simple.
    const d = extractTtsDirective('[[tts:(вдох) слушай]]');
    expect(d?.ttsText).toBe('(вдох) слушай');
    expect(d?.directive).toBeUndefined();
  });
});

describe('extractTtsDirective — simple mode', () => {
  it('[[tts(Kore): hi]] — voice only', () => {
    const d = extractTtsDirective('[[tts(Kore): Serious briefing]]');
    expect(d?.ttsText).toBe('Serious briefing');
    expect(d?.directive).toEqual({ voice: 'Kore' });
  });

  it('[[tts(whispered, close to mic): hi]] — director only', () => {
    const d = extractTtsDirective(
      '[[tts(whispered, close to mic): Тссс, секрет]]',
    );
    expect(d?.ttsText).toBe('Тссс, секрет');
    expect(d?.directive).toEqual({ director: 'whispered, close to mic' });
  });

  it('voice + director combined — voice first', () => {
    const d = extractTtsDirective(
      '[[tts(Leda, warm storyteller tone, slow drift): Жил-был единорог]]',
    );
    expect(d?.ttsText).toBe('Жил-был единорог');
    expect(d?.directive).toEqual({
      voice: 'Leda',
      director: 'warm storyteller tone, slow drift',
    });
  });

  it('voice name is case-sensitive — lowercase becomes director', () => {
    const d = extractTtsDirective('[[tts(kore): hi]]');
    expect(d?.ttsText).toBe('hi');
    expect(d?.directive).toEqual({ director: 'kore' });
  });

  it('unknown voice token falls through to director prose', () => {
    const d = extractTtsDirective(
      '[[tts(NotAVoice, tired sarcasm): whatever]]',
    );
    expect(d?.ttsText).toBe('whatever');
    expect(d?.directive).toEqual({
      director: 'NotAVoice, tired sarcasm',
    });
  });

  it('first matching voice wins — subsequent voice-like tokens go to director', () => {
    const d = extractTtsDirective('[[tts(Leda, tone like Kore): hi]]');
    expect(d?.directive).toEqual({
      voice: 'Leda',
      director: 'tone like Kore',
    });
  });

  it('two known voices — first wins, second goes to director', () => {
    const d = extractTtsDirective('[[tts(Kore, Leda): hi]]');
    expect(d?.directive).toEqual({ voice: 'Kore', director: 'Leda' });
  });

  it('empty parens [[tts(): hi]] falls through to legacy', () => {
    const d = extractTtsDirective('[[tts(): hi]]');
    expect(d?.ttsText).toBe('(): hi');
    expect(d?.directive).toBeUndefined();
  });

  it('malformed simple mode (no trailing colon) falls through to legacy', () => {
    // "(whispered) hi" — no `):` so SIMPLE_MODE_RE fails
    const d = extractTtsDirective('[[tts(whispered) hi]]');
    expect(d?.ttsText).toBe('(whispered) hi');
    expect(d?.directive).toBeUndefined();
  });

  it('preserves cleanText alongside simple-mode tag', () => {
    const d = extractTtsDirective('intro line\n[[tts(Kore): the briefing]]');
    expect(d?.ttsText).toBe('the briefing');
    expect(d?.cleanText).toBe('intro line');
    expect(d?.directive).toEqual({ voice: 'Kore' });
  });

  it('inline [tags] in spoken text pass through as-is', () => {
    const d = extractTtsDirective('[[tts(Kore): [whispers] тише, смотри]]');
    expect(d?.ttsText).toBe('[whispers] тише, смотри');
  });
});

describe('extractTtsDirective — block mode', () => {
  it('full block with all 4 keys', () => {
    const d = extractTtsDirective(
      [
        '[[tts',
        'voice: Leda',
        'profile: warm grandmother',
        'scene: quiet room',
        'director: unhurried',
        'Жил-был единорог.',
        ']]',
      ].join('\n'),
    );
    expect(d?.ttsText).toBe('Жил-был единорог.');
    expect(d?.directive).toEqual({
      voice: 'Leda',
      profile: 'warm grandmother',
      scene: 'quiet room',
      director: 'unhurried',
    });
  });

  it('only director', () => {
    const d = extractTtsDirective(
      '[[tts\ndirector: flat affect, dry\nHello.\n]]',
    );
    expect(d?.ttsText).toBe('Hello.');
    expect(d?.directive).toEqual({ director: 'flat affect, dry' });
  });

  it('transcript preserves empty lines and multi-line structure', () => {
    const d = extractTtsDirective(
      '[[tts\nvoice: Algenib\nFirst line.\n\nSecond line after blank.\n]]',
    );
    expect(d?.ttsText).toBe('First line.\n\nSecond line after blank.');
    expect(d?.directive).toEqual({ voice: 'Algenib' });
  });

  it('unknown key line becomes transcript start (strict key pattern)', () => {
    // `stage:` isn't in the allowed key set — treated as transcript
    const d = extractTtsDirective(
      '[[tts\nvoice: Kore\nstage: x\nactual transcript\n]]',
    );
    expect(d?.directive).toEqual({ voice: 'Kore' });
    expect(d?.ttsText).toBe('stage: x\nactual transcript');
  });

  it('duplicate keys — last-write-wins', () => {
    const d = extractTtsDirective('[[tts\nvoice: Kore\nvoice: Leda\nhi\n]]');
    expect(d?.directive?.voice).toBe('Leda');
  });

  it('unknown voice name — warned and ignored, other keys retained', () => {
    const warnSpy = vi.fn();
    vi.doMock('./logger.js', () => ({ logger: { warn: warnSpy } }));
    const d = extractTtsDirective(
      '[[tts\nvoice: Martian\nprofile: weird\ntext\n]]',
    );
    expect(d?.directive).toEqual({ profile: 'weird' });
    expect(d?.directive?.voice).toBeUndefined();
    vi.doUnmock('./logger.js');
  });

  it('no keys (transcript on first line) returns transcript without directive', () => {
    const d = extractTtsDirective('[[tts\njust a transcript\nsecond line\n]]');
    expect(d?.ttsText).toBe('just a transcript\nsecond line');
    expect(d?.directive).toBeUndefined();
  });

  it('block mode with inline [tags] — tags pass through', () => {
    const d = extractTtsDirective(
      '[[tts\nvoice: Leda\nОн был [whispers] застенчивый.\n]]',
    );
    expect(d?.ttsText).toBe('Он был [whispers] застенчивый.');
    expect(d?.directive?.voice).toBe('Leda');
  });

  it('preserves cleanText alongside block-mode tag', () => {
    const d = extractTtsDirective(
      'prelude text\n[[tts\nvoice: Puck\nHello!\n]]',
    );
    expect(d?.cleanText).toBe('prelude text');
    expect(d?.ttsText).toBe('Hello!');
    expect(d?.directive?.voice).toBe('Puck');
  });
});

describe('buildPromptPrefix', () => {
  it('empty directive → empty prefix', () => {
    expect(buildPromptPrefix({})).toBe('');
  });

  it('voice-only directive does not contribute prose (voice goes to API field)', () => {
    expect(buildPromptPrefix({ voice: 'Kore' })).toBe('');
  });

  it('profile alone', () => {
    expect(buildPromptPrefix({ profile: 'warm grandmother' })).toBe(
      '[Audio Profile] warm grandmother\n\n',
    );
  });

  it('composes profile + scene + director in stable order', () => {
    const out = buildPromptPrefix({
      profile: 'detective noir',
      scene: 'rainy night',
      director: 'hard-boiled, cynical',
    });
    expect(out).toBe(
      '[Audio Profile] detective noir\n' +
        '[Scene] rainy night\n' +
        "[Director's Note] hard-boiled, cynical\n\n",
    );
  });

  it('only director', () => {
    expect(buildPromptPrefix({ director: 'staccato delivery' })).toBe(
      "[Director's Note] staccato delivery\n\n",
    );
  });
});

describe('KNOWN_VOICES catalog', () => {
  it('contains exactly 30 voices', () => {
    expect(KNOWN_VOICES.size).toBe(30);
  });

  it('includes the default Enceladus', () => {
    expect(KNOWN_VOICES.has(DEFAULT_VOICE)).toBe(true);
    expect(DEFAULT_VOICE).toBe('Enceladus');
  });

  it('rejects case variants', () => {
    expect(KNOWN_VOICES.has('enceladus')).toBe(false);
    expect(KNOWN_VOICES.has('ENCELADUS')).toBe(false);
  });
});

describe('synthesize — provider wiring (mocked fetch)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.GOOGLE_AI_API_KEY = 'test-google-key';
    delete process.env.OPENAI_TTS_API_KEY;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.GOOGLE_AI_API_KEY;
    delete process.env.OPENAI_TTS_API_KEY;
    vi.restoreAllMocks();
  });

  it('uses DEFAULT_VOICE when directive is absent', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => '',
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                { inlineData: { data: Buffer.from('x').toString('base64') } },
              ],
            },
          },
        ],
      }),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    // ffmpeg isn't available in test env — swallow the PCM→Opus conversion.
    // Instead of running it, stub execFileSync via spy on child_process.
    await synthesize('hello');

    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(
      body.generationConfig.speech_config.voice_config.prebuilt_voice_config
        .voice_name,
    ).toBe('Enceladus');
    expect(body.contents[0].parts[0].text).toBe('hello');
  });

  it('uses directive.voice when provided', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => '',
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                { inlineData: { data: Buffer.from('x').toString('base64') } },
              ],
            },
          },
        ],
      }),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await synthesize('hello', { voice: 'Leda' });

    const body = JSON.parse(
      (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
        .body as string,
    );
    expect(
      body.generationConfig.speech_config.voice_config.prebuilt_voice_config
        .voice_name,
    ).toBe('Leda');
  });

  it('prepends buildPromptPrefix output to the text sent to Gemini', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => '',
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                { inlineData: { data: Buffer.from('x').toString('base64') } },
              ],
            },
          },
        ],
      }),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await synthesize('spoken text', {
      profile: 'warm grandmother',
      director: 'unhurried',
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
        .body as string,
    );
    const sent = body.contents[0].parts[0].text;
    expect(sent).toBe(
      '[Audio Profile] warm grandmother\n' +
        "[Director's Note] unhurried\n\n" +
        'spoken text',
    );
  });

  it('OpenAI fallback drops directive and sends raw text', async () => {
    delete process.env.GOOGLE_AI_API_KEY;
    process.env.OPENAI_TTS_API_KEY = 'test-openai-key';

    const fetchMock = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(4),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await synthesize('hello world', {
      voice: 'Leda',
      director: 'whispered, close to mic',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
        .body as string,
    );
    expect(body.input).toBe('hello world');
    expect(body.model).toBe('gpt-4o-mini-tts');
    // Verify the directive did NOT leak into the input
    expect(body.input).not.toContain('[Director');
    expect(body.input).not.toContain('whispered');
  });
});
