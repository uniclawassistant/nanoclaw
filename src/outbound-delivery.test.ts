import { describe, it, expect, vi, beforeEach } from 'vitest';

import { _initTestDatabase, getMessageById, storeChatMetadata } from './db.js';
import { sendText } from './index.js';
import type { Channel } from './types.js';

function makeMockChannel(): Channel {
  return {
    name: 'test',
    connect: vi.fn(),
    isConnected: () => true,
    ownsJid: () => true,
    disconnect: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue('m-100'),
  };
}

beforeEach(() => {
  _initTestDatabase();
  storeChatMetadata('tg:123', '2026-04-23T00:00:00.000Z');
  vi.clearAllMocks();
});

describe('sendText', () => {
  it('delegates to channel.sendMessage and records the outgoing message', async () => {
    const channel = makeMockChannel();

    await sendText(channel, 'tg:123', 'hello there');

    expect(channel.sendMessage).toHaveBeenCalledWith(
      'tg:123',
      'hello there',
      undefined,
    );
    const stored = getMessageById('m-100', 'tg:123');
    expect(stored).not.toBeNull();
    expect(stored?.text).toBe('hello there');
    expect(stored?.type).toBe('text');
    expect(stored?.direction).toBe('out');
  });

  it('threads the optional threadId through to the channel', async () => {
    const channel = makeMockChannel();

    await sendText(channel, 'tg:123', 'in topic 42', '42');

    expect(channel.sendMessage).toHaveBeenCalledWith(
      'tg:123',
      'in topic 42',
      '42',
    );
  });

  it('does not record when the channel returns no message_id', async () => {
    const channel = makeMockChannel();
    (channel.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined,
    );

    await sendText(channel, 'tg:123', 'lost in the void');

    // No message_id → nothing to look up. getMessageById is the canonical
    // store; if recordOutgoing accidentally writes a row with id="undefined"
    // this would fail.
    expect(getMessageById('undefined', 'tg:123')).toBeNull();
  });

  it('does not pass any [[image:]] / [[tts:]] syntax to a parser — the deprecated parsers are gone, raw text ships through', async () => {
    const channel = makeMockChannel();

    // Verifies the hard cutoff: legacy bracketed text, if it appears, is
    // delivered as a literal string instead of being parsed and routed
    // through the image / voice pipelines. New code uses MCP tools
    // (generate_image / edit_image / send_image / send_voice) directly.
    await sendText(channel, 'tg:123', '[[image: a cat]] hello');

    expect(channel.sendMessage).toHaveBeenCalledWith(
      'tg:123',
      '[[image: a cat]] hello',
      undefined,
    );
  });
});
