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

  it('single size preset: [[image:portrait: prompt]]', () => {
    const d = extractImageDirective('[[image:portrait: a quiet lake]]');
    expect(d?.presets).toEqual(['portrait']);
    expect(d?.prompt).toBe('a quiet lake');
  });

  it('size + keyword: [[image:portrait,quality=high: prompt]]', () => {
    const d = extractImageDirective(
      '[[image:portrait,quality=high: a quiet lake]]',
    );
    expect(d?.presets).toEqual(['portrait', 'quality=high']);
    expect(d?.prompt).toBe('a quiet lake');
  });

  it('parser accepts custom WxH alongside named tokens', () => {
    const d = extractImageDirective(
      '[[image:2048x1536,quality=high: a poster]]',
    );
    expect(d?.presets).toEqual(['2048x1536', 'quality=high']);
    expect(d?.prompt).toBe('a poster');
  });

  it('three keywords: format=png,quality=high,size=1536x1024', () => {
    const d = extractImageDirective(
      '[[image:format=png,quality=high,size=1536x1024: a diagram]]',
    );
    expect(d?.presets).toEqual([
      'format=png',
      'quality=high',
      'size=1536x1024',
    ]);
    expect(d?.prompt).toBe('a diagram');
  });

  it('webp with compression: format=webp,compression=95,1024x1024', () => {
    const d = extractImageDirective(
      '[[image:format=webp,compression=95,1024x1024: a logo]]',
    );
    expect(d?.presets).toEqual([
      'format=webp',
      'compression=95',
      '1024x1024',
    ]);
    expect(d?.prompt).toBe('a logo');
  });

  it('preset-like prefix with uppercase is treated as prompt', () => {
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

  it('unknown keyword key stays part of the prompt (author=Fedor: bio)', () => {
    // `author` isn't a known keyword key → whole inner becomes the prompt.
    // Protects prompts that happen to contain lowercase-word=value: patterns.
    const d = extractImageDirective('[[image: author=Fedor: biography]]');
    expect(d?.presets).toEqual([]);
    expect(d?.prompt).toBe('author=Fedor: biography');
  });

  it('mixed known+unknown preset tokens → not parsed as presets', () => {
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

  it('edit with keyword params', () => {
    const d = extractImageDirective(
      '[[image-edit:format=png,quality=high: attachments/foo.jpg | bluer]]',
    );
    expect(d?.type).toBe('edit');
    expect(d?.presets).toEqual(['format=png', 'quality=high']);
    expect(d?.sourcePath).toBe('attachments/foo.jpg');
    expect(d?.prompt).toBe('bluer');
  });

  it('edit without presets still works', () => {
    const d = extractImageDirective(
      '[[image-edit: attachments/foo.jpg | bluer]]',
    );
    expect(d?.type).toBe('edit');
    expect(d?.presets).toEqual([]);
    expect(d?.sourcePath).toBe('attachments/foo.jpg');
    expect(d?.prompt).toBe('bluer');
  });
});

describe('resolvePresets — defaults', () => {
  it('empty presets → JPEG 85%, quality=medium, 1024x1024', () => {
    expect(resolvePresets([])).toEqual({
      size: '1024x1024',
      quality: 'medium',
      output_format: 'jpeg',
      output_compression: 85,
    });
    expect(resolvePresets(undefined)).toEqual({
      size: '1024x1024',
      quality: 'medium',
      output_format: 'jpeg',
      output_compression: 85,
    });
  });
});

describe('resolvePresets — named size tokens', () => {
  it('portrait → 1024x1536', () => {
    expect(resolvePresets(['portrait']).size).toBe('1024x1536');
  });

  it('landscape → 1536x1024', () => {
    expect(resolvePresets(['landscape']).size).toBe('1536x1024');
  });

  it('square → 1024x1024', () => {
    expect(resolvePresets(['square']).size).toBe('1024x1024');
  });

  it('auto → size=auto', () => {
    expect(resolvePresets(['auto']).size).toBe('auto');
  });
});

describe('resolvePresets — custom WxH tokens', () => {
  it('2048x1024 passes through', () => {
    expect(resolvePresets(['2048x1024']).size).toBe('2048x1024');
  });

  it('1920x1088 (16-aligned HD) passes through', () => {
    expect(resolvePresets(['1920x1088']).size).toBe('1920x1088');
  });

  it('2048x2048 passes through', () => {
    expect(resolvePresets(['2048x2048']).size).toBe('2048x2048');
  });

  it('out of bounds (>3840 edge) → warn + default', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    expect(resolvePresets(['4000x4000']).size).toBe('1024x1024');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ wxh: '4000x4000' }),
      expect.stringContaining('out of bounds'),
    );
  });

  it('not a multiple of 16 (1920x1080) → warn + default', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    expect(resolvePresets(['1920x1080']).size).toBe('1024x1024');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ wxh: '1920x1080' }),
      expect.stringContaining('out of bounds'),
    );
  });

  it('aspect ratio >3:1 (3200x800) → warn + default', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    expect(resolvePresets(['3200x800']).size).toBe('1024x1024');
    expect(warn).toHaveBeenCalled();
  });
});

describe('resolvePresets — keyword params', () => {
  it('format=png', () => {
    expect(resolvePresets(['format=png'])).toMatchObject({
      output_format: 'png',
    });
  });

  it('format=webp', () => {
    expect(resolvePresets(['format=webp'])).toMatchObject({
      output_format: 'webp',
    });
  });

  it('format=jpeg explicit is fine', () => {
    expect(resolvePresets(['format=jpeg'])).toMatchObject({
      output_format: 'jpeg',
      output_compression: 85,
    });
  });

  it('quality=high', () => {
    expect(resolvePresets(['quality=high']).quality).toBe('high');
  });

  it('quality=low', () => {
    expect(resolvePresets(['quality=low']).quality).toBe('low');
  });

  it('compression=95', () => {
    expect(resolvePresets(['compression=95']).output_compression).toBe(95);
  });

  it('size=1536x1024 (via keyword)', () => {
    expect(resolvePresets(['size=1536x1024']).size).toBe('1536x1024');
  });

  it('size=portrait (named via keyword)', () => {
    expect(resolvePresets(['size=portrait']).size).toBe('1024x1536');
  });

  it('full combo: format=png,quality=high,size=1536x1024 → PNG strips compression', () => {
    const r = resolvePresets([
      'format=png',
      'quality=high',
      'size=1536x1024',
    ]);
    expect(r).toEqual({
      size: '1536x1024',
      quality: 'high',
      output_format: 'png',
    });
    expect(r.output_compression).toBeUndefined();
  });

  it('format=webp,compression=95,1024x1024', () => {
    expect(resolvePresets(['format=webp', 'compression=95', '1024x1024'])).toEqual({
      size: '1024x1024',
      quality: 'medium',
      output_format: 'webp',
      output_compression: 95,
    });
  });

  it('size token + size= keyword → conflict, default + warn', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const r = resolvePresets(['portrait', 'size=1536x1024']);
    expect(r.size).toBe('1024x1024');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        sizeTokens: ['1024x1536', '1536x1024'],
      }),
      expect.stringContaining('conflicting size'),
    );
  });
});

describe('resolvePresets — keyword validation', () => {
  it('unknown format value → warn, ignore, default jpeg stays', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const r = resolvePresets(['format=tiff']);
    expect(r.output_format).toBe('jpeg');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'format', value: 'tiff' }),
      expect.stringContaining('unknown format value'),
    );
  });

  it('unknown quality value → warn, ignore, default medium stays', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const r = resolvePresets(['quality=ultra']);
    expect(r.quality).toBe('medium');
    expect(warn).toHaveBeenCalled();
  });

  it('compression out of range (0) → warn, ignore', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const r = resolvePresets(['compression=0']);
    expect(r.output_compression).toBe(85);
    expect(warn).toHaveBeenCalled();
  });

  it('compression out of range (101) → warn, ignore', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    expect(resolvePresets(['compression=101']).output_compression).toBe(85);
    expect(warn).toHaveBeenCalled();
  });

  it('format=png + compression=X → warn, PNG strips compression entirely', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const r = resolvePresets(['format=png', 'compression=90']);
    expect(r.output_format).toBe('png');
    expect(r.output_compression).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ compression: 90 }),
      expect.stringContaining('no effect with format=png'),
    );
  });

  it('last-write-wins for same keyword key', () => {
    expect(resolvePresets(['quality=low', 'quality=high']).quality).toBe(
      'high',
    );
    expect(resolvePresets(['format=jpeg', 'format=png']).output_format).toBe(
      'png',
    );
  });

  it('size=invalid → warn, default size stays', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const r = resolvePresets(['size=1920x1080']);
    expect(r.size).toBe('1024x1024');
    expect(warn).toHaveBeenCalled();
  });
});

describe('resolvePresets — conflicts & edge cases', () => {
  it('conflicting named sizes fall back to default + warn', () => {
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

  it('named + custom size conflict', () => {
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

  it('unknown keyword key passed programmatically → warn, others apply', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const r = resolvePresets(['foo=bar', 'quality=high']);
    expect(r.quality).toBe('high');
    expect(warn).toHaveBeenCalled();
  });
});

describe('transparent-as-prompt regression', () => {
  it('[[image:transparent: x]] is parsed as a prompt, not a preset', () => {
    const d = extractImageDirective('[[image:transparent: a unicorn]]');
    expect(d?.presets).toEqual([]);
    expect(d?.prompt).toBe('transparent: a unicorn');
  });
});
