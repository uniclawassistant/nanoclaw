import { describe, expect, it } from 'vitest';

import { buildTaskVisibilitySnapshot } from './container-runner.js';
import type { OpenWork } from './types.js';

describe('work visibility snapshot', () => {
  it('links pending and claimed continuation rows to their work', () => {
    const work: OpenWork = {
      id: 'audit',
      group_folder: 'main',
      chat_jid: 'tg:owner',
      remaining: 'finish the audit',
      opened_at: '2026-09-15T00:00:00.000Z',
      continuation_count: 4,
      last_continuation_at: '2026-09-15T01:00:00.000Z',
      empty_continuation_count: 1,
      pending_task_id: 'work-continuation:pending',
      claimed_task_id: 'work-continuation:claimed',
      status: 'open',
      halted_reason: null,
    };
    const task = (id: string) => ({
      id,
      groupFolder: 'main',
      prompt: 'finish the audit',
      schedule_type: 'once',
      schedule_value: '2026-09-15T01:00:00.000Z',
      status: 'active',
      next_run: '2026-09-15T01:00:00.000Z',
    });

    const snapshot = buildTaskVisibilitySnapshot(
      [
        task('work-continuation:pending'),
        task('work-continuation:claimed'),
        task('work-continuation:closed'),
        task('ordinary'),
      ],
      [work],
    );

    expect(snapshot[0]).toMatchObject({
      kind: 'work_continuation',
      work: { id: 'audit', continuation_count: 4 },
    });
    expect(snapshot[1]).toMatchObject({
      kind: 'work_continuation',
      work: { id: 'audit', empty_continuation_count: 1 },
    });
    expect(snapshot[2]).toMatchObject({ kind: 'work_continuation' });
    expect(snapshot[3]).toMatchObject({ kind: 'scheduled_task' });
  });
});
