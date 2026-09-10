import fs from 'fs';
import { CronExpressionParser } from 'cron-parser';

export type ScheduleType = 'cron' | 'interval' | 'once';

function findTask(
  tasks: unknown,
  taskId: string,
): Record<string, unknown> | undefined {
  if (!Array.isArray(tasks)) return undefined;

  return tasks.find(
    (candidate) =>
      typeof candidate === 'object' &&
      candidate !== null &&
      'id' in candidate &&
      candidate.id === taskId,
  );
}

function toScheduleType(value: unknown): ScheduleType | undefined {
  return value === 'cron' || value === 'interval' || value === 'once'
    ? value
    : undefined;
}

export function findTaskScheduleType(
  tasks: unknown,
  taskId: string,
): ScheduleType | undefined {
  return toScheduleType(findTask(tasks, taskId)?.schedule_type);
}

export function validateTaskScheduleValue(
  scheduleType: ScheduleType | undefined,
  scheduleValue: string | undefined,
): string | undefined {
  if (!scheduleType || !scheduleValue) return undefined;

  if (scheduleType === 'cron') {
    try {
      CronExpressionParser.parse(scheduleValue);
      return undefined;
    } catch {
      return `Invalid cron: "${scheduleValue}".`;
    }
  }

  if (scheduleType === 'interval') {
    const milliseconds = parseInt(scheduleValue, 10);
    return isNaN(milliseconds) || milliseconds <= 0
      ? `Invalid interval: "${scheduleValue}".`
      : undefined;
  }

  if (/[Zz]$/.test(scheduleValue) || /[+-]\d{2}:\d{2}$/.test(scheduleValue)) {
    return `Timestamp must be local time without timezone suffix. Got "${scheduleValue}" — use format like "2026-02-01T15:30:00".`;
  }

  return isNaN(new Date(scheduleValue).getTime())
    ? `Invalid timestamp: "${scheduleValue}". Use local time format like "2026-02-01T15:30:00".`
    : undefined;
}

export function resolveUpdateScheduleError(params: {
  tasksFile: string;
  taskId: string;
  scheduleType: ScheduleType | undefined;
  scheduleValue: string | undefined;
}): string | undefined {
  let scheduleType = params.scheduleType;
  if (params.scheduleValue || params.scheduleType) {
    let snapshotTask: Record<string, unknown> | undefined;
    try {
      if (fs.existsSync(params.tasksFile)) {
        const tasks = JSON.parse(fs.readFileSync(params.tasksFile, 'utf-8'));
        snapshotTask = findTask(tasks, params.taskId);
      }
    } catch (err) {
      return `Failed to read current task schedule: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (
      snapshotTask?.schedule_type === 'once' &&
      snapshotTask.status === 'completed'
    ) {
      return `Task ${params.taskId} has already run. A one-time task is spent — schedule a new one instead of moving this one.`;
    }

    scheduleType = scheduleType ?? toScheduleType(snapshotTask?.schedule_type);
  }

  return validateTaskScheduleValue(scheduleType, params.scheduleValue);
}
