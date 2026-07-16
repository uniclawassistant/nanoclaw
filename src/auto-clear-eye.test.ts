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
    getCachedEyeMessageIds: vi.fn(() => []),
    ...overrides,
  };
}

describe('autoClearEyeIfSet', () => {
  it('clears the 👀 on every message the cache reports', async () => {
    const setReaction = vi.fn();
    const channel = makeChannel({
      setReaction,
      getCachedEyeMessageIds: () => ['msg-1', 'msg-2'],
    });

    const cleared = await autoClearEyeIfSet(channel, 'tg:123');

    expect(cleared).toBe(2);
    expect(setReaction).toHaveBeenCalledWith('tg:123', 'msg-1', null);
    expect(setReaction).toHaveBeenCalledWith('tg:123', 'msg-2', null);
  });

  it('does nothing when no 👀 is cached', async () => {
    const setReaction = vi.fn();
    const channel = makeChannel({
      setReaction,
      getCachedEyeMessageIds: () => [],
    });

    const cleared = await autoClearEyeIfSet(channel, 'tg:123');

    expect(cleared).toBe(0);
    expect(setReaction).not.toHaveBeenCalled();
  });

  it('continues clearing after one message fails', async () => {
    const setReaction = vi
      .fn()
      .mockRejectedValueOnce(new Error('telegram 400'))
      .mockResolvedValueOnce(undefined);
    const channel = makeChannel({
      setReaction,
      getCachedEyeMessageIds: () => ['bad', 'good'],
    });

    const cleared = await autoClearEyeIfSet(channel, 'tg:123');

    expect(cleared).toBe(1);
    expect(setReaction).toHaveBeenCalledWith('tg:123', 'good', null);
  });

  it('returns 0 when channel lacks setReaction', async () => {
    const channel = makeChannel({
      setReaction: undefined,
      getCachedEyeMessageIds: () => ['msg-1'],
    });

    const cleared = await autoClearEyeIfSet(channel, 'tg:123');

    expect(cleared).toBe(0);
  });

  it('returns 0 when channel lacks getCachedEyeMessageIds', async () => {
    const setReaction = vi.fn();
    const channel = makeChannel({
      setReaction,
      getCachedEyeMessageIds: undefined,
    });

    const cleared = await autoClearEyeIfSet(channel, 'tg:123');

    expect(cleared).toBe(0);
    expect(setReaction).not.toHaveBeenCalled();
  });

  it('returns 0 when channel is undefined', async () => {
    const cleared = await autoClearEyeIfSet(undefined, 'tg:123');

    expect(cleared).toBe(0);
  });
});
