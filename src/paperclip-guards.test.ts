import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  describeViolations,
  findContainerPaths,
  verifyWrite,
} from './paperclip-guards.js';

describe('findContainerPaths (Guard 1 — path validation)', () => {
  it('rejects the exact CRO-108 container-local attachment path', () => {
    // The real leak: a /workspace/group path posted to peers on other machines.
    const violations = findContainerPaths({
      body: 'See the log at /workspace/group/attachments/cro108.log for details.',
    });
    expect(violations).toEqual([
      { field: 'body', path: '/workspace/group/attachments/cro108.log' },
    ]);
  });

  it('rejects every container-local root', () => {
    const cases = [
      '/workspace/extra/unic-memory/CLAUDE.md',
      '/tmp/task-script.sh',
      '/home/node/.cache/thing',
      '/root/secret',
    ];
    for (const p of cases) {
      expect(findContainerPaths({ body: `path: ${p}` })).toEqual([
        { field: 'body', path: p },
      ]);
    }
  });

  it('reports the field name and finds paths across multiple fields', () => {
    const violations = findContainerPaths({
      title: 'Fix /workspace/group/a.ts',
      description: 'no paths here',
      comment: 'and /tmp/b.log too',
    });
    expect(violations).toEqual([
      { field: 'title', path: '/workspace/group/a.ts' },
      { field: 'comment', path: '/tmp/b.log' },
    ]);
  });

  it('finds multiple paths in a single field', () => {
    const violations = findContainerPaths({
      body: '/workspace/group/a and /workspace/extra/b',
    });
    expect(violations.map((v) => v.path)).toEqual([
      '/workspace/group/a',
      '/workspace/extra/b',
    ]);
  });

  it('passes clean text and ignores null/undefined fields', () => {
    expect(
      findContainerPaths({
        body: 'All good — see the attached excerpt below.',
        title: null,
        description: undefined,
      }),
    ).toEqual([]);
  });

  it('does not false-positive on host paths or substrings', () => {
    expect(
      findContainerPaths({
        body: 'Edited /Users/fedor/clip/self-mod/src and made an attempt; /usr/local/bin is fine.',
      }),
    ).toEqual([]);
  });

  it('does not false-positive on a bare root with no file remainder', () => {
    // A root mentioned generically — "/tmp/" with nothing after it — is not a
    // leaked file link; only a real path with a remainder should trip the guard
    // (Unic, FED-29 nit). Covers end-of-string and mid-sentence (space) roots.
    expect(
      findContainerPaths({
        body: 'Scratch goes under /tmp/ and the mount is /workspace/',
        title: 'Cleared /root/ then /home/node/ wholesale',
      }),
    ).toEqual([]);
  });

  it('produces an actionable, path-listing error message', () => {
    const msg = describeViolations([
      { field: 'body', path: '/workspace/group/cro108.log' },
    ]);
    expect(msg).toContain('inline');
    expect(msg).toContain('/workspace/group/cro108.log');
    expect(msg).toContain('body');
  });
});

describe('verifyWrite (Guard 2 — post-write verify)', () => {
  it('loud-fails on the silent null-body class (incident #2)', () => {
    // The POST "succeeded" (2xx) but the stored comment body came back null.
    const verdict = verifyWrite({
      resource: 'comment',
      httpOk: true,
      httpStatus: 200,
      fetched: { id: 'c1', body: null },
      expect: { body: 'corrected text' },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toMatch(/null-body/);
  });

  it('loud-fails when the re-fetch returns no object (404)', () => {
    const verdict = verifyWrite({
      resource: 'issue',
      httpOk: true,
      httpStatus: 200,
      fetched: null,
      expect: { title: 'X' },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toMatch(/404|null body/);
  });

  it('loud-fails on a stored/sent mismatch', () => {
    const verdict = verifyWrite({
      resource: 'issue',
      httpOk: true,
      httpStatus: 200,
      fetched: { status: 'in_progress' },
      expect: { status: 'done' },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toMatch(/mismatch/);
  });

  it('loud-fails when the write HTTP status was not ok', () => {
    const verdict = verifyWrite({
      resource: 'comment',
      httpOk: false,
      httpStatus: 500,
      fetched: { body: 'text' },
      expect: { body: 'text' },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toMatch(/HTTP 500/);
  });

  it('passes when the stored resource matches what was sent', () => {
    const verdict = verifyWrite({
      resource: 'comment',
      httpOk: true,
      httpStatus: 201,
      fetched: { id: 'c1', body: '  done  ' },
      expect: { body: 'done' },
    });
    expect(verdict).toEqual({ ok: true, problems: [] });
  });
});

describe('dual-home sync (this file vs the agent-runner copy)', () => {
  it('keeps both paperclip-guards.ts copies byte-identical', () => {
    // The module is dual-homed: the root copy is unit-tested here, the
    // agent-runner copy is what the container MCP server imports at runtime.
    // The keep-in-sync header is convention only — this check enforces it so
    // a fix to one copy can never silently skip the other (Unic, FED-29 nit).
    const here = dirname(fileURLToPath(import.meta.url));
    const rootCopy = join(here, 'paperclip-guards.ts');
    const runnerCopy = join(
      here,
      '..',
      'container',
      'agent-runner',
      'src',
      'paperclip-guards.ts',
    );
    expect(readFileSync(runnerCopy, 'utf8')).toBe(
      readFileSync(rootCopy, 'utf8'),
    );
  });
});
