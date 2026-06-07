import { describe, expect, it } from 'vitest';
import { normalizeXmlSmuggledArgs } from './tool-args-normalize.js';

const IMAGE_PARAMS = ['prompt', 'preset', 'caption'] as const;

// Helper: tests pass partial arg shapes but want to read recovered fields
// off result.args. Cast to a permissive record so the assertions stay terse.
function asAny(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

describe('normalizeXmlSmuggledArgs', () => {
  it('passes a clean JSON tool call through unchanged', () => {
    const args = {
      prompt: 'A small cat in a hat.',
      preset: ['portrait', 'quality=high'],
      caption: 'kitty',
    };
    const result = normalizeXmlSmuggledArgs(args, {
      knownParams: IMAGE_PARAMS,
    });
    expect(result.recovered).toEqual([]);
    expect(result.unrecognized).toBe(false);
    expect(result.args).toEqual(args);
  });

  it('recovers preset from the real FED-32 DB sample', () => {
    // Tail copied verbatim from messages.id=11196 generation_json prompt.
    const promptWithSmuggled =
      'Flat 2D UI design of an iOS 26 music player screen … dark mode.</prompt>\n' +
      '<parameter name="preset">["1024x1536","format=png","quality=high"]';
    const result = normalizeXmlSmuggledArgs(
      { prompt: promptWithSmuggled },
      { knownParams: IMAGE_PARAMS },
    );
    expect(result.recovered).toEqual(['preset']);
    expect(result.unrecognized).toBe(false);
    expect(result.args.prompt).toBe(
      'Flat 2D UI design of an iOS 26 music player screen … dark mode.',
    );
    expect(asAny(result.args).preset).toEqual([
      '1024x1536',
      'format=png',
      'quality=high',
    ]);
  });

  it('recovers multiple parameters and respects </parameter> closers', () => {
    const tail =
      'Just say hi.</text>\n' +
      '<parameter name="voice">"Kore"</parameter>\n' +
      '<parameter name="director">whispered, close to mic</parameter>';
    const result = normalizeXmlSmuggledArgs(
      { text: tail },
      { knownParams: ['text', 'voice', 'director', 'profile', 'scene'] },
    );
    expect(result.recovered.sort()).toEqual(['director', 'voice']);
    expect(result.args.text).toBe('Just say hi.');
    expect(asAny(result.args).voice).toBe('Kore');
    expect(asAny(result.args).director).toBe('whispered, close to mic');
  });

  it('never overwrites a parameter that was already passed (collision is not unrecognized)', () => {
    const args = {
      prompt: 'real prompt</prompt>\n<parameter name="preset">["square"]',
      preset: ['portrait'],
    };
    const result = normalizeXmlSmuggledArgs(args, {
      knownParams: IMAGE_PARAMS,
    });
    // boundary present, preset already set => no recovery, but the tail
    // referenced a known param, so the call is still well-formed (not
    // refuse-worthy).
    expect(result.args.prompt).toBe('real prompt');
    expect(asAny(result.args).preset).toEqual(['portrait']);
    expect(result.recovered).toEqual([]);
    expect(result.unrecognized).toBe(false);
  });

  it('ignores embedded <parameter> blocks whose names are unknown', () => {
    const args = {
      prompt:
        'real</prompt>\n<parameter name="bogus">["whatever"]\n<parameter name="preset">["portrait"]',
    };
    const result = normalizeXmlSmuggledArgs(args, {
      knownParams: IMAGE_PARAMS,
    });
    expect(result.recovered).toEqual(['preset']);
    expect((result.args as Record<string, unknown>).bogus).toBeUndefined();
    expect(asAny(result.args).preset).toEqual(['portrait']);
  });

  it('marks unrecognized when boundary fires but nothing maps to known params', () => {
    const args = {
      prompt: 'real</prompt>\n<parameter name="bogus">["whatever"]',
    };
    const result = normalizeXmlSmuggledArgs(args, {
      knownParams: IMAGE_PARAMS,
    });
    expect(result.recovered).toEqual([]);
    expect(result.unrecognized).toBe(true);
    expect(result.args.prompt).toBe('real');
  });

  it('does NOT trigger on a literal "<parameter" inside legitimate prompt text', () => {
    // No `</TAG>` boundary before the substring => left alone.
    const args = {
      prompt:
        'Render this XML literally: <parameter name="example">hi</parameter>.',
    };
    const result = normalizeXmlSmuggledArgs(args, {
      knownParams: IMAGE_PARAMS,
    });
    expect(result.recovered).toEqual([]);
    expect(result.unrecognized).toBe(false);
    expect(result.args.prompt).toBe(args.prompt);
  });

  it('coerces JSON-ish, boolean, numeric values; leaves plain text alone', () => {
    const args = {
      text:
        'ok</text>\n' +
        '<parameter name="voice">"Leda"</parameter>\n' +
        '<parameter name="director">unhurried storyteller</parameter>',
    };
    const result = normalizeXmlSmuggledArgs(args, {
      knownParams: ['text', 'voice', 'director'],
    });
    expect(asAny(result.args).voice).toBe('Leda');
    expect(asAny(result.args).director).toBe('unhurried storyteller');
  });

  it('preserves a string-typed param verbatim, even when value looks like JSON', () => {
    // caption is declared as string in the tool's zod shape. A value that
    // happens to look like a JSON array must NOT be parsed into an array —
    // type drives coercion, not the shape of the raw text.
    const args = {
      prompt: 'real prompt</prompt>\n<parameter name="caption">[1,2]',
    };
    const result = normalizeXmlSmuggledArgs(args, {
      knownParams: IMAGE_PARAMS,
      stringParams: ['prompt', 'caption'],
    });
    expect(result.recovered).toEqual(['caption']);
    expect(asAny(result.args).caption).toBe('[1,2]');
    // sanity: preset (non-string) still gets coerced when present in the same call
    const args2 = {
      prompt:
        'real</prompt>\n<parameter name="caption">"42"\n<parameter name="preset">["1024x1536"]',
    };
    const result2 = normalizeXmlSmuggledArgs(args2, {
      knownParams: IMAGE_PARAMS,
      stringParams: ['prompt', 'caption'],
    });
    expect(asAny(result2.args).caption).toBe('"42"');
    expect(asAny(result2.args).preset).toEqual(['1024x1536']);
  });

  it('leaves non-string fields and undefined entries untouched', () => {
    const args: Record<string, unknown> = {
      prompt: 'clean</prompt>\n<parameter name="preset">["square"]',
      preset: undefined,
      meta: { foo: 1 },
    };
    const result = normalizeXmlSmuggledArgs(args, {
      knownParams: IMAGE_PARAMS,
    });
    expect(result.recovered).toEqual(['preset']);
    expect(result.args.prompt).toBe('clean');
    expect(asAny(result.args).preset).toEqual(['square']);
    expect(result.args.meta).toEqual({ foo: 1 });
  });
});
