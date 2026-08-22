import type {
  HookCallback,
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';

import type { QueryLoopState } from './handle-query-message.js';

type ToolResultHookInput = PostToolUseHookInput | PostToolUseFailureHookInput;

function contextUsedTokens(state: QueryLoopState): number | null {
  const usage = state.lastAssistantUsage;
  if (!usage || !Number.isFinite(usage.input_tokens)) return null;

  const inputTokens = usage.input_tokens as number;
  const cacheReadTokens = Number.isFinite(usage.cache_read_input_tokens)
    ? (usage.cache_read_input_tokens as number)
    : 0;
  const cacheCreationTokens = Number.isFinite(usage.cache_creation_input_tokens)
    ? (usage.cache_creation_input_tokens as number)
    : 0;

  return inputTokens + cacheReadTokens + cacheCreationTokens;
}

function isEnabledThreshold(
  threshold: number | undefined,
): threshold is number {
  return (
    typeof threshold === 'number' &&
    Number.isInteger(threshold) &&
    threshold > 0
  );
}

export function createContextThresholdHook(
  state: QueryLoopState,
  threshold: number | undefined,
): HookCallback {
  let lastObservedSample = 0;
  let warned = false;

  return async (input) => {
    const hookInput = input as ToolResultHookInput;
    if (hookInput.agent_id !== undefined) return {};
    if (!isEnabledThreshold(threshold) || warned) return {};
    if (state.assistantUsageMessageIds.size === lastObservedSample) return {};

    lastObservedSample = state.assistantUsageMessageIds.size;
    if (lastObservedSample < 2) return {};

    const contextTokens = contextUsedTokens(state);
    if (contextTokens === null || contextTokens < threshold) return {};

    warned = true;
    return {
      hookSpecificOutput: {
        hookEventName: hookInput.hook_event_name,
        additionalContext: `[context-threshold] ctx=${contextTokens}. Save the session tail, then refresh the session.`,
      },
    };
  };
}
