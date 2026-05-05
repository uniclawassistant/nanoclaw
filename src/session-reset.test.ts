import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';

import { resetGroupSession } from './session-reset.js';

// containerNamePrefix is imported from container-runner — keep this dep light
// instead of pulling in the full module. The mock mirrors the real sanitizer.
vi.mock('./container-runner.js', () => ({
  containerNamePrefix: (folder: string) =>
    `nanoclaw-${folder.replace(/[^a-zA-Z0-9-]/g, '-')}-`,
}));

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-session-reset-test/data',
}));

describe('resetGroupSession', () => {
  let clearInMemorySession: ReturnType<typeof vi.fn>;
  let deleteDbSession: ReturnType<typeof vi.fn>;
  let log: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearInMemorySession = vi.fn();
    deleteDbSession = vi.fn();
    log = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("mode='new' stops the matching container and full-resets state", () => {
    // The container list intentionally includes a non-matching line and the
    // real (sanitized) name to prove the prefix match works for underscores.
    const containerListing =
      'nanoclaw-other-group-1700000000000  nanoclaw-agent:latest  running\n' +
      'nanoclaw-telegram-fedor-test-1777936420362  nanoclaw-agent-unic:latest  running\n';
    const exec = vi.fn((cmd: string) =>
      cmd.includes('container list') ? containerListing : '',
    );

    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    resetGroupSession('telegram_fedor-test', 'new', {
      clearInMemorySession,
      deleteDbSession,
      execSync: exec,
      log,
    });

    const stopCalls = exec.mock.calls.filter((c) =>
      String(c[0]).includes('container stop'),
    );
    expect(stopCalls).toHaveLength(1);
    expect(String(stopCalls[0]![0])).toContain(
      'nanoclaw-telegram-fedor-test-1777936420362',
    );
    expect(String(stopCalls[0]![0])).not.toContain('nanoclaw-other-group-');

    expect(clearInMemorySession).toHaveBeenCalledWith('telegram_fedor-test');
    expect(deleteDbSession).toHaveBeenCalledWith('telegram_fedor-test');
  });

  it("mode='new' deletes JSONL session files in the project dir", () => {
    const exec = vi.fn(() => '');
    const unlink = vi.spyOn(fs, 'unlinkSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readdirSync').mockReturnValue([
      'abc.jsonl',
      'README.md',
      'def.jsonl',
    ] as unknown as fs.Dirent[]);

    resetGroupSession('main', 'new', {
      clearInMemorySession,
      deleteDbSession,
      execSync: exec,
      log,
    });

    const unlinked = unlink.mock.calls.map((c) => String(c[0]));
    expect(unlinked).toHaveLength(2);
    expect(unlinked.every((p) => p.endsWith('.jsonl'))).toBe(true);
    expect(unlinked.some((p) => p.endsWith('abc.jsonl'))).toBe(true);
    expect(unlinked.some((p) => p.endsWith('def.jsonl'))).toBe(true);
  });

  it("mode='restart' stops the container but preserves session state", () => {
    const containerListing =
      'nanoclaw-main-1777936420362  nanoclaw-agent:latest  running\n';
    const exec = vi.fn((cmd: string) =>
      cmd.includes('container list') ? containerListing : '',
    );
    const unlink = vi.spyOn(fs, 'unlinkSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    resetGroupSession('main', 'restart', {
      clearInMemorySession,
      deleteDbSession,
      execSync: exec,
      log,
    });

    const stopCalls = exec.mock.calls.filter((c) =>
      String(c[0]).includes('container stop'),
    );
    expect(stopCalls).toHaveLength(1);
    // Critical for mode='restart': SDK state stays intact so the next message
    // resumes mid-conversation.
    expect(clearInMemorySession).not.toHaveBeenCalled();
    expect(deleteDbSession).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
  });

  it('swallows execSync errors when no container is running', () => {
    const exec = vi.fn(() => {
      throw new Error('container CLI not available');
    });
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    expect(() =>
      resetGroupSession('main', 'new', {
        clearInMemorySession,
        deleteDbSession,
        execSync: exec,
        log,
      }),
    ).not.toThrow();
    // mode='new' still finishes the session-state clearing even if no
    // container was found.
    expect(clearInMemorySession).toHaveBeenCalledWith('main');
    expect(deleteDbSession).toHaveBeenCalledWith('main');
  });
});
