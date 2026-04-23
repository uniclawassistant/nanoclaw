import { describe, it, expect, vi, beforeEach } from 'vitest';

import { extractImageDirective, resolvePresets } from './image-gen.js';
import { logger } from './logger.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('extractImageDirective — presets parsing', () => {
  it('plain [[image: prompt]] has no presets', () => {
    const d = extractImageDirective('[[image: a quiet lake]]');
    expect(d).toEqual({
      type: 'generate',
      prompt: 'a quiet lake',
      cleanText: '',
      presets: [],
    });
  });

  it('single preset: [[image:portrait: prompt]]', () => {
    const d = extractImageDirective('[[image:portrait: a quiet lake]]');
    expect(d?.presets).toEqual(['portrait']);
    expect(d?.prompt).toBe('a quiet lake');
  });

  it('multiple presets: [[image:portrait,hd: prompt]]', () => {
    const d = extractImageDirective('[[image:portrait,hd: a quiet lake]]');
    expect(d?.presets).toEqual(['portrait', 'hd']);
    expect(d?.prompt).toBe('a quiet lake');
  });

  it('parser accepts custom WxH alongside named tokens', () => {
    const d = extractImageDirective('[[image:2048x1536,hd: a poster]]');
    expect(d?.presets).toEqual(['2048x1536', 'hd']);
    expect(d?.prompt).toBe('a poster');
  });

  it('preset-like prefix with uppercase is treated as prompt', () => {
    // "Plot: a graph" — uppercase P → not a preset list
    const d = extractImageDirective('[[image: Plot: a graph]]');
    expect(d?.presets).toEqual([]);
    expect(d?.prompt).toBe('Plot: a graph');
  });

  it('lowercase non-preset prefix is treated as prompt (no false positive)', () => {
    const a = extractImageDirective('[[image: sunset: golden hour]]');
    expect(a?.presets).toEqual([]);
    expect(a?.prompt).toBe('sunset: golden hour');

    const b = extractImageDirective('[[image: plan: a city map]]');
    expect(b?.presets).toEqual([]);
    expect(b?.prompt).toBe('plan: a city map');
  });

  it('mixed known+unknown tokens → not parsed as presets', () => {
    // If user actually wanted presets but typo'd one, we'd rather
    // skip presets entirely than apply a partial set silently.
    const d = extractImageDirective('[[image:portrait,foobar: a cat]]');
    expect(d?.presets).toEqual([]);
    expect(d?.prompt).toBe('portrait,foobar: a cat');
  });

  it('non-latin prompt parses with no presets', () => {
    const d = extractImageDirective('[[image: котик в лесу]]');
    expect(d?.presets).toEqual([]);
    expect(d?.prompt).toBe('котик в лесу');
  });

  it('prompt with internal colon after space is preserved', () => {
    const d = extractImageDirective('[[image: a sign that says: hello]]');
    expect(d?.presets).toEqual([]);
    expect(d?.prompt).toBe('a sign that says: hello');
  });

  it('empty prompt returns null', () => {
    expect(extractImageDirective('[[image: ]]')).toBeNull();
    expect(extractImageDirective('[[image:portrait: ]]')).toBeNull();
  });

  it('edit with presets: [[image-edit:portrait,hd: path | prompt]]', () => {
    const d = extractImageDirective(
      '[[image-edit:portrait,hd: attachments/foo.jpg | make it blue]]',
    );
    expect(d?.type).toBe('edit');
    expect(d?.presets).toEqual(['portrait', 'hd']);
    expect(d?.sourcePath).toBe('attachments/foo.jpg');
    expect(d?.prompt).toBe('make it blue');
  });

  it('edit without presets still works', () => {
    const d = extractImageDirective(
      '[[image-edit: attachments/foo.jpg | make it blue]]',
    );
    expect(d?.type).toBe('edit');
    expect(d?.presets).toEqual([]);
    expect(d?.sourcePath).toBe('attachments/foo.jpg');
    expect(d?.prompt).toBe('make it blue');
  });
});

describe('resolvePresets', () => {
  it('empty presets → default', () => {
    expect(resolvePresets([])).toEqual({
      size: '1024x1024',
      quality: 'low',
    });
    expect(resolvePresets(undefined)).toEqual({
      size: '1024x1024',
      quality: 'low',
    });
  });

  it('portrait → 1024x1536', () => {
    expect(resolvePresets(['portrait'])).toMatchObject({ size: '1024x1536' });
  });

  it('landscape → 1536x1024', () => {
    expect(resolvePresets(['landscape'])).toMatchObject({ size: '1536x1024' });
  });

  it('auto → size=auto', () => {
    expect(resolvePresets(['auto'])).toMatchObject({ size: 'auto' });
  });

  it('hd → quality=high', () => {
    expect(resolvePresets(['hd'])).toMatchObject({ quality: 'high' });
  });

  it('med → quality=medium', () => {
    expect(resolvePresets(['med'])).toMatchObject({ quality: 'medium' });
  });

  it('landscape,hd → both applied', () => {
    expect(resolvePresets(['landscape', 'hd'])).toEqual({
      size: '1536x1024',
      quality: 'high',
    });
  });

  it('custom size: 2048x1024 passes through', () => {
    expect(resolvePresets(['2048x1024'])).toEqual({
      size: '2048x1024',
      quality: 'low',
    });
  });

  it('custom size + hd: 2048x2048,hd', () => {
    expect(resolvePresets(['2048x2048', 'hd'])).toEqual({
      size: '2048x2048',
      quality: 'high',
    });
  });

  it('custom size: 1920x1088 (16-aligned HD) passes through', () => {
    // 1920/16=120, 1088/16=68, aspect 1.76, total 2088960 — all in bounds.
    // 1920x1080 is a common request but 1080 is NOT /16, so use 1088.
    expect(resolvePresets(['1920x1088']).size).toBe('1920x1088');
  });

  it('custom size out of bounds (>3840 edge) → warn + default', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const r = resolvePresets(['4000x4000']);
    expect(r.size).toBe('1024x1024');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ wxh: '4000x4000' }),
      expect.stringContaining('out of bounds'),
    );
  });

  it('custom size not a multiple of 16 (1920x1080) → warn + default', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const r = resolvePresets(['1920x1080']);
    expect(r.size).toBe('1024x1024');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ wxh: '1920x1080' }),
      expect.stringContaining('out of bounds'),
    );
  });

  it('custom size violates aspect ratio >3:1 → warn + default', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const r = resolvePresets(['3200x800']);
    expect(r.size).toBe('1024x1024');
    expect(warn).toHaveBeenCalled();
  });

  it('two size tokens (named + custom) → conflict, default + warn', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const r = resolvePresets(['portrait', '2048x1024']);
    expect(r.size).toBe('1024x1024');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        sizeTokens: expect.arrayContaining(['1024x1536', '2048x1024']),
      }),
      expect.stringContaining('conflicting size presets'),
    );
  });

  it('conflicting size presets fall back to default + warn', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const r = resolvePresets(['portrait', 'landscape']);
    expect(r.size).toBe('1024x1024');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        sizeTokens: ['1024x1536', '1536x1024'],
      }),
      expect.stringContaining('conflicting size presets'),
    );
  });

  it('unknown preset is ignored with warning, others still apply', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const r = resolvePresets(['foobar', 'hd']);
    expect(r.quality).toBe('high');
    expect(r.size).toBe('1024x1024');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ preset: 'foobar' }),
      expect.stringContaining('unknown preset'),
    );
  });

  it('quality last-wins: med,hd → high', () => {
    expect(resolvePresets(['med', 'hd']).quality).toBe('high');
  });

  it('quality last-wins: hd,med → medium', () => {
    expect(resolvePresets(['hd', 'med']).quality).toBe('medium');
  });

  it('full kitchen sink: auto,hd → auto size + high quality', () => {
    expect(resolvePresets(['auto', 'hd'])).toEqual({
      size: 'auto',
      quality: 'high',
    });
  });
});

describe('transparent-as-prompt regression', () => {
  // The `transparent` token is no longer a preset — gpt-image-2 rejects
  // background=transparent outright. Make sure the parser doesn't accidentally
  // special-case it: it's now an unknown token, so the whole inner becomes
  // the prompt (same fallback that protects "sunset: golden hour" etc.).
  it('[[image:transparent: x]] is parsed as a prompt, not a preset', () => {
    const d = extractImageDirective('[[image:transparent: a unicorn]]');
    expect(d?.presets).toEqual([]);
    expect(d?.prompt).toBe('transparent: a unicorn');
  });
});
