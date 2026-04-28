import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { resolveContainerPathToHost } from './document-paths.js';
import type { RegisteredGroup } from './types.js';

vi.mock('./mount-security.js', () => ({
  validateMount: (mount: { hostPath: string; containerPath?: string }) => {
    const realHostPath = (() => {
      try {
        return fs.realpathSync(mount.hostPath);
      } catch {
        return null;
      }
    })();
    if (!realHostPath) {
      return { allowed: false, reason: 'not found' };
    }
    return {
      allowed: true,
      reason: 'mocked',
      realHostPath,
      resolvedContainerPath:
        mount.containerPath ?? path.basename(mount.hostPath),
      effectiveReadonly: false,
    };
  },
}));

const tmpRoot = path.join(
  fs.realpathSync(os.tmpdir()),
  `nanoclaw-doc-paths-${crypto.randomUUID()}`,
);
const groupsDir = path.join(tmpRoot, 'groups');
const groupFolder = 'main';
const groupDir = path.join(groupsDir, groupFolder);
const extraHostDir = path.join(tmpRoot, 'unic-memory');
const outsideDir = path.join(tmpRoot, 'outside');

const groupNoMounts: RegisteredGroup = {
  name: 'main',
  folder: groupFolder,
  trigger: '',
  added_at: '2026-01-01',
};

const groupWithExtra: RegisteredGroup = {
  ...groupNoMounts,
  containerConfig: {
    additionalMounts: [
      { hostPath: extraHostDir, containerPath: 'unic-memory' },
    ],
  },
};

beforeAll(() => {
  fs.mkdirSync(groupDir, { recursive: true });
  fs.mkdirSync(path.join(groupDir, 'attachments'), { recursive: true });
  fs.writeFileSync(path.join(groupDir, 'note.md'), '# hello');
  fs.writeFileSync(
    path.join(groupDir, 'attachments', 'photo.jpg'),
    Buffer.from('fake-jpeg'),
  );
  fs.mkdirSync(extraHostDir, { recursive: true });
  fs.mkdirSync(path.join(extraHostDir, 'briefs'), { recursive: true });
  fs.writeFileSync(
    path.join(extraHostDir, 'briefs', 'task-send-file-tool.md'),
    '# brief',
  );
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'top secret');
  // Symlink inside the group that escapes outward.
  fs.symlinkSync(
    path.join(outsideDir, 'secret.txt'),
    path.join(groupDir, 'escape-link'),
  );
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('resolveContainerPathToHost', () => {
  it('resolves a relative path from the group root', () => {
    const result = resolveContainerPathToHost(
      'note.md',
      groupFolder,
      groupsDir,
      groupNoMounts,
      true,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.hostPath).toBe(
        fs.realpathSync(path.join(groupDir, 'note.md')),
      );
      expect(result.tracePath).toBe('note.md');
    }
  });

  it('resolves an absolute /workspace/group/ path', () => {
    const result = resolveContainerPathToHost(
      '/workspace/group/attachments/photo.jpg',
      groupFolder,
      groupsDir,
      groupNoMounts,
      true,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tracePath).toBe(path.join('attachments', 'photo.jpg'));
    }
  });

  it('rejects path traversal with .. that escapes the group', () => {
    const result = resolveContainerPathToHost(
      '/workspace/group/../../etc/passwd',
      groupFolder,
      groupsDir,
      groupNoMounts,
      true,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects symlink that escapes the group root', () => {
    const result = resolveContainerPathToHost(
      'escape-link',
      groupFolder,
      groupsDir,
      groupNoMounts,
      true,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/escapes/);
    }
  });

  it('rejects nonexistent files with a clear error', () => {
    const result = resolveContainerPathToHost(
      'no-such-file.bin',
      groupFolder,
      groupsDir,
      groupNoMounts,
      true,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not found/);
  });

  it('rejects paths outside both allowed roots', () => {
    const result = resolveContainerPathToHost(
      '/tmp/foo.txt',
      groupFolder,
      groupsDir,
      groupNoMounts,
      true,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(
        /\/workspace\/group\/.*\/workspace\/extra\//,
      );
    }
  });

  it('resolves /workspace/extra/<mount>/sub when the mount is configured', () => {
    const result = resolveContainerPathToHost(
      '/workspace/extra/unic-memory/briefs/task-send-file-tool.md',
      groupFolder,
      groupsDir,
      groupWithExtra,
      true,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.hostPath).toBe(
        fs.realpathSync(
          path.join(extraHostDir, 'briefs', 'task-send-file-tool.md'),
        ),
      );
      // Container-notation tracePath gives the agent traceback to the
      // original (re-send via send_file, open via Read) without leaking host paths.
      expect(result.tracePath).toBe(
        '/workspace/extra/unic-memory/briefs/task-send-file-tool.md',
      );
    }
  });

  it('rejects /workspace/extra/<unknown> when no such mount is configured', () => {
    const result = resolveContainerPathToHost(
      '/workspace/extra/ghost/anything.txt',
      groupFolder,
      groupsDir,
      groupWithExtra,
      true,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no extra mount/);
  });

  it('rejects /workspace/extra/ when no extras are configured at all', () => {
    const result = resolveContainerPathToHost(
      '/workspace/extra/unic-memory/briefs/task-send-file-tool.md',
      groupFolder,
      groupsDir,
      groupNoMounts,
      true,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects empty paths and /workspace/extra/ without a mount name', () => {
    expect(
      resolveContainerPathToHost(
        '',
        groupFolder,
        groupsDir,
        groupNoMounts,
        true,
      ).ok,
    ).toBe(false);
    const noName = resolveContainerPathToHost(
      '/workspace/extra/',
      groupFolder,
      groupsDir,
      groupWithExtra,
      true,
    );
    expect(noName.ok).toBe(false);
  });
});
