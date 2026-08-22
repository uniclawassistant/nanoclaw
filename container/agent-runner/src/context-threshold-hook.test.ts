import { describe, expect, it } from 'vitest';

import { createContextThresholdHook } from './context-threshold-hook.js';
import {
  handleQueryMessage,
  type QueryLoopState,
} from './handle-query-message.js';

function createState(): QueryLoopState {
  return {
    messageCount: 0,
    resultCount: 0,
    assistantUsageSampleCount: 0,
  };
}

function recordUsage(
  state: QueryLoopState,
  inputTokens: unknown,
  cacheReadInputTokens: unknown = 0,
  cacheCreationInputTokens: unknown = 0,
): void {
  handleQueryMessage(
    {
      type: 'assistant',
      message: {
        usage: {
          input_tokens: inputTokens,
          cache_read_input_tokens: cacheReadInputTokens,
          cache_creation_input_tokens: cacheCreationInputTokens,
        },
      },
    },
    state,
    { emit: () => {}, log: () => {} },
  );
}

async function runHook(
  hook: ReturnType<typeof createContextThresholdHook>,
  hookEventName: 'PostToolUse' | 'PostToolUseFailure',
) {
  return hook({ hook_event_name: hookEventName } as never, undefined, {
    signal: new AbortController().signal,
  });
}

function additionalContext(
  output: Awaited<ReturnType<typeof runHook>>,
): string {
  const hookSpecificOutput =
    'hookSpecificOutput' in output ? output.hookSpecificOutput : undefined;
  return hookSpecificOutput && 'additionalContext' in hookSpecificOutput
    ? (hookSpecificOutput.additionalContext ?? '')
    : '';
}

describe('context threshold hook', () => {
  it('adds zero bytes below the threshold', async () => {
    const state = createState();
    const hook = createContextThresholdHook(state, 100);

    recordUsage(state, 40);
    expect(await runHook(hook, 'PostToolUse')).toEqual({});
    recordUsage(state, 99);
    expect(await runHook(hook, 'PostToolUse')).toEqual({});
  });

  it('signals at the boundary with the exact per-call context', async () => {
    const state = createState();
    const hook = createContextThresholdHook(state, 100);

    recordUsage(state, 40);
    await runHook(hook, 'PostToolUse');
    recordUsage(state, 60, 30, 10);

    expect(additionalContext(await runHook(hook, 'PostToolUse'))).toBe(
      '[context-threshold] ctx=100. Save the session tail, then refresh the session.',
    );
  });

  it('uses the failure hook branch', async () => {
    const state = createState();
    const hook = createContextThresholdHook(state, 100);

    recordUsage(state, 90);
    await runHook(hook, 'PostToolUseFailure');
    recordUsage(state, 101);
    const output = await runHook(hook, 'PostToolUseFailure');

    expect(output).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PostToolUseFailure',
        additionalContext:
          '[context-threshold] ctx=101. Save the session tail, then refresh the session.',
      },
    });
  });

  it('does not trust the first valid sample after unknown usage', async () => {
    const state = createState();
    const hook = createContextThresholdHook(state, 100);

    expect(await runHook(hook, 'PostToolUse')).toEqual({});
    recordUsage(state, 'unknown');
    expect(await runHook(hook, 'PostToolUse')).toEqual({});
    recordUsage(state, 200);
    expect(await runHook(hook, 'PostToolUse')).toEqual({});
    recordUsage(state, 201);
    expect(additionalContext(await runHook(hook, 'PostToolUse'))).toContain(
      'ctx=201',
    );
  });

  it('signals only once per query', async () => {
    const state = createState();
    const hook = createContextThresholdHook(state, 100);

    recordUsage(state, 90);
    await runHook(hook, 'PostToolUse');
    recordUsage(state, 100);
    expect(additionalContext(await runHook(hook, 'PostToolUse'))).toContain(
      'ctx=100',
    );
    expect(await runHook(hook, 'PostToolUse')).toEqual({});
    recordUsage(state, 150);
    expect(await runHook(hook, 'PostToolUse')).toEqual({});
  });

  it('adds zero bytes without a configured threshold', async () => {
    const state = createState();
    const hook = createContextThresholdHook(state, undefined);

    recordUsage(state, 500);
    recordUsage(state, 501);

    expect(await runHook(hook, 'PostToolUse')).toEqual({});
  });
});
