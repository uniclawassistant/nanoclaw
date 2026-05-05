/**
 * Single source of truth for `/tasks` and `mcp__nanoclaw__list_tasks` filter
 * semantics. Used by the Telegram slash handler (src/channels/telegram.ts) and
 * mirrored at container/agent-runner/src/tasks-filter.ts for the MCP tool —
 * keep the two copies byte-identical.
 */

export type TaskFilter = 'active' | 'paused' | 'all';

export interface ParsedTaskFilter {
  filter: TaskFilter;
  unknownArg: string | null;
}

/**
 * Parse a user-supplied filter argument.
 *
 * Empty / whitespace-only input → `active` (default view).
 * Recognised tokens (case-insensitive): `active`, `paused`, `all`.
 * Anything else → falls back to `active` and surfaces the raw token in
 * `unknownArg` so the caller can show a hint.
 */
export function parseTaskFilter(
  arg: string | undefined | null,
): ParsedTaskFilter {
  if (arg == null) return { filter: 'active', unknownArg: null };
  const trimmed = arg.trim();
  if (trimmed.length === 0) return { filter: 'active', unknownArg: null };
  const normalized = trimmed.toLowerCase();
  if (
    normalized === 'active' ||
    normalized === 'paused' ||
    normalized === 'all'
  ) {
    return { filter: normalized, unknownArg: null };
  }
  return { filter: 'active', unknownArg: trimmed };
}

/**
 * Filter a task list by status.
 *
 * - `active` keeps tasks with `status === 'active'` (running + scheduled).
 * - `paused` keeps tasks with `status === 'paused'`.
 * - `all` returns the input unchanged (a fresh array).
 */
export function filterTasksByStatus<T extends { status: string }>(
  tasks: readonly T[],
  filter: TaskFilter,
): T[] {
  if (filter === 'all') return [...tasks];
  if (filter === 'paused') return tasks.filter((t) => t.status === 'paused');
  return tasks.filter((t) => t.status === 'active');
}

/**
 * Single-glyph status indicator for list rows.
 *
 * - `active` → ✓ (running / next-fire pending)
 * - `paused` → ⏸
 * - anything else → ✗ (one-shot already fired, recurring expired, errored)
 */
export function taskStatusEmoji(status: string): string {
  if (status === 'active') return '✓';
  if (status === 'paused') return '⏸';
  return '✗';
}
