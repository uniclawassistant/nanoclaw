import { describe, expect, it } from 'vitest';
import {
  findTaskScheduleType,
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
