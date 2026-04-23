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

  it('three presets: [[image:auto,hd,transparent: prompt]]', () => {
    const d = extractImageDirective('[[image:auto,hd,transparent: a logo]]');
    expect(d?.presets).toEqual(['auto', 'hd', 'transparent']);
    expect(d?.prompt).toBe('a logo');
  });

  it('preset-like prefix with uppercase is treated as prompt', () => {
    // "Plot: a graph" — uppercase P → not a preset list
    const d = extractImageDirective('[[image: Plot: a graph]]');
    expect(d?.presets).toEqual([]);
    expect(d?.prompt).toBe('Plot: a graph');
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

  it('transparent → background + png', () => {
    expect(resolvePresets(['transparent'])).toEqual({
      size: '1024x1024',
      quality: 'low',
      background: 'transparent',
      output_format: 'png',
    });
  });

  it('conflicting size presets fall back to default + warn', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const r = resolvePresets(['portrait', 'landscape']);
    expect(r.size).toBe('1024x1024');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ sizeTokens: ['portrait', 'landscape'] }),
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

  it('full kitchen sink: auto,hd,transparent', () => {
    expect(resolvePresets(['auto', 'hd', 'transparent'])).toEqual({
      size: 'auto',
      quality: 'high',
      background: 'transparent',
      output_format: 'png',
    });
  });
});
