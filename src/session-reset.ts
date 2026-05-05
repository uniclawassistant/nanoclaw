import { execSync as defaultExecSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { containerNamePrefix } from './container-runner.js';

export type ResetMode = 'new' | 'restart';

export interface ResetGroupSessionDeps {
  /**
   * Drops the cached sessionId for `folder` from the host's in-memory map
   * (the one read by runAgent). Only called for mode='new'. The map itself
   * lives in src/index.ts; this is wired as a callback so we don't reach
   * into module-level state from here.
   */
  clearInMemorySession: (folder: string) => void;
  /**
   * Removes the DB session row so a subsequent boot doesn't re-resume.
   * Only called for mode='new'.
   */
  deleteDbSession: (folder: string) => void;
  /**
   * Shell-out for `container list` / `container stop`. Default uses
   * `child_process.execSync`; tests inject a stub.
   */
  execSync?: (cmd: string, opts?: { encoding: 'utf-8' }) => string | Buffer;
  /**
   * Optional logger callback. Real wiring passes pino; tests pass a spy.
   */
  log?: (
    level: 'info' | 'warn',
    msg: string,
    fields: Record<string, unknown>,
  ) => void;
}

/**
 * Reset a group's session — single source of truth shared by Telegram `/new`
 * and the in-conversation `mcp__nanoclaw__reset_session` MCP tool.
 *
 *  - `new`     full reset: stop the running container, delete the SDK JSONL
 *              session, drop the cached sessionId from memory and DB. Next
 *              user message cold-spawns a fresh conversation.
 *  - `restart` container kill only: SDK JSONL + sessions map + DB session row
 *              all preserved. Next user message resumes mid-conversation
 *              through the SDK's `resume` mechanism.
 *
 * Container lookup goes through `containerNamePrefix(folder)` — the same
 * sanitizer used at spawn time — so folders with underscores match correctly.
 * (FED-21 hotfix lesson — see feedback_container_lifecycle_review.md.)
 */
export function resetGroupSession(
  folder: string,
  mode: ResetMode,
  deps: ResetGroupSessionDeps,
): void {
  const exec = deps.execSync ?? defaultExecSync;
  const log = deps.log ?? (() => {});

  try {
    const list = String(
      exec('container list 2>/dev/null', { encoding: 'utf-8' }),
    );
    const prefix = containerNamePrefix(folder);
    for (const line of list.split('\n')) {
      if (line.includes(prefix)) {
        const name = line.trim().split(/\s+/)[0];
        if (name) {
          exec(`container stop ${name} 2>/dev/null`);
          log('info', 'resetGroupSession: container stopped', {
            folder,
            container: name,
            mode,
          });
        }
      }
    }
  } catch {
    // No running container — fine, treat as already-stopped.
  }

  if (mode === 'restart') {
    log('info', 'resetGroupSession: container restart only', { folder });
    return;
  }

  // mode === 'new': also drop SDK JSONL + cached sessionId so the next turn
  // starts from a clean slate.
  const projectDir = path.join(
    DATA_DIR,
    'sessions',
    folder,
    '.claude',
    'projects',
    '-workspace-group',
  );
  if (fs.existsSync(projectDir)) {
    for (const f of fs.readdirSync(projectDir)) {
      if (f.endsWith('.jsonl')) {
        fs.unlinkSync(path.join(projectDir, f));
      }
    }
  }
  deps.clearInMemorySession(folder);
  deps.deleteDbSession(folder);
  log('info', 'resetGroupSession: full reset (mode=new)', { folder });
}
