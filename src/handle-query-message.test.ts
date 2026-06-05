import { describe, it, expect } from 'vitest';

import {
  handleQueryMessage,
  type AgentRunnerOutput,
  type QueryLoopState,
  type QueryMessage,
} from '../container/agent-runner/src/handle-query-message.js';

function makeHarness() {
  const emitted: AgentRunnerOutput[] = [];
  const logs: string[] = [];
  const state: QueryLoopState = { messageCount: 0, resultCount: 0 };
  const deps = {
    emit: (out: AgentRunnerOutput) => emitted.push(out),
    log: (msg: string) => logs.push(msg),
  };
  return { emitted, logs, state, deps };
}

async function* mockSdkStream(messages: QueryMessage[]) {
  for (const m of messages) yield m;
}

function assistant(
  uuid: string,
  content: Array<
    { type: 'text'; text: string } | { type: 'tool_use'; name: string }
  >,
  extras: Record<string, unknown> = {},
): QueryMessage {
  return {
    type: 'assistant',
    uuid,
    parent_tool_use_id: null,
    message: { content, ...extras },
  };
}

describe('handleQueryMessage (FED-18 per-Stop turnEnd)', () => {
  it('emits turnEnd:true exactly once per result message in a streamed sequence', async () => {
    const { emitted, state, deps } = makeHarness();
    const sequence: QueryMessage[] = [
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      assistant('u1', [{ type: 'text', text: 'first' }]),
      { type: 'result', subtype: 'success', result: 'first' },
      assistant('u2', [{ type: 'text', text: 'second' }]),
      { type: 'result', subtype: 'success', result: 'second' },
      assistant('u3', [{ type: 'text', text: 'third' }]),
      { type: 'result', subtype: 'success', result: 'third' },
    ];

    for await (const message of mockSdkStream(sequence)) {
      handleQueryMessage(message, state, deps);
    }

    expect(state.resultCount).toBe(3);
    // Text streamed per assistant block + turnEnd per result message.
    const turnEnds = emitted.filter((o) => o.turnEnd);
    const textChunks = emitted.filter((o) => !o.turnEnd);
    expect(turnEnds).toHaveLength(3);
    for (const out of turnEnds) {
      expect(out.status).toBe('success');
      expect(out.result).toBeNull();
      expect(out.newSessionId).toBe('sess-1');
    }
    expect(textChunks.map((o) => o.result)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('does not emit turnEnd on non-result messages', async () => {
    const { emitted, state, deps } = makeHarness();
    const sequence: QueryMessage[] = [
      { type: 'system', subtype: 'init', session_id: 'sess-2' },
      assistant('u1', []),
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 't1',
        status: 'running',
        summary: 'doing work',
      },
      assistant('u2', []),
    ];

    for await (const message of mockSdkStream(sequence)) {
      handleQueryMessage(message, state, deps);
    }

    expect(state.resultCount).toBe(0);
    expect(emitted).toHaveLength(0);
    expect(state.lastAssistantUuid).toBe('u2');
    expect(state.newSessionId).toBe('sess-2');
  });

  it('propagates the latest newSessionId at result time, not the initial one', async () => {
    const { emitted, state, deps } = makeHarness();
    const sequence: QueryMessage[] = [
      { type: 'system', subtype: 'init', session_id: 'sess-old' },
      { type: 'result', subtype: 'success', result: 'r1' },
      { type: 'system', subtype: 'init', session_id: 'sess-new' },
      { type: 'result', subtype: 'success', result: 'r2' },
    ];

    for await (const message of mockSdkStream(sequence)) {
      handleQueryMessage(message, state, deps);
    }

    expect(emitted).toHaveLength(2);
    expect(emitted[0]?.newSessionId).toBe('sess-old');
    expect(emitted[1]?.newSessionId).toBe('sess-new');
  });

  it('emits turnEnd on error_during_execution result subtypes too (host-side guard handles dedup)', async () => {
    const { emitted, state, deps } = makeHarness();
    const sequence: QueryMessage[] = [
      { type: 'system', subtype: 'init', session_id: 'sess-3' },
      { type: 'result', subtype: 'error_during_execution', result: null },
    ];

    for await (const message of mockSdkStream(sequence)) {
      handleQueryMessage(message, state, deps);
    }

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.turnEnd).toBe(true);
    expect(emitted[0]?.result).toBeNull();
  });

  it('extracts SDK usage block + total_cost_usd into the emitted output (FED-20)', async () => {
    const { emitted, state, deps } = makeHarness();
    const sequence: QueryMessage[] = [
      { type: 'system', subtype: 'init', session_id: 'sess-4' },
      {
        type: 'assistant',
        uuid: 'a1',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'text', text: 'ok' }],
          usage: {
            input_tokens: 1500,
            output_tokens: 320,
            cache_read_input_tokens: 4000,
            cache_creation_input_tokens: 100,
          },
        },
      },
      {
        type: 'result',
        subtype: 'success',
        result: 'ok',
        total_cost_usd: 0.1234,
        num_turns: 7,
        usage: {
          input_tokens: 1500,
          output_tokens: 320,
          cache_read_input_tokens: 4000,
          cache_creation_input_tokens: 100,
        },
        modelUsage: {
          'claude-opus-4-8': {
            inputTokens: 1500,
            outputTokens: 320,
            cacheReadInputTokens: 4000,
            cacheCreationInputTokens: 100,
            contextWindow: 1_000_000,
          },
        },
      },
    ];

    for await (const message of mockSdkStream(sequence)) {
      handleQueryMessage(message, state, deps);
    }

    const turnEnd = emitted.find((o) => o.turnEnd);
    expect(turnEnd).toBeDefined();
    const out = turnEnd!;
    expect(out.usage).toBeDefined();
    expect(out.usage?.inputTokens).toBe(1500);
    expect(out.usage?.outputTokens).toBe(320);
    expect(out.usage?.cacheReadInputTokens).toBe(4000);
    expect(out.usage?.cacheCreationInputTokens).toBe(100);
    expect(out.usage?.totalCostUsd).toBeCloseTo(0.1234, 6);
    expect(out.usage?.contextWindow).toBe(1_000_000);
    expect(out.usage?.contextUsedTokens).toBe(1500 + 4000 + 100);
    expect(out.usage?.numTurns).toBe(7);
  });

  it('FED-21: contextUsedTokens uses last assistant per-call usage, not cumulative result.usage', async () => {
    const { emitted, state, deps } = makeHarness();
    const sequence: QueryMessage[] = [
      { type: 'system', subtype: 'init', session_id: 'sess-multi' },
      {
        type: 'assistant',
        uuid: 'a1',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'text', text: 'r1' }],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 80_000,
            cache_creation_input_tokens: 0,
          },
        },
      },
      {
        type: 'result',
        subtype: 'success',
        result: 'r1',
        total_cost_usd: 0.5,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 80_000,
          cache_creation_input_tokens: 0,
        },
      },
      {
        type: 'assistant',
        uuid: 'a2',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'text', text: 'r2' }],
          usage: {
            input_tokens: 200,
            output_tokens: 75,
            cache_read_input_tokens: 90_000,
            cache_creation_input_tokens: 100,
          },
        },
      },
      {
        type: 'result',
        subtype: 'success',
        result: 'r2',
        total_cost_usd: 1.1,
        usage: {
          input_tokens: 300,
          output_tokens: 125,
          cache_read_input_tokens: 170_000,
          cache_creation_input_tokens: 100,
        },
      },
      {
        type: 'assistant',
        uuid: 'a3',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'text', text: 'r3' }],
          usage: {
            input_tokens: 400,
            output_tokens: 90,
            cache_read_input_tokens: 95_000,
            cache_creation_input_tokens: 200,
          },
        },
      },
      {
        type: 'result',
        subtype: 'success',
        result: 'r3',
        total_cost_usd: 1.7,
        usage: {
          input_tokens: 700,
          output_tokens: 215,
          cache_read_input_tokens: 265_000,
          cache_creation_input_tokens: 300,
        },
      },
    ];

    for await (const message of mockSdkStream(sequence)) {
      handleQueryMessage(message, state, deps);
    }

    const turnEnds = emitted.filter((o) => o.turnEnd);
    expect(turnEnds).toHaveLength(3);
    expect(turnEnds[0]?.usage?.contextUsedTokens).toBe(100 + 80_000 + 0);
    expect(turnEnds[1]?.usage?.contextUsedTokens).toBe(200 + 90_000 + 100);
    expect(turnEnds[2]?.usage?.contextUsedTokens).toBe(400 + 95_000 + 200);
    expect(turnEnds[0]?.usage?.totalCostUsd).toBeCloseTo(0.5, 6);
    expect(turnEnds[1]?.usage?.totalCostUsd).toBeCloseTo(1.1, 6);
    expect(turnEnds[2]?.usage?.totalCostUsd).toBeCloseTo(1.7, 6);
  });

  it('FED-21: falls back to result.usage for context when no assistant.usage seen', async () => {
    const { emitted, state, deps } = makeHarness();
    const sequence: QueryMessage[] = [
      { type: 'system', subtype: 'init', session_id: 'sess-fallback' },
      {
        type: 'result',
        subtype: 'success',
        result: 'ok',
        usage: {
          input_tokens: 50,
          output_tokens: 20,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 5,
        },
      },
    ];

    for await (const message of mockSdkStream(sequence)) {
      handleQueryMessage(message, state, deps);
    }

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.usage?.contextUsedTokens).toBe(50 + 1000 + 5);
  });

  it('emits usage with null total_cost_usd when SDK omits it', async () => {
    const { emitted, state, deps } = makeHarness();
    const sequence: QueryMessage[] = [
      { type: 'system', subtype: 'init', session_id: 'sess-5' },
      {
        type: 'result',
        subtype: 'success',
        result: 'ok',
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    ];

    for await (const message of mockSdkStream(sequence)) {
      handleQueryMessage(message, state, deps);
    }

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.usage?.totalCostUsd).toBeNull();
    expect(emitted[0]?.usage?.contextWindow).toBeNull();
  });

  it('omits usage on result without a usage block', async () => {
    const { emitted, state, deps } = makeHarness();
    const sequence: QueryMessage[] = [
      { type: 'system', subtype: 'init', session_id: 'sess-6' },
      { type: 'result', subtype: 'success', result: 'ok' },
    ];

    for await (const message of mockSdkStream(sequence)) {
      handleQueryMessage(message, state, deps);
    }

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.usage).toBeUndefined();
  });
});

// FED-31: agent prose that precedes a tool_use must reach the chat. Before
// this fix only `result.result` (the final text block of a turn) was emitted,
// so any preamble before send_message / Bash / etc. was silently dropped and
// the silence-stub fired even though the agent had spoken.
describe('handleQueryMessage (FED-31 stream every text block)', () => {
  it('text-before-tool-call: emits the preamble even when the turn ends with a tool_use', async () => {
    const { emitted, state, deps } = makeHarness();
    const sequence: QueryMessage[] = [
      { type: 'system', subtype: 'init', session_id: 'sess-31a' },
      assistant('a1', [
        { type: 'text', text: 'Сейчас посмотрю' },
        { type: 'tool_use', name: 'Bash' },
      ]),
      // No second assistant message — the SDK closed the turn after the
      // tool result. `result.result` is empty in this shape, which is the
      // exact failure mode reported in FED-31.
      { type: 'result', subtype: 'success', result: '' },
    ];

    for await (const message of mockSdkStream(sequence)) {
      handleQueryMessage(message, state, deps);
    }

    const textChunks = emitted.filter((o) => !o.turnEnd);
    expect(textChunks.map((o) => o.result)).toEqual(['Сейчас посмотрю']);
    const turnEnds = emitted.filter((o) => o.turnEnd);
    expect(turnEnds).toHaveLength(1);
    expect(turnEnds[0]?.result).toBeNull();
  });

  it('text-after-tool-call: still emits the trailing text block exactly once', async () => {
    const { emitted, state, deps } = makeHarness();
    const sequence: QueryMessage[] = [
      { type: 'system', subtype: 'init', session_id: 'sess-31b' },
      assistant('a1', [{ type: 'tool_use', name: 'Bash' }]),
      assistant('a2', [{ type: 'text', text: 'Готово' }]),
      { type: 'result', subtype: 'success', result: 'Готово' },
    ];

    for await (const message of mockSdkStream(sequence)) {
      handleQueryMessage(message, state, deps);
    }

    const textChunks = emitted.filter((o) => !o.turnEnd);
    expect(textChunks.map((o) => o.result)).toEqual(['Готово']);
    const turnEnds = emitted.filter((o) => o.turnEnd);
    expect(turnEnds).toHaveLength(1);
    expect(turnEnds[0]?.result).toBeNull();
  });

  it('text + trailing <internal>: emits both blocks; host-side stripping suppresses delivery of the internal one', async () => {
    const { emitted, state, deps } = makeHarness();
    const sequence: QueryMessage[] = [
      { type: 'system', subtype: 'init', session_id: 'sess-31c' },
      assistant('a1', [
        { type: 'text', text: 'Ответ для пользователя.' },
        { type: 'text', text: '<internal>пометка для себя</internal>' },
      ]),
      { type: 'result', subtype: 'success', result: '' },
    ];

    for await (const message of mockSdkStream(sequence)) {
      handleQueryMessage(message, state, deps);
    }

    // Both text blocks are streamed verbatim — the host's outbound path
    // already strips <internal>...</internal> per-block in src/index.ts, so
    // the second one collapses to empty there and never reaches the chat.
    const textChunks = emitted.filter((o) => !o.turnEnd);
    expect(textChunks.map((o) => o.result)).toEqual([
      'Ответ для пользователя.',
      '<internal>пометка для себя</internal>',
    ]);
  });

  it('tool-call-only with no text: emits zero text chunks, just the closing turnEnd', async () => {
    const { emitted, state, deps } = makeHarness();
    const sequence: QueryMessage[] = [
      { type: 'system', subtype: 'init', session_id: 'sess-31d' },
      assistant('a1', [{ type: 'tool_use', name: 'mcp__nanoclaw__react' }]),
      { type: 'result', subtype: 'success', result: '' },
    ];

    for await (const message of mockSdkStream(sequence)) {
      handleQueryMessage(message, state, deps);
    }

    const textChunks = emitted.filter((o) => !o.turnEnd);
    expect(textChunks).toHaveLength(0);
    const turnEnds = emitted.filter((o) => o.turnEnd);
    expect(turnEnds).toHaveLength(1);
    expect(turnEnds[0]?.result).toBeNull();
  });

  it('subagent text (parent_tool_use_id set) is NOT surfaced to the channel', async () => {
    const { emitted, state, deps } = makeHarness();
    const sequence: QueryMessage[] = [
      { type: 'system', subtype: 'init', session_id: 'sess-31e' },
      // Subagent message from a TeamCreate/Task tool — should stay internal.
      {
        type: 'assistant',
        uuid: 'sub1',
        parent_tool_use_id: 'tool-abc',
        message: { content: [{ type: 'text', text: 'subagent thinking' }] },
      },
      assistant('a1', [{ type: 'text', text: 'Готовый ответ' }]),
      { type: 'result', subtype: 'success', result: 'Готовый ответ' },
    ];

    for await (const message of mockSdkStream(sequence)) {
      handleQueryMessage(message, state, deps);
    }

    const textChunks = emitted.filter((o) => !o.turnEnd);
    expect(textChunks.map((o) => o.result)).toEqual(['Готовый ответ']);
  });

  it('multiple text blocks before a tool_use all surface in order', async () => {
    const { emitted, state, deps } = makeHarness();
    const sequence: QueryMessage[] = [
      { type: 'system', subtype: 'init', session_id: 'sess-31f' },
      assistant('a1', [
        { type: 'text', text: 'Первый кусок.' },
        { type: 'text', text: 'Второй кусок.' },
        { type: 'tool_use', name: 'Bash' },
      ]),
      { type: 'result', subtype: 'success', result: '' },
    ];

    for await (const message of mockSdkStream(sequence)) {
      handleQueryMessage(message, state, deps);
    }

    const textChunks = emitted.filter((o) => !o.turnEnd);
    expect(textChunks.map((o) => o.result)).toEqual([
      'Первый кусок.',
      'Второй кусок.',
    ]);
  });
});
