export interface AgentRunnerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  turnEnd?: boolean;
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
    deps.log(
      `Result #${state.resultCount}: subtype=${subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`,
    );
    deps.emit({
      status: 'success',
      result: textResult || null,
      newSessionId: state.newSessionId,
      turnEnd: true,
    });
  }
}
