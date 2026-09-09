import { CronExpressionParser } from 'cron-parser';

export type ScheduleType = 'cron' | 'interval' | 'once';

export function findTaskScheduleType(
  tasks: unknown,
  taskId: string,
): ScheduleType | undefined {
  if (!Array.isArray(tasks)) return undefined;

  const task = tasks.find(
    (candidate) =>
      typeof candidate === 'object' &&
      candidate !== null &&
      'id' in candidate &&
      candidate.id === taskId,
  );
  if (!task || !('schedule_type' in task)) return undefined;

  const scheduleType = task.schedule_type;
  return scheduleType === 'cron' ||
    scheduleType === 'interval' ||
    scheduleType === 'once'
    ? scheduleType
    : undefined;
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
