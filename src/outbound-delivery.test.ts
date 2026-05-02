import { describe, it, expect, vi, beforeEach } from 'vitest';

import { _initTestDatabase, getMessageById, storeChatMetadata } from './db.js';
import { sendText } from './index.js';
import { logger } from './logger.js';
import {
  beginTurn,
  checkClassA,
  checkClassB,
  endTurn,
  recordOutbound,
} from './outbound-mismatch-hook.js';
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

// FED-9 — pre-flight hook: guard outbound mismatch (recap leak + silent
// deadlock). Phase 1 = log-only; both detectors emit a structured
// logger.warn with a raw sample for forensics.
describe('outbound-mismatch hook (FED-9)', () => {
  beforeEach(() => {
    endTurn('tg:123');
  });

  it('Class A: warns when agent emits trailing plain text after an outbound tool call', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const turn = beginTurn('tg:123', {
      groupName: 'unic',
      isUserFacing: true,
    });
    // Simulate an MCP send_message delivery earlier in the turn.
    recordOutbound('tg:123');
    expect(turn.outboundCount).toBe(1);

    const leak = 'Объяснил X, принял Y';
    checkClassA(turn, leak);

    expect(warn).toHaveBeenCalledTimes(1);
    const [data, msg] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(msg).toMatch(/CLASS_A_RECAP_LEAK/);
    expect(data.jid).toBe('tg:123');
    expect(data.group).toBe('unic');
    expect(data.leakedTextLen).toBe(leak.length);
    expect(data.leakedTextSample).toBe(leak);
  });

  it('Class B: warns when a user-facing turn ends with only <internal> output and no outbound', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const turn = beginTurn('tg:123', {
      groupName: 'unic',
      isUserFacing: true,
    });
    const raw =
      '<internal>thinking out loud, forgot to send_message</internal>';

    checkClassB(turn, raw, { hadError: false });

    expect(warn).toHaveBeenCalledTimes(1);
    const [data, msg] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(msg).toMatch(/CLASS_B_SILENT_DEADLOCK/);
    expect(data.internalBlockCount).toBe(1);
    expect(data.rawLen).toBe(raw.length);
    expect(data.strippedLen).toBe(0);
    expect(data.rawSample).toContain('<internal>');
  });

  it('Class B exception: stays silent for non-user-facing turns (scheduled tasks)', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const turn = beginTurn('tg:123', {
      groupName: 'unic',
      isUserFacing: false,
    });

    checkClassB(turn, '<internal>scheduled-task no-op</internal>', {
      hadError: false,
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it('healthy paths: no warnings for send_message-only or final-text-only turns', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    // (a) send_message tool call only, no trailing plain text.
    const turnA = beginTurn('tg:123', {
      groupName: 'unic',
      isUserFacing: true,
    });
    recordOutbound('tg:123');
    checkClassA(turnA, ''); // empty trailing text → no leak
    checkClassB(turnA, '<internal>internal note</internal>', {
      hadError: false,
    });
    endTurn('tg:123');

    // (b) final-text-only: streaming callback delivers and bumps the counter
    // before checkClassB runs, so isUserFacing + outboundCount=1 is healthy.
    const turnB = beginTurn('tg:123', {
      groupName: 'unic',
      isUserFacing: true,
    });
    // Simulate streaming-callback delivering the final text.
    turnB.outboundCount++;
    checkClassB(turnB, 'hello there', { hadError: false });

    expect(warn).not.toHaveBeenCalled();
  });

  it('Class B raw-buffer truncation: rawSample is capped at 2KB while rawLen reflects full length', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const turn = beginTurn('tg:123', {
      groupName: 'unic',
      isUserFacing: true,
    });
    // 3KB of <internal> content — large enough to exceed the 2KB sample cap.
    const filler = 'x'.repeat(3000);
    const raw = `<internal>${filler}</internal>`;

    checkClassB(turn, raw, { hadError: false });

    expect(warn).toHaveBeenCalledTimes(1);
    const [data] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(data.rawLen).toBe(raw.length);
    expect(typeof data.rawSample).toBe('string');
    expect((data.rawSample as string).length).toBe(2000);
    expect(data.internalBlockCount).toBe(1);
  });
});
