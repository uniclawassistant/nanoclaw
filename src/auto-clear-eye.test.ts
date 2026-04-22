import { describe, it, expect, vi } from 'vitest';

import { autoClearEyeIfSet } from './auto-clear-eye.js';
import { Channel } from './types.js';

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    name: 'telegram',
    connect: vi.fn(),
    sendMessage: vi.fn(),
    isConnected: () => true,
    ownsJid: (jid) => jid.startsWith('tg:'),
    disconnect: vi.fn(),
    setReaction: vi.fn(),
    getCachedReaction: vi.fn(() => undefined),
    ...overrides,
  };
}

describe('autoClearEyeIfSet', () => {
  it('clears reaction when cache shows 👀', async () => {
    const setReaction = vi.fn();
    const channel = makeChannel({
      setReaction,
      getCachedReaction: () => '👀',
    });

    const cleared = await autoClearEyeIfSet(channel, () => 'msg-42', 'tg:123');

    expect(cleared).toBe(true);
    expect(setReaction).toHaveBeenCalledWith('tg:123', 'msg-42', null);
  });

  it('skips when cache shows a different emoji', async () => {
    const setReaction = vi.fn();
    const channel = makeChannel({
      setReaction,
      getCachedReaction: () => '👌',
    });

    const cleared = await autoClearEyeIfSet(channel, () => 'msg-42', 'tg:123');

    expect(cleared).toBe(false);
    expect(setReaction).not.toHaveBeenCalled();
  });

  it('skips when cache shows null (previously cleared)', async () => {
    const setReaction = vi.fn();
    const channel = makeChannel({
      setReaction,
      getCachedReaction: () => null,
    });

    const cleared = await autoClearEyeIfSet(channel, () => 'msg-42', 'tg:123');

    expect(cleared).toBe(false);
    expect(setReaction).not.toHaveBeenCalled();
  });

  it('skips when cache is undefined (no state recorded)', async () => {
    const setReaction = vi.fn();
    const channel = makeChannel({
      setReaction,
      getCachedReaction: () => undefined,
    });

    const cleared = await autoClearEyeIfSet(channel, () => 'msg-42', 'tg:123');

    expect(cleared).toBe(false);
    expect(setReaction).not.toHaveBeenCalled();
  });

  it('skips when there is no recent user message', async () => {
    const setReaction = vi.fn();
    const channel = makeChannel({
      setReaction,
      getCachedReaction: () => '👀',
    });

    const cleared = await autoClearEyeIfSet(channel, () => null, 'tg:123');

    expect(cleared).toBe(false);
    expect(setReaction).not.toHaveBeenCalled();
  });

  it('skips when channel lacks setReaction', async () => {
    const channel = makeChannel({
      setReaction: undefined,
      getCachedReaction: () => '👀',
    });

    const cleared = await autoClearEyeIfSet(channel, () => 'msg-42', 'tg:123');

    expect(cleared).toBe(false);
  });

  it('skips when channel lacks getCachedReaction', async () => {
    const setReaction = vi.fn();
    const channel = makeChannel({
      setReaction,
      getCachedReaction: undefined,
    });

    const cleared = await autoClearEyeIfSet(channel, () => 'msg-42', 'tg:123');

    expect(cleared).toBe(false);
    expect(setReaction).not.toHaveBeenCalled();
  });

  it('returns false when channel is undefined', async () => {
    const cleared = await autoClearEyeIfSet(
      undefined,
      () => 'msg-42',
      'tg:123',
    );

    expect(cleared).toBe(false);
  });
});
