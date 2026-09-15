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
  haltExpiredOpenWork,
  openWork,
  recordWorkContinuationTurnOutcome,
  scheduleWorkContinuationsAtTurnEnd,
  type WorkContinuationConfig,
} from './work-continuation.js';

const enabledConfig: WorkContinuationConfig = {
  enabled: true,
  delayMs: 300_000,
  maxContinuations: 8,
  silenceResetHours: 6,
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
        text: '⚠️ Work continuation stopped for "canary": continuation count limit (1) reached before 6 hours of silence.',
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
      reason: 'continuation count limit (0) reached before 6 hours of silence',
    });
    expect(getOpenWork('main', 'canary')).toMatchObject({
      remaining: 'remaining',
      continuation_count: 0,
      status: 'halted',
      halted_reason:
        'continuation count limit (0) reached before 6 hours of silence',
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

  it('warns after one empty continuation and stops after two', () => {
    openWork('main', 'tg:owner', 'canary', 'remaining', openedAt);
    const work = getOpenWork('main', 'canary')!;

    const first = recordWorkContinuationTurnOutcome(work, false);
    const second = recordWorkContinuationTurnOutcome(work, false);

    expect(first).toEqual([
      {
        chatJid: 'tg:owner',
        text: '⚠️ Work continuation "canary" produced no observable effect. If you are working silently, update remaining with open_work or send a message. It will stop after 2 consecutive empty passes.',
      },
    ]);
    expect(second).toEqual([
      {
        chatJid: 'tg:owner',
        text: '⚠️ Work continuation stopped for "canary": 2 consecutive empty continuation passes.',
      },
    ]);
    expect(getOpenWork('main', 'canary')).toMatchObject({
      empty_continuation_count: 2,
      status: 'halted',
      halted_reason: '2 consecutive empty continuation passes',
    });
  });

  it('resets the consecutive empty count after an observed effect', () => {
    openWork('main', 'tg:owner', 'canary', 'remaining', openedAt);
    const work = getOpenWork('main', 'canary')!;

    recordWorkContinuationTurnOutcome(work, false);
    recordWorkContinuationTurnOutcome(work, true);
    const afterEffect = recordWorkContinuationTurnOutcome(work, false);

    expect(afterEffect[0].text).toContain('produced no observable effect');
    expect(getOpenWork('main', 'canary')).toMatchObject({
      empty_continuation_count: 1,
      status: 'open',
    });
  });

  it('resets the name counter after six hours of continuation silence', () => {
    const config = {
      ...enabledConfig,
      maxContinuations: 1,
      maxWorkHours: 48,
    };
    openWork('main', 'tg:owner', 'canary', 'remaining', openedAt);
    scheduleWorkContinuationsAtTurnEnd('main', turnEndedAt, config);
    claimWorkContinuation(getAllTasks()[0].id);

    scheduleWorkContinuationsAtTurnEnd(
      'main',
      new Date('2026-08-25T02:01:00.000Z'),
      config,
    );

    expect(getOpenWork('main', 'canary')).toMatchObject({
      continuation_count: 1,
      last_continuation_at: '2026-08-25T02:01:00.000Z',
      status: 'open',
    });
    expect(getAllTasks()).toHaveLength(2);
  });

  it('halts expired work and removes a continuation that has not run', () => {
    openWork('main', 'tg:owner', 'canary', 'remaining', openedAt);
    scheduleWorkContinuationsAtTurnEnd('main', turnEndedAt, enabledConfig);
    const taskId = getAllTasks()[0].id;

    const alerts = haltExpiredOpenWork(
      new Date('2026-08-25T00:00:00.000Z'),
      enabledConfig,
    );

    expect(alerts[0].text).toContain('MAX_WORK_HOURS (4) reached');
    expect(getOpenWork('main', 'canary')?.status).toBe('halted');
    expect(getTaskById(taskId)).toBeUndefined();
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
