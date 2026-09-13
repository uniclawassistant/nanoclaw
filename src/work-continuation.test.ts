import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  deleteTask,
  getAllTasks,
  getOpenWork,
  getOpenWorkForGroup,
  getTaskById,
} from './db.js';
import {
  claimWorkContinuation,
  closeWork,
  openWork,
  scheduleWorkContinuationsAtTurnEnd,
  type WorkContinuationConfig,
} from './work-continuation.js';

const enabledConfig: WorkContinuationConfig = {
  enabled: true,
  delayMs: 300_000,
  maxContinuations: 8,
  maxWorkHours: 4,
};

const openedAt = new Date('2026-08-24T20:00:00.000Z');
const turnEndedAt = new Date('2026-08-24T20:01:00.000Z');

beforeEach(() => {
  _initTestDatabase();
});

describe('work continuations', () => {
  it('schedules nothing when no work is open', () => {
    scheduleWorkContinuationsAtTurnEnd('main', turnEndedAt, enabledConfig);

    expect(getAllTasks()).toHaveLength(0);
  });

  it('does not schedule when the turn-end check is disabled', () => {
    openWork('main', 'tg:owner', 'canary', 'line 1\nline 2', openedAt);

    scheduleWorkContinuationsAtTurnEnd('main', turnEndedAt, {
      ...enabledConfig,
      enabled: false,
    });

    expect(getAllTasks()).toHaveLength(0);
  });

  it('schedules one continuation with remaining preserved verbatim', () => {
    const remaining = 'line 1\nline 2';
    const onScheduled = vi.fn();
    openWork('main', 'tg:owner', 'canary', remaining, openedAt);

    scheduleWorkContinuationsAtTurnEnd(
      'main',
      turnEndedAt,
      enabledConfig,
      onScheduled,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].prompt.split('\n')).toEqual(remaining.split('\n'));
    expect(tasks[0].next_run).toBe('2026-08-24T20:06:00.000Z');
    expect(onScheduled).toHaveBeenCalledWith('2026-08-24T20:06:00.000Z');
  });

  it('deduplicates repeated declarations and pending continuations by id', () => {
    openWork('main', 'tg:owner', 'canary', 'first', openedAt);
    openWork('main', 'tg:owner', 'canary', 'latest', turnEndedAt);

    scheduleWorkContinuationsAtTurnEnd('main', turnEndedAt, enabledConfig);
    scheduleWorkContinuationsAtTurnEnd('main', turnEndedAt, enabledConfig);

    expect(getOpenWorkForGroup('main')).toHaveLength(1);
    expect(getOpenWork('main', 'canary')).toMatchObject({
      remaining: 'latest',
      continuation_count: 1,
    });
    expect(getAllTasks()).toHaveLength(1);
    expect(getAllTasks()[0].prompt).toBe('latest');
  });

  it('closes work and removes its pending continuation', () => {
    openWork('main', 'tg:owner', 'canary', 'remaining', openedAt);
    scheduleWorkContinuationsAtTurnEnd('main', turnEndedAt, enabledConfig);
    const taskId = getAllTasks()[0].id;

    expect(closeWork('main', 'canary')).toBe(true);

    expect(getOpenWork('main', 'canary')).toBeUndefined();
    expect(getTaskById(taskId)).toBeUndefined();
  });

  it('stops after MAX_CONTINUATIONS and alerts the owner once', () => {
    openWork('main', 'tg:owner', 'canary', 'remaining', openedAt);
    const config = { ...enabledConfig, maxContinuations: 1 };
    scheduleWorkContinuationsAtTurnEnd('main', turnEndedAt, config);
    const firstTask = getAllTasks()[0];
    expect(claimWorkContinuation(firstTask.id)).toBeDefined();

    const alerts = scheduleWorkContinuationsAtTurnEnd(
      'main',
      turnEndedAt,
      config,
    );
    const repeated = scheduleWorkContinuationsAtTurnEnd(
      'main',
      turnEndedAt,
      config,
    );

    expect(alerts).toEqual([
      {
        chatJid: 'tg:owner',
        text: '⚠️ Work continuation stopped for "canary": MAX_CONTINUATIONS (1) reached.',
      },
    ]);
    expect(repeated).toEqual([]);
    expect(getAllTasks()).toHaveLength(1);
  });

  it('rejects reopening a halted id without resetting its limits', () => {
    openWork('main', 'tg:owner', 'canary', 'remaining', openedAt);
    const config = { ...enabledConfig, maxContinuations: 0 };
    scheduleWorkContinuationsAtTurnEnd('main', turnEndedAt, config);

    const result = openWork(
      'main',
      'tg:owner',
      'canary',
      'replacement',
      turnEndedAt,
    );

    expect(result).toEqual({
      accepted: false,
      reason: 'MAX_CONTINUATIONS (0) reached',
    });
    expect(getOpenWork('main', 'canary')).toMatchObject({
      remaining: 'remaining',
      continuation_count: 0,
      status: 'halted',
      halted_reason: 'MAX_CONTINUATIONS (0) reached',
    });
  });

  it('stops after MAX_WORK_HOURS and names the work id and reason', () => {
    openWork('main', 'tg:owner', 'canary', 'remaining', openedAt);

    const alerts = scheduleWorkContinuationsAtTurnEnd(
      'main',
      new Date('2026-08-25T00:00:00.000Z'),
      enabledConfig,
    );

    expect(alerts[0].text).toContain('canary');
    expect(alerts[0].text).toContain('MAX_WORK_HOURS (4) reached');
    expect(getAllTasks()).toHaveLength(0);
  });
});

describe('the woken session can close the work it was woken for', () => {
  function wakeOnOpenWork(): { workId: string; taskId: string } {
    openWork('main', 'tg:owner', 'canary', 'finish the audit', openedAt);
    scheduleWorkContinuationsAtTurnEnd('main', turnEndedAt, enabledConfig);
    const taskId = getAllTasks()[0].id;
    return { workId: 'canary', taskId };
  }

  it('closes by the id of the continuation task that woke it', () => {
    const { taskId } = wakeOnOpenWork();
    claimWorkContinuation(taskId);

    expect(closeWork('main', taskId)).toBe(true);
    expect(getOpenWork('main', 'canary')).toBeUndefined();
  });

  it('closes by the task id even before the continuation is claimed', () => {
    const { taskId } = wakeOnOpenWork();

    expect(closeWork('main', taskId)).toBe(true);
    expect(getOpenWork('main', 'canary')).toBeUndefined();
    expect(getTaskById(taskId)).toBeUndefined();
  });

  it('still closes by the work id', () => {
    const { taskId } = wakeOnOpenWork();
    claimWorkContinuation(taskId);

    expect(closeWork('main', 'canary')).toBe(true);
    expect(getOpenWork('main', 'canary')).toBeUndefined();
  });

  it('reports false for an id that names neither a work nor its continuation', () => {
    wakeOnOpenWork();

    expect(closeWork('main', 'work-continuation:not-a-real-row')).toBe(false);
    expect(getOpenWork('main', 'canary')).toBeDefined();
  });

  it('does not let one group close the work of another by task id', () => {
    const { taskId } = wakeOnOpenWork();

    expect(closeWork('other', taskId)).toBe(false);
    expect(getOpenWork('main', 'canary')).toBeDefined();
  });
});

describe('deleting a continuation row', () => {
  it('does not throw while open_work still points at it', () => {
    openWork('main', 'tg:owner', 'canary', 'finish the audit', openedAt);
    scheduleWorkContinuationsAtTurnEnd('main', turnEndedAt, enabledConfig);
    const taskId = getAllTasks()[0].id;

    expect(() => deleteTask(taskId)).not.toThrow();
    expect(getTaskById(taskId)).toBeUndefined();
  });

  it('leaves the work open, so cancelling the row alone is not enough', () => {
    openWork('main', 'tg:owner', 'canary', 'finish the audit', openedAt);
    scheduleWorkContinuationsAtTurnEnd('main', turnEndedAt, enabledConfig);
    deleteTask(getAllTasks()[0].id);

    scheduleWorkContinuationsAtTurnEnd(
      'main',
      new Date(turnEndedAt.getTime() + 60_000),
      enabledConfig,
    );

    expect(getAllTasks()).toHaveLength(1);
    expect(getOpenWorkForGroup('main')).toHaveLength(1);
  });
});
