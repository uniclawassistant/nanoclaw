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
        type: 'assistant',
        uuid: 'a1',
        message: {
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

  it('FED-21: contextUsedTokens uses last assistant per-call usage, not cumulative result.usage', async () => {
    const { emitted, state, deps } = makeHarness();
    // Three turns inside one open query() session. The SDK's `result.usage`
    // accumulates across all API calls in the session, while each
    // `assistant.message.usage` is per-API-call. The host needs the per-call
    // value to render an accurate context-size indicator.
    const sequence: QueryMessage[] = [
      { type: 'system', subtype: 'init', session_id: 'sess-multi' },
      {
        type: 'assistant',
        uuid: 'a1',
        message: {
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
        message: {
          usage: {
            input_tokens: 200,
            output_tokens: 75,
            cache_read_input_tokens: 90_000,
            cache_creation_input_tokens: 100,
          },
        },
      },
      {
        // result.usage cumulative-усугублённое: input/cache from BOTH turns.
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
        message: {
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

    expect(emitted).toHaveLength(3);
    // contextUsedTokens reflects per-call context size of the assistant
    // message that immediately preceded each result.
    expect(emitted[0]?.usage?.contextUsedTokens).toBe(100 + 80_000 + 0);
    expect(emitted[1]?.usage?.contextUsedTokens).toBe(200 + 90_000 + 100);
    expect(emitted[2]?.usage?.contextUsedTokens).toBe(400 + 95_000 + 200);
    // total_cost_usd remains the cumulative cost from result message — that
    // is the authoritative session cost figure.
    expect(emitted[0]?.usage?.totalCostUsd).toBeCloseTo(0.5, 6);
    expect(emitted[1]?.usage?.totalCostUsd).toBeCloseTo(1.1, 6);
    expect(emitted[2]?.usage?.totalCostUsd).toBeCloseTo(1.7, 6);
  });

  it('FED-21: falls back to result.usage for context when no assistant.usage seen', async () => {
    // Single-turn / SDK-omits-assistant-usage case: contextUsedTokens
    // gracefully falls back to result.usage so we never emit zero context.
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
