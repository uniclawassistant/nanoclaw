import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { runContainerAgentMock } = vi.hoisted(() => ({
  runContainerAgentMock: vi.fn(),
}));

vi.mock('./container-runner.js', () => ({
  runContainerAgent: runContainerAgentMock,
  writeTasksSnapshot: vi.fn(),
}));

import { _initTestDatabase, createTask, getTaskById } from './db.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  startSchedulerLoop,
} from './task-scheduler.js';
import type { SchedulerDependencies } from './task-scheduler.js';
import { createContextThresholdHook } from '../container/agent-runner/src/context-threshold-hook.js';
import {
  handleQueryMessage,
  type QueryLoopState,
} from '../container/agent-runner/src/handle-query-message.js';
import {
  _resetForTests,
  formatUsageLine,
  recordUsage,
} from './usage-tracker.js';
import {
  openWork,
  scheduleWorkContinuationsAtTurnEnd,
} from './work-continuation.js';

async function captureScheduledInput(contextThreshold?: number) {
  createTask({
    id: 'task-context-threshold',
    group_folder: 'main',
    chat_jid: 'main-chat',
    prompt: 'run scheduled work',
    schedule_type: 'once',
    schedule_value: '2026-02-22T00:00:00.000Z',
    context_mode: 'isolated',
    next_run: new Date(Date.now() - 60_000).toISOString(),
    status: 'active',
    created_at: '2026-02-22T00:00:00.000Z',
  });

  startSchedulerLoop({
    registeredGroups: () => ({
      'main-chat': {
        name: 'Main',
        folder: 'main',
        isMain: true,
        trigger: '@Andy',
        added_at: '2026-02-22T00:00:00.000Z',
        containerConfig:
          contextThreshold === undefined ? undefined : { contextThreshold },
      },
    }),
    getSessions: () => ({}),
    queue: {
      enqueueTask: (
        _groupJid: string,
        _taskId: string,
        run: () => Promise<void>,
      ) => {
        void run();
      },
    } as unknown as SchedulerDependencies['queue'],
    onProcess: () => {},
    sendMessage: async () => {},
  });

  await vi.advanceTimersByTimeAsync(10);
  return runContainerAgentMock.mock.calls[0]?.[1] as {
    contextThreshold?: number;
  };
}

function recordMainUsage(
  state: QueryLoopState,
  messageId: string,
  contextTokens: number,
): void {
  handleQueryMessage(
    {
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        id: messageId,
        usage: { input_tokens: contextTokens },
      },
    },
    state,
    { emit: () => {}, log: () => {} },
  );
}

async function invokeSuccessHook(
  hook: ReturnType<typeof createContextThresholdHook>,
) {
  return hook({ hook_event_name: 'PostToolUse' } as never, undefined, {
    signal: new AbortController().signal,
  });
}

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    _resetForTests();
    process.env.SPEND_DAILY_JSONL_PATH = '/dev/null';
    runContainerAgentMock.mockReset();
    runContainerAgentMock.mockResolvedValue({ status: 'success' });
    vi.useFakeTimers();
  });

  afterEach(() => {
    delete process.env.SPEND_DAILY_JSONL_PATH;
    vi.useRealTimers();
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('prefixes a scheduled prompt with fresh host status for its session', async () => {
    recordUsage({
      jid: 'main-chat',
      sessionId: 'previous-session',
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 10,
        cacheCreationInputTokens: 5,
        totalCostUsd: 0.42,
        contextWindow: 1_000_000,
        contextUsedTokens: 250_000,
        numTurns: 1,
      },
      origin: 'interactive',
    });
    createTask({
      id: 'task-host-status',
      group_folder: 'main',
      chat_jid: 'main-chat',
      prompt: 'run scheduled work',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'group',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    startSchedulerLoop({
      registeredGroups: () => ({
        'main-chat': {
          name: 'Main',
          folder: 'main',
          isMain: true,
          trigger: '@Andy',
          added_at: '2026-02-22T00:00:00.000Z',
        },
      }),
      getSessions: () => ({ main: 'current-session' }),
      queue: {
        enqueueTask: (
          _groupJid: string,
          _taskId: string,
          run: () => Promise<void>,
        ) => {
          void run();
        },
      } as unknown as SchedulerDependencies['queue'],
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const input = runContainerAgentMock.mock.calls[0]?.[1];
    const expectedLine = formatUsageLine('main-chat', 'current-session');
    expect(expectedLine).toBe(
      '[host-status] ctx: unknown · session: $0.00 (0 turns) · today: $0.42',
    );
    expect(input).toMatchObject({
      sessionId: 'current-session',
      prompt: `${expectedLine}\nrun scheduled work`,
    });
    expect(input.prompt).not.toContain('ctx: 250k/1000k (25%)');
  });

  it('passes the configured context threshold to a scheduled container', async () => {
    const input = await captureScheduledInput(350_000);

    expect(input.contextThreshold).toBe(350_000);
  });

  it('leaves the scheduled context threshold undefined when not configured', async () => {
    const input = await captureScheduledInput();

    expect(input.contextThreshold).toBeUndefined();
  });

  it('passes continuation remaining to the agent verbatim', async () => {
    const remaining = 'line 1\nline 2';
    const now = new Date();
    openWork('main', 'main-chat', 'canary', remaining, now);
    scheduleWorkContinuationsAtTurnEnd('main', now, {
      enabled: true,
      delayMs: 0,
      maxContinuations: 8,
      maxWorkHours: 4,
    });

    startSchedulerLoop({
      registeredGroups: () => ({
        'main-chat': {
          name: 'Main',
          folder: 'main',
          isMain: true,
          trigger: '@Andy',
          added_at: now.toISOString(),
        },
      }),
      getSessions: () => ({ main: 'current-session' }),
      queue: {
        enqueueTask: (
          _groupJid: string,
          _taskId: string,
          run: () => Promise<void>,
        ) => {
          void run();
        },
      } as unknown as SchedulerDependencies['queue'],
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const input = runContainerAgentMock.mock.calls[0]?.[1];
    expect(input.prompt.split('\n')).toEqual(remaining.split('\n'));
    expect(input.isWorkContinuation).toBe(true);
  });

  it('wakes a continuation at its delay instead of waiting for the poll loop', async () => {
    const now = new Date();
    openWork('main', 'main-chat', 'canary', 'continue', now);
    scheduleWorkContinuationsAtTurnEnd('main', now, {
      enabled: true,
      delayMs: 300_001,
      maxContinuations: 8,
      maxWorkHours: 4,
    });

    startSchedulerLoop({
      registeredGroups: () => ({
        'main-chat': {
          name: 'Main',
          folder: 'main',
          isMain: true,
          trigger: '@Andy',
          added_at: now.toISOString(),
        },
      }),
      getSessions: () => ({ main: 'current-session' }),
      queue: {
        enqueueTask: (
          _groupJid: string,
          _taskId: string,
          run: () => Promise<void>,
        ) => {
          void run();
        },
      } as unknown as SchedulerDependencies['queue'],
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(300_000);
    expect(runContainerAgentMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(runContainerAgentMock).toHaveBeenCalledTimes(1);
  });

  it('uses the scheduled threshold after the second unique main usage sample', async () => {
    const input = await captureScheduledInput(350_000);
    const state: QueryLoopState = {
      messageCount: 0,
      resultCount: 0,
      assistantUsageMessageIds: new Set(),
    };
    const hook = createContextThresholdHook(state, input.contextThreshold);

    recordMainUsage(state, 'main-1', 350_000);
    expect(await invokeSuccessHook(hook)).toEqual({});
    recordMainUsage(state, 'main-2', 350_000);
    expect(await invokeSuccessHook(hook)).toMatchObject({
      hookSpecificOutput: {
        additionalContext:
          '[context-threshold] ctx=350000. Save the session tail, then refresh the session.',
      },
    });
    expect(await invokeSuccessHook(hook)).toEqual({});
  });

  it('computeNextRun anchors interval tasks to scheduled time to prevent drift', () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString(); // 2s ago
    const task = {
      id: 'drift-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: '60000', // 1 minute
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // Should be anchored to scheduledTime + 60s, NOT Date.now() + 60s
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it('computeNextRun returns null for once-tasks', () => {
    const task = {
      id: 'once-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'once' as const,
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    expect(computeNextRun(task)).toBeNull();
  });

  it('computeNextRun skips missed intervals without infinite loop', () => {
    // Task was due 10 intervals ago (missed)
    const ms = 60000;
    const missedBy = ms * 10;
    const scheduledTime = new Date(Date.now() - missedBy).toISOString();

    const task = {
      id: 'skip-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(ms),
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Must be in the future
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    // Must be aligned to the original schedule grid
    const offset =
      (new Date(nextRun!).getTime() - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });
});
