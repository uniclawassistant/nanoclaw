import { describe, expect, it } from 'vitest';

import {
  DEFAULT_VOICE,
  GEMINI_TTS_MODEL,
  buildGeminiRequest,
  buildVoiceDirective,
  decodeGeminiAudio,
} from './tts.js';

function wav(
  pcm: Buffer,
  { sampleRate = 24000, channels = 1, bits = 16, extraChunk = false } = {},
): Buffer {
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'latin1');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE((sampleRate * channels * bits) / 8, 16);
  fmt.writeUInt16LE((channels * bits) / 8, 20);
  fmt.writeUInt16LE(bits, 22);
  const list = extraChunk
    ? Buffer.concat([Buffer.from('LIST\x03\x00\x00\x00abc\x00', 'latin1')])
    : Buffer.alloc(0);
  const dataHeader = Buffer.alloc(8);
  dataHeader.write('data', 0, 'latin1');
  dataHeader.writeUInt32LE(pcm.length, 4);
  const body = Buffer.concat([fmt, list, dataHeader, pcm]);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(body.length + 4, 4);
  riff.write('WAVE', 8, 'latin1');
  return Buffer.concat([riff, body]);
}

const samples = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);

describe('decodeGeminiAudio', () => {
  it('passes raw PCM through with the rate from the mime type', () => {
    const out = decodeGeminiAudio(samples, 'audio/L16;codec=pcm;rate=24000');
    expect(out).toEqual({ pcm: samples, sampleRate: 24000, channels: 1 });
  });

  it('defaults raw PCM to 24 kHz mono when the mime type has no rate', () => {
    const out = decodeGeminiAudio(samples, undefined);
    expect(out.sampleRate).toBe(24000);
    expect(out.channels).toBe(1);
  });

  it('strips the WAV header and reads rate and channels from fmt', () => {
    const out = decodeGeminiAudio(
      wav(samples, { sampleRate: 48000, channels: 2 }),
      'audio/wav',
    );
    expect(out.pcm.equals(samples)).toBe(true);
    expect(out.sampleRate).toBe(48000);
    expect(out.channels).toBe(2);
  });

  it('skips unknown chunks before data, including odd-sized ones', () => {
    const out = decodeGeminiAudio(
      wav(samples, { extraChunk: true }),
      'audio/wav',
    );
    expect(out.pcm.equals(samples)).toBe(true);
  });

  it('detects a RIFF header even when the mime type says PCM', () => {
    const out = decodeGeminiAudio(wav(samples), 'audio/L16;rate=24000');
    expect(out.pcm.equals(samples)).toBe(true);
  });

  it('rejects audio/wav without a RIFF header', () => {
    expect(() => decodeGeminiAudio(samples, 'audio/wav')).toThrow(/RIFF/);
  });

  it('rejects non-16-bit WAV', () => {
    expect(() =>
      decodeGeminiAudio(wav(samples, { bits: 8 }), 'audio/wav'),
    ).toThrow(/unsupported WAV/);
  });
});

describe('buildVoiceDirective', () => {
  it('maps director to style and never keeps prose for the transcript', () => {
    const r = buildVoiceDirective({ director: 'whispered urgently' });
    expect(r.directive).toEqual({ style: 'whispered urgently' });
    expect(r.warnings).toEqual([]);
  });

  it('prefers explicit style over director and warns', () => {
    const r = buildVoiceDirective({
      style: 'casual, friendly',
      director: 'sad',
    });
    expect(r.directive?.style).toBe('casual, friendly');
    expect(r.warnings.join()).toMatch(/director ignored/);
  });

  it('drops profile and scene with warnings', () => {
    const r = buildVoiceDirective({
      profile: 'noir detective',
      scene: 'rainy night',
    });
    expect(r.directive).toBeUndefined();
    expect(r.warnings).toHaveLength(2);
  });

  it('keeps a BCP-47 language and drops an invalid one', () => {
    expect(buildVoiceDirective({ language: 'ru-RU' }).directive).toEqual({
      language: 'ru-RU',
    });
    const bad = buildVoiceDirective({ language: 'russian please' });
    expect(bad.directive).toBeUndefined();
    expect(bad.warnings.join()).toMatch(/BCP-47/);
  });

  it('warns on unknown voice', () => {
    const r = buildVoiceDirective({ voice: 'kore' });
    expect(r.directive).toBeUndefined();
    expect(r.warnings.join()).toMatch(/unknown voice/);
  });

  it('accepts two speakers and inherits a repeated speaker voice', () => {
    const r = buildVoiceDirective({
      parts: [
        { speaker: 'A', voice: 'Puck', text: 'Раз' },
        { speaker: 'B', voice: 'Kore', text: 'Два', style: 'calm' },
        { speaker: 'A', text: 'Три' },
      ],
    });
    expect(r.error).toBeUndefined();
    expect(r.directive?.parts?.[2]).toEqual({
      speaker: 'A',
      voice: 'Puck',
      text: 'Три',
    });
  });

  it('rejects a third speaker', () => {
    const r = buildVoiceDirective({
      parts: [
        { speaker: 'A', voice: 'Puck', text: '1' },
        { speaker: 'B', voice: 'Kore', text: '2' },
        { speaker: 'C', voice: 'Leda', text: '3' },
      ],
    });
    expect(r.error).toMatch(/at most 2/);
  });

  it('rejects unknown, missing or conflicting part voices', () => {
    expect(
      buildVoiceDirective({
        parts: [{ speaker: 'A', voice: 'Nope', text: 'x' }],
      }).error,
    ).toMatch(/not a known voice/);
    expect(
      buildVoiceDirective({ parts: [{ speaker: 'A', text: 'x' }] }).error,
    ).toMatch(/voice is required/);
    expect(
      buildVoiceDirective({
        parts: [
          { speaker: 'A', voice: 'Puck', text: 'x' },
          { speaker: 'A', voice: 'Kore', text: 'y' },
        ],
      }).error,
    ).toMatch(/already uses voice/);
  });

  it('moves top-level voice/style out of a parts request with warnings', () => {
    const r = buildVoiceDirective({
      voice: 'Kore',
      style: 'calm',
      parts: [{ speaker: 'A', voice: 'Puck', text: 'x' }],
    });
    expect(r.directive?.voice).toBeUndefined();
    expect(r.directive?.style).toBeUndefined();
    expect(r.warnings).toHaveLength(2);
  });
});

describe('buildGeminiRequest', () => {
  it('targets 3.8', () => {
    expect(GEMINI_TTS_MODEL).toBe('gemini-3.8-flash-tts');
  });

  it('single voice: verbatim text, inline tags kept, no language when unset', () => {
    const body = buildGeminiRequest('Привет <chuckle> как ты?') as any;
    expect(body.contents[0].parts).toEqual([
      { text: 'Привет <chuckle> как ты?' },
    ]);
    expect(body.generationConfig.responseModalities).toEqual(['AUDIO']);
    expect(body.generationConfig.speechConfig).toEqual({
      voiceConfig: { prebuiltVoiceConfig: { voiceName: DEFAULT_VOICE } },
    });
  });

  it('single voice: style goes to speechMetadata, never into the text', () => {
    const { directive } = buildVoiceDirective({
      director: 'warm storyteller',
      profile: 'grandmother',
      scene: 'quiet room',
      language: 'ru-RU',
      voice: 'Leda',
    });
    const body = buildGeminiRequest('Жил-был единорог.', directive) as any;
    const json = JSON.stringify(body.contents);
    expect(body.contents[0].parts).toEqual([
      {
        text: 'Жил-был единорог.',
        speechMetadata: { style: 'warm storyteller' },
      },
    ]);
    expect(json).not.toMatch(
      /grandmother|quiet room|Director|Audio Profile|Scene/,
    );
    expect(body.generationConfig.speechConfig).toEqual({
      languageCode: 'ru-RU',
      voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Leda' } },
    });
  });

  it('two speakers: one text part per turn with speechMetadata.speaker', () => {
    const { directive } = buildVoiceDirective({
      language: 'ru-RU',
      parts: [
        {
          speaker: 'HostA',
          voice: 'Puck',
          text: 'Новый трек |угу|.',
          style: 'casual, friendly',
        },
        { speaker: 'HostB', voice: 'Kore', text: 'Да <chuckle>.' },
      ],
    });
    const body = buildGeminiRequest('', directive) as any;
    expect(body.contents[0].parts).toEqual([
      {
        text: 'Новый трек |угу|.',
        speechMetadata: { speaker: 'HostA', style: 'casual, friendly' },
      },
      { text: 'Да <chuckle>.', speechMetadata: { speaker: 'HostB' } },
    ]);
    expect(body.generationConfig.speechConfig).toEqual({
      languageCode: 'ru-RU',
      multiSpeakerVoiceConfig: {
        speakerVoiceConfigs: [
          {
            speaker: 'HostA',
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } },
          },
          {
            speaker: 'HostB',
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
        ],
      },
    });
    expect(JSON.stringify(body.contents)).not.toMatch(/HostA:|HostB:/);
  });

  it('one speaker in parts uses voiceConfig and per-part style only', () => {
    const { directive } = buildVoiceDirective({
      parts: [
        { speaker: 'A', voice: 'Puck', text: 'тихо', style: 'whispering' },
        { speaker: 'A', text: 'громко' },
      ],
    });
    const body = buildGeminiRequest('', directive) as any;
    expect(body.contents[0].parts).toEqual([
      { text: 'тихо', speechMetadata: { style: 'whispering' } },
      { text: 'громко' },
    ]);
    expect(
      body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig
        .voiceName,
    ).toBe('Puck');
  });
});
