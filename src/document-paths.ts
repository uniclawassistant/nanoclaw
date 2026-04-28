/**
 * Resolve container-side file paths to their host-side absolute paths for
 * the send_file MCP tool. Enforces that the file lives under one of the
 * agent's allowed roots:
 *   - /workspace/group/...   → DATA_DIR/groups/<sourceGroup>/...
 *   - /workspace/extra/<n>/* → host path of additional mount with that name
 *
 * Anything else, or anything that escapes via .. or symlinks, is rejected.
 */

import fs from 'fs';
import path from 'path';
import type { AdditionalMount, RegisteredGroup } from './types.js';
import { validateMount } from './mount-security.js';

export type ResolveResult =
  | {
      ok: true;
      hostPath: string;
      // Portable container-notation path for persistence and traceback:
      //   group source     → "<rel-from-group>"          e.g. "briefs/x.md"
      //   extra source     → "/workspace/extra/<m>/<sub>"  e.g. "/workspace/extra/unic-memory/briefs/x.md"
      // Stored as file_path so get_message can return it; the agent can
      // re-send or open the original via Read.
      tracePath: string;
    }
  | { ok: false; error: string };

const GROUP_PREFIX = '/workspace/group/';
const EXTRA_PREFIX = '/workspace/extra/';

export function resolveContainerPathToHost(
  containerPath: string,
  sourceGroup: string,
  groupsDir: string,
  group: RegisteredGroup | undefined,
  isMain: boolean,
): ResolveResult {
  if (typeof containerPath !== 'string' || containerPath.length === 0) {
    return { ok: false, error: 'path is empty' };
  }

  // Relative paths are resolved against /workspace/group/ (the agent's CWD).
  let canonical: string;
  if (containerPath.startsWith('/')) {
    canonical = containerPath;
  } else {
    canonical = path.posix.join(GROUP_PREFIX, containerPath);
  }
  // Collapse any . / .. that survived the join. POSIX normalize matches the
  // container's Linux semantics; we re-check the prefix afterwards.
  canonical = path.posix.normalize(canonical);

  if (canonical === '/workspace/group' || canonical.startsWith(GROUP_PREFIX)) {
    const rel =
      canonical === '/workspace/group'
        ? ''
        : canonical.slice(GROUP_PREFIX.length);
    const resolved = resolveUnderRoot(
      path.resolve(groupsDir, sourceGroup),
      rel,
    );
    if (!resolved.ok) return resolved;
    return {
      ok: true,
      hostPath: resolved.hostPath,
      tracePath: resolved.relative,
    };
  }

  if (canonical.startsWith(EXTRA_PREFIX)) {
    const rest = canonical.slice(EXTRA_PREFIX.length);
    const slash = rest.indexOf('/');
    const mountName = slash === -1 ? rest : rest.slice(0, slash);
    const subPath = slash === -1 ? '' : rest.slice(slash + 1);
    if (!mountName) {
      return { ok: false, error: 'extra mount name missing' };
    }

    const mounts: AdditionalMount[] =
      group?.containerConfig?.additionalMounts ?? [];
    for (const m of mounts) {
      const validated = validateMount(m, isMain);
      if (!validated.allowed || !validated.realHostPath) continue;
      if (validated.resolvedContainerPath !== mountName) continue;
      const resolved = resolveUnderRoot(validated.realHostPath, subPath);
      if (!resolved.ok) return resolved;
      const trace = resolved.relative
        ? `${EXTRA_PREFIX}${mountName}/${resolved.relative}`
        : `${EXTRA_PREFIX}${mountName}`;
      return {
        ok: true,
        hostPath: resolved.hostPath,
        tracePath: trace,
      };
    }
    return {
      ok: false,
      error: `no extra mount named "${mountName}" registered for this group`,
    };
  }

  return {
    ok: false,
    error: `path must start with ${GROUP_PREFIX} or ${EXTRA_PREFIX}`,
  };
}

type InternalResolve =
  | { ok: true; hostPath: string; relative: string }
  | { ok: false; error: string };

function resolveUnderRoot(
  rootHostPath: string,
  relPath: string,
): InternalResolve {
  const rootReal = safeRealpath(rootHostPath);
  if (!rootReal) {
    return { ok: false, error: `root path not found: ${rootHostPath}` };
  }
  const candidate = path.resolve(rootReal, relPath);
  // Resolve symlinks so that a symlink pointing outside the root can't sneak
  // through a prefix-only check.
  const candidateReal = safeRealpath(candidate);
  if (!candidateReal) {
    return { ok: false, error: `file not found: ${candidate}` };
  }
  if (
    candidateReal !== rootReal &&
    !candidateReal.startsWith(rootReal + path.sep)
  ) {
    return {
      ok: false,
      error: `path escapes its allowed root (${rootReal})`,
    };
  }
  return {
    ok: true,
    hostPath: candidateReal,
    relative:
      candidateReal === rootReal ? '' : path.relative(rootReal, candidateReal),
  };
}

function safeRealpath(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}
