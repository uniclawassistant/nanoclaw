import { describe, expect, it } from 'vitest';

import { extractTtsDirective } from './tts.js';

describe('extractTtsDirective', () => {
  it('returns null when no tag present', () => {
    expect(extractTtsDirective('hello')).toBeNull();
  });

  it('[[tts]] alone speaks the surrounding text', () => {
    const d = extractTtsDirective('hey there [[tts]]');
    expect(d).toEqual({ ttsText: 'hey there', cleanText: 'hey there' });
    expect(d?.voice).toBeUndefined();
  });

  it('[[tts:text]] legacy form speaks the payload', () => {
    const d = extractTtsDirective('[[tts:hello world]]');
    expect(d).toEqual({ ttsText: 'hello world', cleanText: '' });
    expect(d?.voice).toBeUndefined();
  });

  it('[[tts:style=whisper: text]] extracts voice control', () => {
    const d = extractTtsDirective('[[tts:style=whisper: hello]]');
    expect(d?.ttsText).toBe('hello');
    expect(d?.voice).toEqual({ style: 'whisper' });
  });

  it('parses style, pace, accent, and profile together', () => {
    const d = extractTtsDirective(
      '[[tts:style=newscaster,pace=rapid-fire,accent=british-rp,profile=professional: breaking news]]',
    );
    expect(d?.ttsText).toBe('breaking news');
    expect(d?.voice).toEqual({
      style: 'newscaster',
      pace: 'rapid-fire',
      accent: 'british-rp',
      profile: 'professional',
    });
  });

  it('accepts profile as free-slug including hyphens', () => {
    const d = extractTtsDirective('[[tts:profile=warm-and-energetic: hi]]');
    expect(d?.voice).toEqual({ profile: 'warm-and-energetic' });
  });

  it('unknown key falls back to legacy (whole payload is text)', () => {
    // `author=Fedor` is not in KNOWN_KEYS — don't swallow user text
    const d = extractTtsDirective('[[tts:author=fedor: biography]]');
    expect(d?.ttsText).toBe('author=fedor: biography');
    expect(d?.voice).toBeUndefined();
  });

  it('unknown enum value falls back to legacy', () => {
    // `style=yodel` not in KNOWN_STYLES — don't silently drop it
    const d = extractTtsDirective('[[tts:style=yodel: hi]]');
    expect(d?.ttsText).toBe('style=yodel: hi');
    expect(d?.voice).toBeUndefined();
  });

  it('mixed valid + invalid keys falls back to legacy', () => {
    const d = extractTtsDirective(
      '[[tts:style=whisper,accent=martian: hi]]',
    );
    expect(d?.ttsText).toBe('style=whisper,accent=martian: hi');
    expect(d?.voice).toBeUndefined();
  });

  it('natural-text colon does not trigger preset parsing', () => {
    // "Plot" has uppercase — parser skips token-match and treats as legacy
    const d = extractTtsDirective('[[tts:Plot: a graph]]');
    expect(d?.ttsText).toBe('Plot: a graph');
    expect(d?.voice).toBeUndefined();
  });

  it('preserves cleanText alongside the voice tag', () => {
    const d = extractTtsDirective(
      'intro line\n[[tts:style=deadpan: the punchline]]',
    );
    expect(d?.ttsText).toBe('the punchline');
    expect(d?.cleanText).toBe('intro line');
    expect(d?.voice).toEqual({ style: 'deadpan' });
  });

  it('returns null when [[tts]] has no surrounding text', () => {
    expect(extractTtsDirective('[[tts]]')).toBeNull();
  });

  it('empty voice-tokens section falls through to legacy', () => {
    const d = extractTtsDirective('[[tts:  : hi]]');
    // leading colons with whitespace don't match the tokens regex → legacy
    expect(d?.ttsText).toBe(': hi');
  });
});
