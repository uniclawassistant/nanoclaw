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
    assistantUsageMessageIds: new Set(),
  };
}

function recordUsage(
  state: QueryLoopState,
  messageId: string,
  inputTokens: unknown,
  cacheReadInputTokens: unknown = 0,
  cacheCreationInputTokens: unknown = 0,
  parentToolUseId: string | null = null,
): void {
  handleQueryMessage(
    {
      type: 'assistant',
      parent_tool_use_id: parentToolUseId,
      message: {
        id: messageId,
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
  agentId?: string,
) {
  return hook(
    { hook_event_name: hookEventName, agent_id: agentId } as never,
    undefined,
    {
      signal: new AbortController().signal,
    },
  );
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

    recordUsage(state, 'call-1', 40);
    expect(await runHook(hook, 'PostToolUse')).toEqual({});
    recordUsage(state, 'call-2', 99);
    expect(await runHook(hook, 'PostToolUse')).toEqual({});
  });

  it('signals at the boundary with the exact per-call context', async () => {
    const state = createState();
    const hook = createContextThresholdHook(state, 100);

    recordUsage(state, 'call-1', 40);
    await runHook(hook, 'PostToolUse');
    recordUsage(state, 'call-2', 60, 30, 10);

    expect(additionalContext(await runHook(hook, 'PostToolUse'))).toBe(
      '[context-threshold] ctx=100. Save the session tail, then refresh the session.',
    );
  });

  it('uses the failure hook branch', async () => {
    const state = createState();
    const hook = createContextThresholdHook(state, 100);

    recordUsage(state, 'call-1', 90);
    await runHook(hook, 'PostToolUseFailure');
    recordUsage(state, 'call-2', 101);
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
    recordUsage(state, 'unknown-call', 'unknown');
    expect(await runHook(hook, 'PostToolUse')).toEqual({});
    recordUsage(state, 'call-1', 200);
    expect(await runHook(hook, 'PostToolUse')).toEqual({});
    recordUsage(state, 'call-2', 201);
    expect(additionalContext(await runHook(hook, 'PostToolUse'))).toContain(
      'ctx=201',
    );
  });

  it('signals only once per query', async () => {
    const state = createState();
    const hook = createContextThresholdHook(state, 100);

    recordUsage(state, 'call-1', 90);
    await runHook(hook, 'PostToolUse');
    recordUsage(state, 'call-2', 100);
    expect(additionalContext(await runHook(hook, 'PostToolUse'))).toContain(
      'ctx=100',
    );
    expect(await runHook(hook, 'PostToolUse')).toEqual({});
    recordUsage(state, 'call-3', 150);
    expect(await runHook(hook, 'PostToolUse')).toEqual({});
  });

  it('adds zero bytes without a configured threshold', async () => {
    const state = createState();
    const hook = createContextThresholdHook(state, undefined);

    recordUsage(state, 'call-1', 500);
    recordUsage(state, 'call-2', 501);

    expect(await runHook(hook, 'PostToolUse')).toEqual({});
  });

  it('counts repeated stream events with one message id as one API call', async () => {
    const state = createState();
    const hook = createContextThresholdHook(state, 1);

    recordUsage(state, 'call-1', 100);
    expect(await runHook(hook, 'PostToolUse')).toEqual({});
    recordUsage(state, 'call-1', 101);
    expect(await runHook(hook, 'PostToolUse')).toEqual({});
    recordUsage(state, 'call-1', 102);
    expect(await runHook(hook, 'PostToolUse')).toEqual({});

    recordUsage(state, 'call-2', 103);
    expect(additionalContext(await runHook(hook, 'PostToolUse'))).toContain(
      'ctx=103',
    );
  });

  it('ignores repeated subagent usage between the first and second main calls', async () => {
    const state = createState();
    const hook = createContextThresholdHook(state, 100);

    recordUsage(state, 'main-1', 50);
    recordUsage(state, 'main-1', 51);
    expect(await runHook(hook, 'PostToolUse')).toEqual({});

    recordUsage(state, 'sub-1', 500, 0, 0, 'parent-tool');
    recordUsage(state, 'sub-1', 501, 0, 0, 'parent-tool');
    expect(await runHook(hook, 'PostToolUse', 'subagent-1')).toEqual({});
    expect(state.assistantUsageMessageIds).toEqual(new Set(['main-1']));
    expect(state.lastAssistantUsage?.input_tokens).toBe(51);

    recordUsage(state, 'main-2', 120);
    expect(additionalContext(await runHook(hook, 'PostToolUse'))).toContain(
      'ctx=120',
    );
  });

  it('keeps a low subagent call from replacing main usage or consuming one-shot', async () => {
    const state = createState();
    const hook = createContextThresholdHook(state, 100);

    recordUsage(state, 'main-1', 90);
    expect(await runHook(hook, 'PostToolUse')).toEqual({});
    recordUsage(state, 'main-2', 150);
    recordUsage(state, 'sub-1', 5, 0, 0, 'parent-tool');

    expect(await runHook(hook, 'PostToolUse', 'subagent-1')).toEqual({});
    expect(state.lastAssistantUsage?.input_tokens).toBe(150);
    expect(additionalContext(await runHook(hook, 'PostToolUse'))).toContain(
      'ctx=150',
    );
  });
});
