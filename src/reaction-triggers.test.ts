import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetReactionTriggersLogState,
  loadReactionTriggers,
} from './reaction-triggers.js';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

let tmpDir: string;
let cfgFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reaction-triggers-'));
  cfgFile = path.join(tmpDir, 'reaction-triggers.json');
  _resetReactionTriggersLogState();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadReactionTriggers', () => {
  it('returns empty set when file is absent (fail-safe)', () => {
    const triggers = loadReactionTriggers(cfgFile);
    expect(triggers.size).toBe(0);
  });

  it('returns empty set when file is empty (fail-safe)', () => {
    fs.writeFileSync(cfgFile, '');
    const triggers = loadReactionTriggers(cfgFile);
    expect(triggers.size).toBe(0);
  });

  it('returns empty set on parse error (fail-safe)', () => {
    fs.writeFileSync(cfgFile, '{ not valid json');
    const triggers = loadReactionTriggers(cfgFile);
    expect(triggers.size).toBe(0);
  });

  it('returns empty set when content is not an array (fail-safe)', () => {
    fs.writeFileSync(cfgFile, JSON.stringify({ ok: ['✅'] }));
    const triggers = loadReactionTriggers(cfgFile);
    expect(triggers.size).toBe(0);
  });

  it('loads valid array of emojis', () => {
    fs.writeFileSync(cfgFile, JSON.stringify(['✅', '🔁']));
    const triggers = loadReactionTriggers(cfgFile);
    expect(triggers.has('✅')).toBe(true);
    expect(triggers.has('🔁')).toBe(true);
    expect(triggers.size).toBe(2);
  });

  it('drops non-string and empty entries', () => {
    fs.writeFileSync(
      cfgFile,
      JSON.stringify(['✅', '', 42, null, '🔁', undefined]),
    );
    const triggers = loadReactionTriggers(cfgFile);
    expect([...triggers].sort()).toEqual(['✅', '🔁'].sort());
  });

  it('hot-reloads on subsequent calls (no caching)', () => {
    fs.writeFileSync(cfgFile, JSON.stringify(['✅']));
    expect(loadReactionTriggers(cfgFile).has('✅')).toBe(true);
    expect(loadReactionTriggers(cfgFile).has('🔁')).toBe(false);

    fs.writeFileSync(cfgFile, JSON.stringify(['✅', '🔁']));
    expect(loadReactionTriggers(cfgFile).has('🔁')).toBe(true);

    fs.writeFileSync(cfgFile, JSON.stringify([]));
    expect(loadReactionTriggers(cfgFile).size).toBe(0);
  });

  it('returns empty set after file is deleted (fail-safe)', () => {
    fs.writeFileSync(cfgFile, JSON.stringify(['✅']));
    expect(loadReactionTriggers(cfgFile).size).toBe(1);

    fs.unlinkSync(cfgFile);
    expect(loadReactionTriggers(cfgFile).size).toBe(0);
  });
});
