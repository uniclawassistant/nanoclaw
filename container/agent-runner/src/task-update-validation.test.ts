import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findTaskScheduleType,
  resolveUpdateScheduleError,
  validateTaskScheduleValue,
} from './task-update-validation.js';

describe('task update schedule validation', () => {
  it('uses the existing once type when schedule_type is omitted', () => {
    const scheduleType = findTaskScheduleType(
      [
        {
          id: 'task-once',
          schedule_type: 'once',
          schedule_value: '2026-09-10T12:00:00',
        },
      ],
      'task-once',
    );

    expect(scheduleType).toBe('once');
    expect(
      validateTaskScheduleValue(scheduleType, '2026-09-11T12:00:00'),
    ).toBeUndefined();
  });

  it('keeps cron and interval validation unchanged', () => {
    expect(validateTaskScheduleValue('cron', 'not a cron')).toBe(
      'Invalid cron: "not a cron".',
    );
    expect(validateTaskScheduleValue('interval', '0')).toBe(
      'Invalid interval: "0".',
    );
  });
});

describe('update schedule resolution against the task snapshot', () => {
  let snapshotDir: string;
  let tasksFile: string;

  beforeEach(() => {
    snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-snapshot-'));
    tasksFile = path.join(snapshotDir, 'current_tasks.json');
  });

  afterEach(() => {
    fs.rmSync(snapshotDir, { recursive: true, force: true });
  });

  function writeSnapshot(tasks: unknown): void {
    fs.writeFileSync(tasksFile, JSON.stringify(tasks));
  }

  it('rejects a cron value that the snapshot type says is a cron', () => {
    writeSnapshot([{ id: 'task-cron', schedule_type: 'cron' }]);

    expect(
      resolveUpdateScheduleError({
        tasksFile,
        taskId: 'task-cron',
        scheduleType: undefined,
        scheduleValue: 'not a cron',
      }),
    ).toBe('Invalid cron: "not a cron".');
  });

  it('rejects a timezone-suffixed timestamp for a snapshot once task', () => {
    writeSnapshot([{ id: 'task-once', schedule_type: 'once' }]);

    expect(
      resolveUpdateScheduleError({
        tasksFile,
        taskId: 'task-once',
        scheduleType: undefined,
        scheduleValue: '2026-09-11T12:00:00Z',
      }),
    ).toBe(
      'Timestamp must be local time without timezone suffix. Got "2026-09-11T12:00:00Z" — use format like "2026-02-01T15:30:00".',
    );
  });

  it('rejects an unparseable timestamp for a snapshot once task', () => {
    writeSnapshot([{ id: 'task-once', schedule_type: 'once' }]);

    expect(
      resolveUpdateScheduleError({
        tasksFile,
        taskId: 'task-once',
        scheduleType: undefined,
        scheduleValue: 'tomorrow evening',
      }),
    ).toBe(
      'Invalid timestamp: "tomorrow evening". Use local time format like "2026-02-01T15:30:00".',
    );
  });

  it('accepts a local timestamp for a snapshot once task', () => {
    writeSnapshot([{ id: 'task-once', schedule_type: 'once' }]);

    expect(
      resolveUpdateScheduleError({
        tasksFile,
        taskId: 'task-once',
        scheduleType: undefined,
        scheduleValue: '2026-09-11T12:00:00',
      }),
    ).toBeUndefined();
  });

  it('prefers an explicit schedule_type over the snapshot', () => {
    writeSnapshot([{ id: 'task-once', schedule_type: 'once' }]);

    expect(
      resolveUpdateScheduleError({
        tasksFile,
        taskId: 'task-once',
        scheduleType: 'cron',
        scheduleValue: '2026-09-11T12:00:00',
      }),
    ).toBe('Invalid cron: "2026-09-11T12:00:00".');
  });

  it('skips validation when the snapshot has no such task', () => {
    writeSnapshot([{ id: 'other-task', schedule_type: 'cron' }]);

    expect(
      resolveUpdateScheduleError({
        tasksFile,
        taskId: 'task-cron',
        scheduleType: undefined,
        scheduleValue: 'not a cron',
      }),
    ).toBeUndefined();
  });

  it('skips validation when the snapshot file is missing', () => {
    expect(
      resolveUpdateScheduleError({
        tasksFile,
        taskId: 'task-cron',
        scheduleType: undefined,
        scheduleValue: 'not a cron',
      }),
    ).toBeUndefined();
  });

  it('reports a corrupt snapshot instead of validating blindly', () => {
    fs.writeFileSync(tasksFile, '[{"id": "task-once",');

    expect(
      resolveUpdateScheduleError({
        tasksFile,
        taskId: 'task-once',
        scheduleType: undefined,
        scheduleValue: '2026-09-11T12:00:00',
      }),
    ).toMatch(/^Failed to read current task schedule: /);
  });
});

describe('a spent one-time task cannot be moved', () => {
  let snapshotDir: string;
  let tasksFile: string;

  beforeEach(() => {
    snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-spent-'));
    tasksFile = path.join(snapshotDir, 'current_tasks.json');
  });

  afterEach(() => {
    fs.rmSync(snapshotDir, { recursive: true, force: true });
  });

  function writeSnapshot(tasks: unknown): void {
    fs.writeFileSync(tasksFile, JSON.stringify(tasks));
  }

  const spent = {
    id: 'task-spent',
    schedule_type: 'once',
    status: 'completed',
  };

  it('refuses a new value instead of silently accepting it', () => {
    writeSnapshot([spent]);

    expect(
      resolveUpdateScheduleError({
        tasksFile,
        taskId: 'task-spent',
        scheduleType: undefined,
        scheduleValue: '2026-09-11T09:15:00',
      }),
    ).toBe(
      'Task task-spent has already run. A one-time task is spent — schedule a new one instead of moving this one.',
    );
  });

  it('refuses even when the caller states the type explicitly', () => {
    writeSnapshot([spent]);

    expect(
      resolveUpdateScheduleError({
        tasksFile,
        taskId: 'task-spent',
        scheduleType: 'once',
        scheduleValue: '2026-09-11T09:15:00',
      }),
    ).toBe(
      'Task task-spent has already run. A one-time task is spent — schedule a new one instead of moving this one.',
    );
  });

  it('still moves a one-time task that has not run yet', () => {
    writeSnapshot([
      { id: 'task-pending', schedule_type: 'once', status: 'active' },
    ]);

    expect(
      resolveUpdateScheduleError({
        tasksFile,
        taskId: 'task-pending',
        scheduleType: undefined,
        scheduleValue: '2026-09-11T09:15:00',
      }),
    ).toBeUndefined();
  });

  it('leaves recurring tasks alone whatever their status', () => {
    writeSnapshot([
      { id: 'task-cron', schedule_type: 'cron', status: 'completed' },
      { id: 'task-interval', schedule_type: 'interval', status: 'completed' },
    ]);

    expect(
      resolveUpdateScheduleError({
        tasksFile,
        taskId: 'task-cron',
        scheduleType: undefined,
        scheduleValue: '0 9 * * *',
      }),
    ).toBeUndefined();
    expect(
      resolveUpdateScheduleError({
        tasksFile,
        taskId: 'task-interval',
        scheduleType: undefined,
        scheduleValue: '600000',
      }),
    ).toBeUndefined();
  });

  it('refuses a type-only change with no new value', () => {
    writeSnapshot([spent]);

    expect(
      resolveUpdateScheduleError({
        tasksFile,
        taskId: 'task-spent',
        scheduleType: 'once',
        scheduleValue: undefined,
      }),
    ).toBe(
      'Task task-spent has already run. A one-time task is spent — schedule a new one instead of moving this one.',
    );
  });

  it('leaves a prompt-only update alone: nothing about the schedule changes', () => {
    writeSnapshot([spent]);

    expect(
      resolveUpdateScheduleError({
        tasksFile,
        taskId: 'task-spent',
        scheduleType: undefined,
        scheduleValue: undefined,
      }),
    ).toBeUndefined();
  });
});
