import fs from 'fs';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const testPaths = vi.hoisted(() => {
  const root = `${process.env.PAPERCLIP_RUN_SCRATCH_DIR || '/tmp'}/nanoclaw-work-visibility-${process.pid}`;
  return {
    root,
    dataDir: `${root}/data`,
    groupsDir: `${root}/groups`,
  };
});

vi.mock('./env.js', () => ({ readEnvFile: () => ({}) }));
vi.mock('./config.js', async () => {
  const actual =
    await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: testPaths.dataDir,
    GROUPS_DIR: testPaths.groupsDir,
  };
});

import { readVisibleOpenWorkSnapshot } from '../container/agent-runner/src/work-visibility.js';
import { writeTasksSnapshot } from './container-runner.js';
import type { OpenWork } from './types.js';

afterEach(() => {
  fs.rmSync(testPaths.root, { recursive: true, force: true });
});

describe('list_work snapshot source', () => {
  it('writes the host snapshot in the shape consumed by the container', () => {
    const work: OpenWork = {
      id: 'audit',
      group_folder: 'main',
      chat_jid: 'tg:owner',
      remaining: 'finish the audit',
      opened_at: '2026-09-15T00:00:00.000Z',
      continuation_count: 4,
      last_continuation_at: '2026-09-15T01:00:00.000Z',
      empty_continuation_count: 1,
      pending_task_id: null,
      claimed_task_id: 'work-continuation:claimed',
      status: 'open',
      halted_reason: null,
    };
    const workFile = path.join(
      testPaths.dataDir,
      'ipc',
      'main',
      'current_open_work.json',
    );

    writeTasksSnapshot('main', true, [], [work]);

    expect(readVisibleOpenWorkSnapshot(workFile)).toEqual([work]);
  });

  it('rejects a snapshot shape the container cannot consume', () => {
    const workFile = path.join(
      testPaths.dataDir,
      'ipc',
      'main',
      'current_open_work.json',
    );
    fs.mkdirSync(path.dirname(workFile), { recursive: true });
    fs.writeFileSync(workFile, JSON.stringify([{ id: 'missing-fields' }]));

    expect(() => readVisibleOpenWorkSnapshot(workFile)).toThrow(
      'Invalid work snapshot',
    );
  });
});
