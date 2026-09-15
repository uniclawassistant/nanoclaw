import { taskStatusEmoji } from './tasks-filter.js';

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
