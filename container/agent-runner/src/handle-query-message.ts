import largeContextModels from './large-context-models.json' with { type: 'json' };

const LARGE_CONTEXT_MODELS: ReadonlySet<string> = new Set(largeContextModels);
const LARGE_CONTEXT_WINDOW = 1_000_000;

/**
 * True when the model id refers to a 1M-context Claude tier. Used to floor
 * SDK-reported `modelUsage[model].contextWindow` to 1M: the Agent SDK's
 * model→contextWindow table lags Anthropic releases (e.g. reports 200k for
 * claude-fable-5 whose default is 1M), and Anthropic strips `[1m]` from
 * response.model, so trusting the SDK value verbatim underreports the window
 * and fires early `/compact` warnings. List lives in
 * `large-context-models.json`, mirrored on the host side.
 */
function isLargeContextModel(model: string): boolean {
  if (model.includes('[1m]')) return true;
  return LARGE_CONTEXT_MODELS.has(model);
}

export interface UsageReport {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalCostUsd: number | null;
  contextWindow: number | null;
  contextUsedTokens: number;
  numTurns: number;
}

export interface AgentRunnerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  turnEnd?: boolean;
  usage?: UsageReport;
}

export interface QueryLoopState {
  messageCount: number;
  resultCount: number;
  newSessionId?: string;
  lastAssistantUuid?: string;
  // FED-21: usage from the latest `assistant` message in the SDK stream.
  // `result.usage` is cumulative across all internal API calls inside a
  // single query() session; `assistant.message.usage` is per-API-call and
  // accurately reflects the current context size of that call.
  lastAssistantUsage?: SdkResultUsage;
}

interface SdkContentBlock {
  type?: string;
  text?: string;
}

export interface QueryLoopDeps {
  emit: (output: AgentRunnerOutput) => void;
  log: (msg: string) => void;
}

export type QueryMessage = { type: string } & Record<string, unknown>;

export function handleQueryMessage(
  message: QueryMessage,
  state: QueryLoopState,
  deps: QueryLoopDeps,
): void {
  state.messageCount++;
  const msgType =
    message.type === 'system'
      ? `system/${(message as { subtype?: string }).subtype}`
      : message.type;
  deps.log(`[msg #${state.messageCount}] type=${msgType}`);

  if (message.type === 'assistant') {
    if ('uuid' in message) {
      state.lastAssistantUuid = (message as unknown as { uuid: string }).uuid;
    }
    const inner = (
      message as {
        message?: { usage?: SdkResultUsage; content?: SdkContentBlock[] };
      }
    ).message;
    if (inner?.usage) {
      state.lastAssistantUsage = inner.usage;
    }
    const parentToolUseId = (
      message as { parent_tool_use_id?: string | null }
    ).parent_tool_use_id;
    if (parentToolUseId == null && Array.isArray(inner?.content)) {
      for (const block of inner.content) {
        if (block?.type !== 'text') continue;
        const text = typeof block.text === 'string' ? block.text : '';
        if (!text) continue;
        deps.emit({
          status: 'success',
          result: text,
          newSessionId: state.newSessionId,
          turnEnd: false,
        });
      }
    }
  }

  if (
    message.type === 'system' &&
    (message as { subtype?: string }).subtype === 'init'
  ) {
    state.newSessionId = (message as { session_id?: string }).session_id;
    deps.log(`Session initialized: ${state.newSessionId}`);
  }

  if (
    message.type === 'system' &&
    (message as { subtype?: string }).subtype === 'task_notification'
  ) {
    const tn = message as unknown as {
      task_id: string;
      status: string;
      summary: string;
    };
    deps.log(
      `Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`,
    );
  }

  if (message.type === 'result') {
    state.resultCount++;
    const subtype = (message as { subtype?: string }).subtype;
    const usage = extractUsageFromResult(message, state);
    deps.log(
      `Result #${state.resultCount}: subtype=${subtype}${usage ? ` cost=${usage.totalCostUsd ?? 'null'} ctx=${usage.contextUsedTokens}/${usage.contextWindow ?? '?'}` : ''}`,
    );
    deps.emit({
      status: 'success',
      result: null,
      newSessionId: state.newSessionId,
      turnEnd: true,
      usage: usage ?? undefined,
    });
  }
}

interface SdkResultUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface SdkModelUsageEntry {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  contextWindow?: number;
}

function extractUsageFromResult(
  message: QueryMessage,
  state: QueryLoopState,
): UsageReport | null {
  const usage = (message as { usage?: SdkResultUsage }).usage;
  if (!usage) return null;

  const inputTokens = numberOr(usage.input_tokens, 0);
  const outputTokens = numberOr(usage.output_tokens, 0);
  const cacheReadInputTokens = numberOr(usage.cache_read_input_tokens, 0);
  const cacheCreationInputTokens = numberOr(
    usage.cache_creation_input_tokens,
    0,
  );

  // FED-21: contextUsedTokens reflects the SIZE of the current context, which
  // is per-API-call. `result.usage` is cumulative across all API calls inside
  // a single query() session, so we fall back to the last assistant message's
  // per-call usage when available.
  const perCall = state.lastAssistantUsage;
  const ctxInput = perCall ? numberOr(perCall.input_tokens, 0) : inputTokens;
  const ctxCacheRead = perCall
    ? numberOr(perCall.cache_read_input_tokens, 0)
    : cacheReadInputTokens;
  const ctxCacheCreate = perCall
    ? numberOr(perCall.cache_creation_input_tokens, 0)
    : cacheCreationInputTokens;

  const totalCostRaw = (message as { total_cost_usd?: unknown }).total_cost_usd;
  const totalCostUsd =
    typeof totalCostRaw === 'number' && Number.isFinite(totalCostRaw)
      ? totalCostRaw
      : null;

  const numTurnsRaw = (message as { num_turns?: unknown }).num_turns;
  const numTurns =
    typeof numTurnsRaw === 'number' && Number.isFinite(numTurnsRaw)
      ? numTurnsRaw
      : 0;

  const modelUsage = (
    message as { modelUsage?: Record<string, SdkModelUsageEntry> }
  ).modelUsage;
  let contextWindow: number | null = null;
  if (modelUsage) {
    for (const [model, entry] of Object.entries(modelUsage)) {
      const effective =
        entry?.contextWindow && isLargeContextModel(model)
          ? Math.max(entry.contextWindow, LARGE_CONTEXT_WINDOW)
          : entry?.contextWindow;
      if (effective && effective > (contextWindow ?? 0)) {
        contextWindow = effective;
      }
    }
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    totalCostUsd,
    contextWindow,
    contextUsedTokens: ctxInput + ctxCacheRead + ctxCacheCreate,
    numTurns,
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
