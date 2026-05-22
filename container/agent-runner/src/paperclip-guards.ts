/**
 * Paperclip outbound guards — FED-29 Phase 1 (Guards 1 + 2).
 *
 * Pure, dependency-free logic so the root vitest suite can unit-test it. A
 * byte-identical copy lives at `src/paperclip-guards.ts` (the same dual-home
 * pattern as `tasks-filter.ts`): the container MCP server imports the
 * agent-runner copy at runtime; the root copy is what the tests import. Keep
 * the two files in sync.
 *
 * Guard 1 — path validation: reject container-local filesystem paths in any
 *   outbound text field. Such paths (e.g. `/workspace/group/...`) are dead
 *   links for peers on other machines — the CRO-108 leak class. The caller
 *   should inline the file's contents (an excerpt / fenced block) instead.
 *
 * Guard 2 — post-write verify: after a POST/PATCH, re-fetch the resource and
 *   loud-fail if it is missing (404 / null body), the written field is
 *   null/absent (the silent null-body class), or the stored value does not
 *   match what was sent.
 */

/**
 * Container-local filesystem roots that must never appear in outbound text.
 * Matches an absolute path under one of these roots: root + `/` + at least one
 * non-space remainder char. A bare root — with or without a trailing slash
 * (`/tmp`, `/tmp/`) — is not matched: every observed leak was a real file path,
 * and requiring a remainder char keeps false positives near zero.
 */
export const CONTAINER_PATH_PATTERN =
  /\/(?:workspace|tmp|home\/node|root)\/[^\s"'`)\]}>,]+/g;

export interface PathViolation {
  /** Which outbound field the path was found in (e.g. "body", "title"). */
  field: string;
  /** The offending container-local path. */
  path: string;
}

/**
 * Guard 1. Scan the given outbound text fields for container-local paths.
 * Returns one violation per match; an empty array means the payload is clean.
 */
export function findContainerPaths(
  fields: Record<string, string | null | undefined>,
): PathViolation[] {
  const violations: PathViolation[] = [];
  for (const [field, value] of Object.entries(fields)) {
    if (!value) continue;
    // Fresh regex per field — a shared /g regex carries lastIndex between calls.
    const re = new RegExp(CONTAINER_PATH_PATTERN.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = re.exec(value)) !== null) {
      violations.push({ field, path: match[0] });
      if (match.index === re.lastIndex) re.lastIndex++; // guard against zero-width
    }
  }
  return violations;
}

/**
 * Render Guard-1 violations into an actionable error message for the agent.
 */
export function describeViolations(violations: PathViolation[]): string {
  const list = violations.map((v) => `  • ${v.field}: ${v.path}`).join('\n');
  return (
    'Outbound payload references container-local paths that peers on other ' +
    'machines cannot open (dead links — the CRO-108 class). Remove them and ' +
    'inline the relevant file contents (an excerpt or fenced block) instead:\n' +
    list
  );
}

export interface WriteVerification {
  ok: boolean;
  /** Human-readable reasons the write could not be confirmed. */
  problems: string[];
}

function truncate(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Guard 2. Confirm a write actually persisted, given the re-fetched resource.
 *
 * Loud-fails when: the write HTTP status was not ok, the re-fetch returned no
 * object (404 / null body), an expected field is null/absent (the silent
 * null-body class), or a stored value does not match what was sent.
 */
export function verifyWrite(opts: {
  /** Label used in messages, e.g. "comment" or "issue". */
  resource: string;
  /** Whether the original POST/PATCH returned a 2xx. */
  httpOk: boolean;
  httpStatus: number;
  /** The re-fetched resource (parsed JSON), or null if it could not be read. */
  fetched: unknown;
  /** Fields that must be present on the re-fetched resource with these values. */
  expect: Record<string, string>;
}): WriteVerification {
  const problems: string[] = [];

  if (!opts.httpOk) {
    problems.push(`write returned HTTP ${opts.httpStatus}`);
  }

  if (opts.fetched == null || typeof opts.fetched !== 'object') {
    problems.push(
      `re-fetch of the ${opts.resource} returned no object ` +
        '(possible 404 / null body — the write may not have persisted)',
    );
    return { ok: false, problems };
  }

  const obj = opts.fetched as Record<string, unknown>;
  for (const [key, sent] of Object.entries(opts.expect)) {
    const stored = obj[key];
    if (stored == null) {
      problems.push(
        `${opts.resource}.${key} is null/absent after write ` +
          '(silent null-body class — not persisted)',
      );
    } else if (String(stored).trim() !== sent.trim()) {
      problems.push(
        `${opts.resource}.${key} mismatch — sent ` +
          `${JSON.stringify(truncate(sent))}, ` +
          `stored ${JSON.stringify(truncate(String(stored)))}`,
      );
    }
  }

  return { ok: problems.length === 0, problems };
}
