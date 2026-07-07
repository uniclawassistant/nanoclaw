import { describe, it, expect } from 'vitest';

import {
  buildBootstrapPrompt,
  buildRespawnTask,
  buildTailFlushPrompt,
  evaluateRespawnCircuit,
  evaluateResetAgeGate,
  isRespawnTask,
  RESPAWN_TASK_ID_PREFIX,
} from './reset-lifecycle.js';

const MIN = 60_000;

describe('evaluateResetAgeGate', () => {
  it('accepts when there is no active session (nothing to loop on)', () => {
    expect(evaluateResetAgeGate(undefined, 1_000_000).accepted).toBe(true);
  });

  it('refuses a reset from a session younger than the floor', () => {
    const now = 10 * MIN;
    const startedAt = now - 2 * MIN; // 2 min old
    const res = evaluateResetAgeGate(startedAt, now, 10 * MIN);
    expect(res.accepted).toBe(false);
    expect(res.reason).toMatch(/refresh loop/i);
    expect(res.reason).toMatch(/2 min old/);
  });

  it('accepts once the session is at or past the floor', () => {
    const now = 100 * MIN;
    expect(evaluateResetAgeGate(now - 10 * MIN, now, 10 * MIN).accepted).toBe(
      true,
    );
    expect(
      evaluateResetAgeGate(now - 10 * MIN - 1, now, 10 * MIN).accepted,
    ).toBe(true);
  });

  it('reports at least 1 min for a sub-minute session', () => {
    const now = 5 * MIN;
    const res = evaluateResetAgeGate(now - 5_000, now, 10 * MIN);
    expect(res.reason).toMatch(/~1 min old/);
  });
});

describe('evaluateRespawnCircuit', () => {
  it('allows respawns under the cap and records the timestamp', () => {
    const res = evaluateRespawnCircuit([], 1000, 30 * MIN, 3);
    expect(res.allowed).toBe(true);
    expect(res.history).toEqual([1000]);
    expect(res.count).toBe(1);
  });

  it('trips once the cap is reached inside the window', () => {
    const now = 100 * MIN;
    const history = [now - 5 * MIN, now - 3 * MIN, now - 1 * MIN];
    const res = evaluateRespawnCircuit(history, now, 30 * MIN, 3);
    expect(res.allowed).toBe(false);
    expect(res.count).toBe(3);
    // Tripped: `now` is not appended.
    expect(res.history).toEqual(history);
  });

  it('prunes timestamps outside the window before counting', () => {
    const now = 100 * MIN;
    const history = [now - 40 * MIN, now - 35 * MIN, now - 1 * MIN];
    const res = evaluateRespawnCircuit(history, now, 30 * MIN, 3);
    // Two old entries fall out → only one recent remains → allowed.
    expect(res.allowed).toBe(true);
    expect(res.history).toEqual([now - 1 * MIN, now]);
    expect(res.count).toBe(2);
  });
});

describe('buildRespawnTask', () => {
  it('produces a due, group-context one-shot with a respawn id', () => {
    const iso = '2026-07-07T10:00:00.000Z';
    const task = buildRespawnTask('unic-shared-memory', 'tg:123', iso);
    expect(isRespawnTask(task.id)).toBe(true);
    expect(
      task.id.startsWith(`${RESPAWN_TASK_ID_PREFIX}unic-shared-memory:`),
    ).toBe(true);
    expect(task.schedule_type).toBe('once');
    expect(task.context_mode).toBe('group');
    expect(task.next_run).toBe(iso);
    expect(task.status).toBe('active');
    expect(task.prompt).toBe(buildBootstrapPrompt());
  });
});

describe('isRespawnTask', () => {
  it('only matches the respawn prefix', () => {
    expect(isRespawnTask('respawn:folder:uuid')).toBe(true);
    expect(isRespawnTask('task-123')).toBe(false);
  });
});

describe('prompts', () => {
  it('tail flush prompt directs the Write tool and forbids chat output', () => {
    const p = buildTailFlushPrompt();
    expect(p).toMatch(/\/workspace\/group\/tail\.md/);
    // Must clearly call for the Write tool — otherwise the agent may read
    // "call no tools" as "don't write either" and Layer A silently no-ops.
    expect(p).toMatch(/use the Write tool/i);
    expect(p).toMatch(/send no chat message/i);
  });

  it('bootstrap prompt restores from tail and forbids re-reset', () => {
    const p = buildBootstrapPrompt();
    expect(p).toMatch(/\/workspace\/group\/tail\.md/);
    expect(p).toMatch(/do not call reset_session/i);
  });
});
