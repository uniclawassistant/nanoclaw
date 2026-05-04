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

  if (message.type === 'assistant' && 'uuid' in message) {
    state.lastAssistantUuid = (message as unknown as { uuid: string }).uuid;
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
    const textResult =
      'result' in message ? (message as { result?: string }).result : null;
    const subtype = (message as { subtype?: string }).subtype;
    const usage = extractUsageFromResult(message);
    deps.log(
      `Result #${state.resultCount}: subtype=${subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}${usage ? ` cost=${usage.totalCostUsd ?? 'null'} ctx=${usage.contextUsedTokens}/${usage.contextWindow ?? '?'}` : ''}`,
    );
    deps.emit({
      status: 'success',
      result: textResult || null,
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

function extractUsageFromResult(message: QueryMessage): UsageReport | null {
  const usage = (message as { usage?: SdkResultUsage }).usage;
  if (!usage) return null;

  const inputTokens = numberOr(usage.input_tokens, 0);
  const outputTokens = numberOr(usage.output_tokens, 0);
  const cacheReadInputTokens = numberOr(usage.cache_read_input_tokens, 0);
  const cacheCreationInputTokens = numberOr(usage.cache_creation_input_tokens, 0);

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
    for (const entry of Object.values(modelUsage)) {
      if (entry?.contextWindow && entry.contextWindow > (contextWindow ?? 0)) {
        contextWindow = entry.contextWindow;
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
    contextUsedTokens:
      inputTokens + cacheReadInputTokens + cacheCreationInputTokens,
    numTurns,
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
