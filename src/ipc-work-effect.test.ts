import fs from 'fs';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const testPaths = vi.hoisted(() => {
  const root = `${process.env.PAPERCLIP_RUN_SCRATCH_DIR || '/tmp'}/nanoclaw-ipc-work-effect-${process.pid}`;
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
    IPC_POLL_INTERVAL: 1_000,
  };
});

import { startIpcWatcher, type IpcDeps } from './ipc.js';
import { _initTestDatabase } from './db.js';
import { getWorkEffectRevision } from './work-effect.js';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  fs.rmSync(testPaths.root, { recursive: true, force: true });
});

describe('IPC work effects', () => {
  it('records delivered messages, documents, and accepted resets', async () => {
    vi.useFakeTimers();
    _initTestDatabase();
    const sourceGroup = 'main';
    const messagesDir = path.join(
      testPaths.dataDir,
      'ipc',
      sourceGroup,
      'messages',
    );
    const tasksDir = path.join(testPaths.dataDir, 'ipc', sourceGroup, 'tasks');
    const groupDir = path.join(testPaths.groupsDir, sourceGroup);
    fs.mkdirSync(messagesDir, { recursive: true });
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'note.txt'), 'evidence');
    fs.writeFileSync(
      path.join(messagesDir, '01-message.json'),
      JSON.stringify({
        type: 'message',
        chatJid: 'main@g.us',
        text: 'progress',
      }),
    );
    fs.writeFileSync(
      path.join(messagesDir, '02-document.json'),
      JSON.stringify({
        type: 'document',
        requestId: 'document-request',
        chatJid: 'main@g.us',
        sourcePath: 'note.txt',
      }),
    );
    fs.writeFileSync(
      path.join(messagesDir, '03-reset.json'),
      JSON.stringify({
        type: 'reset_session',
        requestId: 'reset-request',
        mode: 'restart',
      }),
    );
    fs.writeFileSync(
      path.join(tasksDir, 'task-refusal.json'),
      JSON.stringify({
        type: 'pause_task',
        requestId: 'task-refusal',
        taskId: 'missing-task',
      }),
    );

    const initialRevision = getWorkEffectRevision(sourceGroup);
    const deps: IpcDeps = {
      sendMessage: async () => {},
      sendDocument: async () => ({ ok: true, message_id: 'document-1' }),
      scheduleSessionReset: () => ({ accepted: true }),
      registeredGroups: () => ({
        'main@g.us': {
          name: 'Main',
          folder: sourceGroup,
          trigger: 'always',
          added_at: '2026-09-15T00:00:00.000Z',
          isMain: true,
        },
      }),
      registerGroup: () => {},
      syncGroups: async () => {},
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => {},
      onTasksChanged: () => {},
      getMessage: () => null,
    };

    startIpcWatcher(deps);
    await vi.advanceTimersByTimeAsync(0);

    expect(getWorkEffectRevision(sourceGroup)).toBe(initialRevision + 3);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(
            testPaths.dataDir,
            'ipc',
            sourceGroup,
            'responses',
            'task-refusal.json',
          ),
          'utf-8',
        ),
      ),
    ).toEqual({
      requestId: 'task-refusal',
      success: false,
      error:
        'Task missing-task was not found or is not accessible from this group.',
    });
  });
});
