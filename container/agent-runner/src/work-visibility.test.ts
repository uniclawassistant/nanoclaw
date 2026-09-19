import { describe, expect, it } from 'vitest';

import {
  filterVisibleOpenWorkForGroup,
  formatVisibleOpenWork,
  formatVisibleTask,
  type VisibleOpenWork,
} from './work-visibility.js';

const haltedWork: VisibleOpenWork = {
  id: 'audit',
  group_folder: 'main',
  remaining: 'finish the audit',
  opened_at: '2026-09-15T00:00:00.000Z',
  continuation_count: 20,
  last_continuation_at: '2026-09-15T03:00:00.000Z',
  empty_continuation_count: 0,
  pending_task_id: null,
  claimed_task_id: 'work-continuation:claimed',
  status: 'halted',
  halted_reason: 'continuation count limit reached',
};

describe('work visibility formatting', () => {
  it('distinguishes a continuation row from an ordinary scheduled task', () => {
    const row = formatVisibleTask({
      id: 'work-continuation:claimed',
      prompt: 'finish the audit',
      schedule_type: 'once',
      schedule_value: '2026-09-15T03:00:00.000Z',
      status: 'completed',
      next_run: null,
      kind: 'work_continuation',
      work: haltedWork,
    });

    expect(row).toContain('🔄');
    expect(row).toContain('Work "audit" continuation #20');
    expect(row).toContain('halted: continuation count limit reached');
  });

  it('keeps the ordinary task format free of work labels', () => {
    const row = formatVisibleTask({
      id: 'daily-report',
      prompt: 'Send the report',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      status: 'active',
      next_run: '2026-09-16T09:00:00.000Z',
      kind: 'scheduled_task',
    });

    expect(row).toContain('✓ [daily-report]');
    expect(row).not.toContain('continuation #');
  });

  it('still labels a continuation after its work record is gone', () => {
    const row = formatVisibleTask({
      id: 'work-continuation:closed',
      prompt: 'finished',
      schedule_type: 'once',
      schedule_value: '2026-09-15T03:00:00.000Z',
      status: 'completed',
      next_run: null,
      kind: 'work_continuation',
    });

    expect(row).toContain('🔄');
    expect(row).toContain('work record no longer present');
  });

  it('shows a halted work reason without requiring its task row', () => {
    const row = formatVisibleOpenWork(haltedWork);

    expect(row).toContain('⛔ [audit]');
    expect(row).toContain('halted: continuation count limit reached');
    expect(row).toContain('continuations: 20');
  });

  it('filters foreign work again before a non-main group formats it', () => {
    const foreignWork: VisibleOpenWork = {
      ...haltedWork,
      id: 'foreign-work-id',
      group_folder: 'other-group',
      remaining: 'foreign private remaining',
      halted_reason: 'foreign private halt reason',
    };

    const visible = filterVisibleOpenWorkForGroup(
      [haltedWork, foreignWork],
      'main',
      false,
    );
    const output = visible.map(formatVisibleOpenWork).join('\n');

    expect(output).toContain('[audit]');
    expect(output).not.toContain('foreign-work-id');
    expect(output).not.toContain('foreign private remaining');
    expect(output).not.toContain('foreign private halt reason');
  });
});
