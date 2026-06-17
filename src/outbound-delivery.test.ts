import { describe, it, expect, vi, beforeEach } from 'vitest';

import { ASSISTANT_NAME } from './config.js';
import { _initTestDatabase, getMessageById, storeChatMetadata } from './db.js';
import { sendText } from './index.js';
import { logger } from './logger.js';
import {
  _resetSilentFinishCounter,
  beginTurn,
  checkClassA,
  checkClassB,
  endTurn,
  recordOutbound,
  recordReaction,
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
      undefined,
    );
  });

  it('threads the optional message format through to the channel', async () => {
    const channel = makeMockChannel();

    await sendText(channel, 'tg:123', '| A | B |', undefined, 'rich');

    expect(channel.sendMessage).toHaveBeenCalledWith(
      'tg:123',
      '| A | B |',
      undefined,
      'rich',
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

  it('FED-30 signal (b): react-as-reply (👌) suppresses Class B', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const turn = beginTurn('tg:123', {
      groupName: 'unic',
      isUserFacing: true,
    });
    // Agent answered the user-facing message with a terminal reaction only.
    recordReaction('tg:123', '👌');

    checkClassB(turn, '<internal>ack via react</internal>', {
      hadError: false,
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it('FED-30: a bare 👀 working-marker does NOT suppress Class B (scar preserved)', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const turn = beginTurn('tg:123', {
      groupName: 'unic',
      isUserFacing: true,
    });
    // 👀 is "I picked it up" — it auto-clears on turn end, so a freeze after it
    // still leaves the user staring at silence. Must still trip Class B.
    recordReaction('tg:123', '👀');

    checkClassB(turn, '<internal>froze after 👀</internal>', {
      hadError: false,
    });

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('FED-30: react(null) clear is housekeeping, does NOT suppress Class B', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const turn = beginTurn('tg:123', {
      groupName: 'unic',
      isUserFacing: true,
    });
    recordReaction('tg:123', null);

    checkClassB(turn, '', { hadError: false });

    expect(warn).toHaveBeenCalledTimes(1);
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

// FED-16 Phase 2: on Class B detection the host ships a `[host] ...` ack-stub
// through the supplied sendAckStub callback so the user sees something instead
// of silence, and the in-memory counter logs per-hour and warns on threshold
// exceed.
describe('outbound-mismatch hook — Phase 2 ack-stub (FED-16)', () => {
  beforeEach(() => {
    endTurn('tg:123');
    _resetSilentFinishCounter();
    delete process.env.SILENT_FINISH_THRESHOLD_PER_HOUR;
  });

  // FED-31: a single neutral string is used regardless of what the silent turn
  // contained. The earlier FED-16 design embedded the first 200 chars of the
  // `<internal>` block payload verbatim into the user-facing stub, which
  // leaked the agent's private reasoning into the chat. The hook now never
  // reads the content of `<internal>` blocks for delivery purposes.
  // The name is env-aware (ASSISTANT_NAME): «Юник» on Unic, «Шеф» on Chef.
  const NEUTRAL_STUB = `[host] ${ASSISTANT_NAME} завершил ход, не отправив сообщения в чат.`;

  it('ships the neutral FED-31 stub when Class B fires', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    const sendAckStub = vi.fn().mockResolvedValue(undefined);
    const turn = beginTurn('tg:123', {
      groupName: 'unic',
      isUserFacing: true,
    });

    await checkClassB(
      turn,
      '<internal>забыл написать в чат, виноват</internal>',
      { hadError: false, sendAckStub },
    );

    expect(sendAckStub).toHaveBeenCalledTimes(1);
    expect(sendAckStub).toHaveBeenCalledWith(NEUTRAL_STUB);
  });

  it('FED-31: never leaks <internal> content verbatim, even for a long internal block', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    const sendAckStub = vi.fn().mockResolvedValue(undefined);
    const turn = beginTurn('tg:123', {
      groupName: 'unic',
      isUserFacing: true,
    });
    const secret = 'секретная-приватная-заметка'.repeat(20);

    await checkClassB(turn, `<internal>${secret}</internal>`, {
      hadError: false,
      sendAckStub,
    });

    const [text] = sendAckStub.mock.calls[0] as [string];
    expect(text).toBe(NEUTRAL_STUB);
    expect(text).not.toContain('секретная');
    expect(text).not.toContain('внутренняя записка');
  });

  it('ships the same neutral stub when raw has no internal block', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    const sendAckStub = vi.fn().mockResolvedValue(undefined);
    const turn = beginTurn('tg:123', {
      groupName: 'unic',
      isUserFacing: true,
    });

    await checkClassB(turn, '', { hadError: false, sendAckStub });

    expect(sendAckStub).toHaveBeenCalledWith(NEUTRAL_STUB);
  });

  it('ships the same neutral stub when the internal block is whitespace-only', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    const sendAckStub = vi.fn().mockResolvedValue(undefined);
    const turn = beginTurn('tg:123', {
      groupName: 'unic',
      isUserFacing: true,
    });

    await checkClassB(turn, '<internal>   \n  </internal>', {
      hadError: false,
      sendAckStub,
    });

    expect(sendAckStub).toHaveBeenCalledWith(NEUTRAL_STUB);
  });

  it('does not invoke sendAckStub on healthy turns (no Class B trigger)', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    const sendAckStub = vi.fn().mockResolvedValue(undefined);
    const turn = beginTurn('tg:123', {
      groupName: 'unic',
      isUserFacing: true,
    });
    turn.outboundCount++;

    await checkClassB(turn, '<internal>note</internal>', {
      hadError: false,
      sendAckStub,
    });

    expect(sendAckStub).not.toHaveBeenCalled();
  });

  it('FED-30: does not ship an ack-stub when the turn was answered by a terminal react', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    const sendAckStub = vi.fn().mockResolvedValue(undefined);
    const turn = beginTurn('tg:123', {
      groupName: 'unic',
      isUserFacing: true,
    });
    recordReaction('tg:123', '🫡');

    await checkClassB(turn, '', { hadError: false, sendAckStub });

    expect(sendAckStub).not.toHaveBeenCalled();
  });

  it('FED-30: still ships an ack-stub after a bare 👀 + silent finish', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    const sendAckStub = vi.fn().mockResolvedValue(undefined);
    const turn = beginTurn('tg:123', {
      groupName: 'unic',
      isUserFacing: true,
    });
    recordReaction('tg:123', '👀');

    await checkClassB(turn, '', { hadError: false, sendAckStub });

    expect(sendAckStub).toHaveBeenCalledWith(NEUTRAL_STUB);
  });

  it('increments silentFinishCount and logs per-hour breakdown on each trigger', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const sendAckStub = vi.fn().mockResolvedValue(undefined);

    for (let i = 0; i < 3; i++) {
      const turn = beginTurn('tg:123', {
        groupName: 'unic',
        isUserFacing: true,
      });
      await checkClassB(turn, '<internal>x</internal>', {
        hadError: false,
        sendAckStub,
      });
      endTurn('tg:123');
    }

    const counterCalls = info.mock.calls.filter(
      ([, msg]) =>
        typeof msg === 'string' && msg.startsWith('silent_finish_count='),
    );
    expect(counterCalls.length).toBe(3);
    const [data, msg] = counterCalls[2] as [Record<string, unknown>, string];
    expect(data.total).toBe(3);
    expect(data.hourCount).toBe(3);
    expect(typeof data.hour).toBe('string');
    expect(msg).toMatch(/silent_finish_count=3/);
    expect(msg).toMatch(/total=3/);
    expect(sendAckStub).toHaveBeenCalledTimes(3);
  });

  it('per-Stop streaming flow (FED-17): ack-stub fires only on the silent Stop, state resets between turns', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    const sendAckStub = vi.fn().mockResolvedValue(undefined);
    const turn = beginTurn('tg:123', {
      groupName: 'unic',
      isUserFacing: true,
    });

    let raw = '';
    const internalRx = /<internal>[\s\S]*?<\/internal>/g;
    type Event = { type: 'text'; text: string } | { type: 'stop' };
    const events: Event[] = [
      { type: 'text', text: 'Hello' },
      { type: 'stop' },
      { type: 'text', text: '<internal>only</internal>' },
      { type: 'stop' },
      { type: 'text', text: 'Sorry, here is reply' },
      { type: 'stop' },
    ];

    for (const ev of events) {
      if (ev.type === 'text') {
        raw += ev.text;
        const stripped = ev.text.replace(internalRx, '').trim();
        if (stripped) {
          checkClassA(turn, stripped);
          turn.outboundCount++;
        }
      } else {
        await checkClassB(turn, raw, {
          hadError: false,
          sendAckStub,
        });
        turn.outboundCount = 0;
        raw = '';
      }
    }

    expect(sendAckStub).toHaveBeenCalledTimes(1);
    const [text] = sendAckStub.mock.calls[0] as [string];
    expect(text).toBe(NEUTRAL_STUB);
    // FED-31: even though the silent stop's raw buffer contained
    // <internal>only</internal>, the stub must not echo any of it.
    expect(text).not.toContain('only');
  });

  it('warns "excess silent finishes" when hourly count exceeds SILENT_FINISH_THRESHOLD_PER_HOUR', async () => {
    process.env.SILENT_FINISH_THRESHOLD_PER_HOUR = '2';
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const sendAckStub = vi.fn().mockResolvedValue(undefined);

    for (let i = 0; i < 3; i++) {
      const turn = beginTurn('tg:123', {
        groupName: 'unic',
        isUserFacing: true,
      });
      await checkClassB(turn, '<internal>x</internal>', {
        hadError: false,
        sendAckStub,
      });
      endTurn('tg:123');
    }

    const excessCalls = warn.mock.calls.filter(
      ([, msg]) => msg === 'excess silent finishes',
    );
    expect(excessCalls.length).toBe(1);
    const [data] = excessCalls[0] as [Record<string, unknown>, string];
    expect(data.threshold).toBe(2);
    expect(data.hourCount).toBe(3);
  });

  // FED-31: turn that streamed real (non-`<internal>`) prose at any position
  // — including a text-before-tool-call preamble whose final `result` carries
  // no text — must NOT trigger the silence-stub. The host wiring relies on
  // the streaming callback bumping `outboundCount` for every non-internal
  // chunk; with the agent-runner now emitting per-text-block (commit e781ab1),
  // a preamble before a tool_use is reliably counted and Class B stays quiet.
  it('FED-31: streamed real prose before a tool_use does not trigger the silence-stub', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    const sendAckStub = vi.fn().mockResolvedValue(undefined);
    const turn = beginTurn('tg:123', {
      groupName: 'unic',
      isUserFacing: true,
    });

    // Container streams: text chunk arrives first (preamble before a tool),
    // host strips <internal>, sees non-empty stripped, ships it and bumps
    // outboundCount. Then `turnEnd` arrives with no further text.
    let raw = '';
    const internalRx = /<internal>[\s\S]*?<\/internal>/g;
    const preamble = 'Сейчас посмотрю логи.';
    raw += preamble;
    const stripped = preamble.replace(internalRx, '').trim();
    if (stripped) {
      checkClassA(turn, stripped);
      turn.outboundCount++;
    }
    await checkClassB(turn, raw, { hadError: false, sendAckStub });

    expect(sendAckStub).not.toHaveBeenCalled();
  });
});
