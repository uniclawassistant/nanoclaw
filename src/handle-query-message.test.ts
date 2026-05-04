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

describe('handleQueryMessage (FED-18 per-Stop turnEnd)', () => {
  it('emits turnEnd:true exactly once per result message in a streamed sequence', async () => {
    const { emitted, state, deps } = makeHarness();
    const sequence: QueryMessage[] = [
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      { type: 'assistant', uuid: 'u1' },
      { type: 'result', subtype: 'success', result: 'first' },
      { type: 'assistant', uuid: 'u2' },
      { type: 'result', subtype: 'success', result: 'second' },
      { type: 'assistant', uuid: 'u3' },
      { type: 'result', subtype: 'success', result: 'third' },
    ];

    for await (const message of mockSdkStream(sequence)) {
      handleQueryMessage(message, state, deps);
    }

    expect(state.resultCount).toBe(3);
    expect(emitted).toHaveLength(3);
    for (const out of emitted) {
      expect(out.turnEnd).toBe(true);
      expect(out.status).toBe('success');
      expect(out.newSessionId).toBe('sess-1');
    }
    expect(emitted.map((o) => o.result)).toEqual(['first', 'second', 'third']);
  });

  it('does not emit turnEnd on non-result messages', async () => {
    const { emitted, state, deps } = makeHarness();
    const sequence: QueryMessage[] = [
      { type: 'system', subtype: 'init', session_id: 'sess-2' },
      { type: 'assistant', uuid: 'u1' },
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 't1',
        status: 'running',
        summary: 'doing work',
      },
      { type: 'assistant', uuid: 'u2' },
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
          'claude-opus-4-7': {
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

    expect(emitted).toHaveLength(1);
    const out = emitted[0]!;
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
