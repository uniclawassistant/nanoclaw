import { describe, it, expect, vi, beforeEach } from 'vitest';

import { computeApiTimeoutMs, resolvePresets } from './image-gen.js';
import { logger } from './logger.js';

beforeEach(() => {
  vi.clearAllMocks();
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
    const r = resolvePresets(['format=png', 'quality=high', 'size=1536x1024']);
    expect(r).toEqual({
      size: '1536x1024',
      quality: 'high',
      output_format: 'png',
    });
    expect(r.output_compression).toBeUndefined();
  });

  it('format=webp,compression=95,1024x1024', () => {
    expect(
      resolvePresets(['format=webp', 'compression=95', '1024x1024']),
    ).toEqual({
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

describe('computeApiTimeoutMs', () => {
  const DEFAULT = resolvePresets([]); // 1024x1024 medium jpeg 85%

  it('default (1024x1024 medium jpeg) generate → under floor, gets 120000ms', () => {
    // 60 + 40 * 1.05 * 2 * 1 * 1 = 144 → >120, under 600, so 144 * 1000
    expect(computeApiTimeoutMs(DEFAULT, false)).toBe(144_000);
  });

  it('tiny low-quality falls to floor 120000ms', () => {
    const r = resolvePresets(['quality=low']);
    // 60 + 40 * 1.05 * 1 = 102 → clamped to 120
    expect(computeApiTimeoutMs(r, false)).toBe(120_000);
  });

  it('isEdit adds 1.2× multiplier', () => {
    const gen = computeApiTimeoutMs(DEFAULT, false);
    const edit = computeApiTimeoutMs(DEFAULT, true);
    // 60 + 40 * 1.05 * 2 * 1.2 = 160.8 → 161000, vs 144000 for gen
    expect(edit).toBeGreaterThan(gen);
  });

  it('png adds 1.5× multiplier over jpeg of same size+quality', () => {
    const jpeg = computeApiTimeoutMs(
      resolvePresets(['portrait', 'quality=high']),
      false,
    );
    const png = computeApiTimeoutMs(
      resolvePresets(['portrait', 'quality=high', 'format=png']),
      false,
    );
    expect(png).toBeGreaterThan(jpeg);
  });

  it('caps at 600000ms for 3072x2304 high png edit (our prod timeout case)', () => {
    const r = resolvePresets(['3072x2304', 'quality=high', 'format=png']);
    expect(r).toEqual({
      size: '3072x2304',
      quality: 'high',
      output_format: 'png',
    });
    // Formula would yield 60 + 40 * 7.07 * 3.5 * 1.5 * 1.2 = ~1840s → cap 600
    expect(computeApiTimeoutMs(r, true)).toBe(600_000);
  });

  it('2048x2048 high jpeg generate is within the cap but comfortably above 180s', () => {
    const r = resolvePresets(['2048x2048', 'quality=high']);
    // 60 + 40 * 4.19 * 3.5 * 1 * 1 = ~647 → capped at 600
    const t = computeApiTimeoutMs(r, false);
    expect(t).toBeLessThanOrEqual(600_000);
    expect(t).toBeGreaterThan(180_000); // more budget than the old static 180s
  });

  it('size=auto uses 1.05 MP baseline', () => {
    const r = resolvePresets(['auto', 'quality=high']);
    // 60 + 40 * 1.05 * 3.5 * 1 = 207 → 207000
    expect(computeApiTimeoutMs(r, false)).toBe(207_000);
  });

  it('edit with modest params gets ~5x more than default generate (compound multipliers)', () => {
    // portrait high png edit: 60 + 40 * 1.57 * 3.5 * 1.5 * 1.2 = ~456s
    const r = resolvePresets(['portrait', 'quality=high', 'format=png']);
    const t = computeApiTimeoutMs(r, true);
    expect(t).toBeGreaterThan(400_000);
    expect(t).toBeLessThan(500_000);
  });
});
