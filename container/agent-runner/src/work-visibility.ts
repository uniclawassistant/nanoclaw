import { taskStatusEmoji } from './tasks-filter.js';
import fs from 'fs';

export interface VisibleTask {
  id: string;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  status: string;
  next_run: string | null;
  kind?: 'scheduled_task' | 'work_continuation';
  work?: {
    id: string;
    remaining: string;
    continuation_count: number;
    empty_continuation_count: number;
    status: string;
    halted_reason: string | null;
  };
}

export interface VisibleOpenWork {
  id: string;
  group_folder: string;
  remaining: string;
  opened_at: string;
  continuation_count: number;
  last_continuation_at: string | null;
  empty_continuation_count: number;
  pending_task_id: string | null;
  claimed_task_id: string | null;
  status: string;
  halted_reason: string | null;
}

export function readVisibleOpenWorkSnapshot(
  filePath: string,
): VisibleOpenWork[] {
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  if (!Array.isArray(parsed) || !parsed.every(isVisibleOpenWork)) {
    throw new Error('Invalid work snapshot');
  }
  return parsed;
}

export function filterVisibleOpenWorkForGroup(
  work: VisibleOpenWork[],
  groupFolder: string,
  isMain: boolean,
): VisibleOpenWork[] {
  return isMain
    ? work
    : work.filter((item) => item.group_folder === groupFolder);
}

function isVisibleOpenWork(value: unknown): value is VisibleOpenWork {
  if (!value || typeof value !== 'object') return false;
  const work = value as Record<string, unknown>;
  return (
    typeof work.id === 'string' &&
    typeof work.group_folder === 'string' &&
    typeof work.remaining === 'string' &&
    typeof work.opened_at === 'string' &&
    typeof work.continuation_count === 'number' &&
    isNullableString(work.last_continuation_at) &&
    typeof work.empty_continuation_count === 'number' &&
    isNullableString(work.pending_task_id) &&
    isNullableString(work.claimed_task_id) &&
    (work.status === 'open' || work.status === 'halted') &&
    isNullableString(work.halted_reason)
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function preview(text: string): string {
  return text.length > 50 ? `${text.slice(0, 50)}...` : text;
}

export function formatVisibleTask(task: VisibleTask): string {
  if (task.kind === 'work_continuation') {
    if (!task.work) {
      return `- 🔄 [${task.id}] Work continuation (work record no longer present) - ${task.status}, next: ${task.next_run || 'N/A'}`;
    }
    const reason = task.work.halted_reason
      ? `, halted: ${task.work.halted_reason}`
      : '';
    return `- 🔄 [${task.id}] Work "${task.work.id}" continuation #${task.work.continuation_count}: ${preview(task.work.remaining)} - ${task.status}, next: ${task.next_run || 'N/A'}, empty passes: ${task.work.empty_continuation_count}${reason}`;
  }
  return `- ${taskStatusEmoji(task.status)} [${task.id}] ${preview(task.prompt)} (${task.schedule_type}: ${task.schedule_value}) - ${task.status}, next: ${task.next_run || 'N/A'}`;
}

export function formatVisibleOpenWork(work: VisibleOpenWork): string {
  const state =
    work.status === 'halted'
      ? `halted: ${work.halted_reason ?? 'reason unavailable'}`
      : 'open';
  const pending = work.pending_task_id ?? 'none';
  return `- ${work.status === 'halted' ? '⛔' : '▶'} [${work.id}] ${preview(work.remaining)} - ${state}, continuations: ${work.continuation_count}, empty passes: ${work.empty_continuation_count}, pending task: ${pending}`;
}
