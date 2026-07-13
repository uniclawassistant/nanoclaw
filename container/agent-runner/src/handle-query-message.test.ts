import { describe, expect, it } from 'vitest';
import {
  handleQueryMessage,
  type AgentRunnerOutput,
  type QueryLoopState,
} from './handle-query-message.js';

function runResult(modelUsage: Record<string, { contextWindow?: number }>) {
  const emitted: AgentRunnerOutput[] = [];
  const state: QueryLoopState = { messageCount: 0, resultCount: 0 };
  const message = {
    type: 'result',
    subtype: 'success',
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 40_000,
      cache_creation_input_tokens: 0,
    },
    modelUsage,
    total_cost_usd: 0.01,
    num_turns: 1,
  };
  handleQueryMessage(message, state, {
    emit: (o) => emitted.push(o),
    log: () => {},
  });
  return emitted;
}

describe('completed resume pointer (FED-38)', () => {
  it('keeps the last successful assistant UUID across an interrupted result', () => {
    const state: QueryLoopState = { messageCount: 0, resultCount: 0 };
    const deps = { emit: () => {}, log: () => {} };

    handleQueryMessage({ type: 'assistant', uuid: 'completed-a' }, state, deps);
    handleQueryMessage({ type: 'result', subtype: 'success' }, state, deps);
    handleQueryMessage({ type: 'assistant', uuid: 'partial-b' }, state, deps);
    handleQueryMessage(
      { type: 'result', subtype: 'error_during_execution' },
      state,
      deps,
    );

    expect(state.lastAssistantUuid).toBe('partial-b');
    expect(state.lastCompletedAssistantUuid).toBe('completed-a');
  });
});

describe('extractUsageFromResult contextWindow (FED-35: verbatim, no floor)', () => {
  it('reports the SDK contextWindow as-is — it is what autocompact runs on', () => {
    const emitted = runResult({
      'claude-fable-5': { contextWindow: 200_000 },
    });
    expect(emitted[0]?.usage?.contextWindow).toBe(200_000);
  });

  it('reports 1M when the SDK knows the window (e.g. [1m]-suffixed spawn)', () => {
    const emitted = runResult({
      'claude-fable-5': { contextWindow: 1_000_000 },
    });
    expect(emitted[0]?.usage?.contextWindow).toBe(1_000_000);
  });

  it('picks the largest window across multiple entries', () => {
    const emitted = runResult({
      'claude-fable-5': { contextWindow: 1_000_000 },
      'claude-haiku-4-5-20251001': { contextWindow: 200_000 },
    });
    expect(emitted[0]?.usage?.contextWindow).toBe(1_000_000);
  });

  it('reports null when modelUsage is absent', () => {
    const emitted = runResult({});
    expect(emitted[0]?.usage?.contextWindow).toBeNull();
  });
});
