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

describe('extractUsageFromResult contextWindow floor (FED-33)', () => {
  it('floors SDK contextWindow to 1M for known 1M-tier bare id', () => {
    const emitted = runResult({
      'claude-fable-5': { contextWindow: 200_000 },
    });
    expect(emitted[0]?.usage?.contextWindow).toBe(1_000_000);
  });

  it('floors SDK contextWindow to 1M for [1m]-suffixed model key', () => {
    const emitted = runResult({
      'claude-opus-4-8[1m]': { contextWindow: 200_000 },
    });
    expect(emitted[0]?.usage?.contextWindow).toBe(1_000_000);
  });

  it('respects SDK contextWindow for models not in the 1M list', () => {
    const emitted = runResult({
      'claude-haiku-4-5-20251001': { contextWindow: 200_000 },
    });
    expect(emitted[0]?.usage?.contextWindow).toBe(200_000);
  });

  it('keeps SDK contextWindow when it already reports >= 1M', () => {
    const emitted = runResult({
      'claude-fable-5': { contextWindow: 1_000_000 },
    });
    expect(emitted[0]?.usage?.contextWindow).toBe(1_000_000);
  });

  it('picks the largest effective window across multiple entries', () => {
    const emitted = runResult({
      'claude-fable-5': { contextWindow: 200_000 },
      'claude-haiku-4-5-20251001': { contextWindow: 200_000 },
    });
    expect(emitted[0]?.usage?.contextWindow).toBe(1_000_000);
  });
});
