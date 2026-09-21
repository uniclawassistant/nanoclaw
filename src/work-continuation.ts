import crypto from 'crypto';

import {
  CONTINUATION_SILENCE_RESET_HOURS,
  CONTINUATION_DELAY,
  MAX_CONTINUATIONS,
  MAX_WORK_HOURS,
  WORK_CONTINUATIONS_ENABLED,
} from './config.js';
import {
  claimOpenWorkTask,
  closeOpenWork,
  getAllOpenWork,
  getOpenWorkForGroup,
  getOpenWork,
  haltOpenWork,
  recordOpenWorkContinuationOutcome,
  scheduleOpenWorkTask,
  upsertOpenWork,
} from './db.js';
import { OpenWork, WorkHalt } from './types.js';
import { recordWorkEffect } from './work-effect.js';

const WORK_CONTINUATION_TASK_PREFIX = 'work-continuation:';

export interface WorkContinuationConfig {
  enabled: boolean;
  delayMs: number;
  maxContinuations: number;
  silenceResetHours: number;
  maxWorkHours: number;
}

export interface WorkContinuationAlert {
  chatJid: string;
  text: string;
}

interface HaltedWorkReopenPolicy {
  accepted: boolean;
  reason?: string;
  resetContinuationCount: boolean;
  resetEmptyContinuationCount: boolean;
}

const defaultConfig: WorkContinuationConfig = {
  enabled: WORK_CONTINUATIONS_ENABLED,
  delayMs: CONTINUATION_DELAY,
  maxContinuations: MAX_CONTINUATIONS,
  silenceResetHours: CONTINUATION_SILENCE_RESET_HOURS,
  maxWorkHours: MAX_WORK_HOURS,
};

export function openWork(
  groupFolder: string,
  chatJid: string,
  id: string,
  remaining: string,
  now = new Date(),
): { accepted: true; work: OpenWork } | { accepted: false; reason: string } {
  const previous = getOpenWork(groupFolder, id);
  const reopenPolicy = previous
    ? haltedWorkReopenPolicy(previous, now)
    : undefined;
  if (reopenPolicy && !reopenPolicy.accepted) {
    return { accepted: false, reason: reopenPolicy.reason! };
  }
  const result = upsertOpenWork({
    id,
    group_folder: groupFolder,
    chat_jid: chatJid,
    remaining,
    opened_at: now.toISOString(),
    reopenHalted: reopenPolicy?.accepted
      ? {
          resetContinuationCount: reopenPolicy.resetContinuationCount,
          resetEmptyContinuationCount: reopenPolicy.resetEmptyContinuationCount,
        }
      : undefined,
  });
  if (
    result.accepted &&
    (!previous ||
      previous.status === 'halted' ||
      previous.remaining !== result.work.remaining)
  ) {
    recordWorkEffect(groupFolder);
  }
  return result;
}

export function closeWork(groupFolder: string, id: string): boolean {
  const closed = closeOpenWork(groupFolder, id);
  if (closed) recordWorkEffect(groupFolder);
  return closed;
}

export function isWorkContinuationTask(taskId: string): boolean {
  return taskId.startsWith(WORK_CONTINUATION_TASK_PREFIX);
}

export function claimWorkContinuation(taskId: string): OpenWork | undefined {
  if (!isWorkContinuationTask(taskId)) return undefined;
  return claimOpenWorkTask(taskId);
}

export function scheduleWorkContinuationsAtTurnEnd(
  groupFolder: string,
  now = new Date(),
  config: WorkContinuationConfig = defaultConfig,
  onScheduled: (runAt: string) => void = () => {},
): WorkContinuationAlert[] {
  if (!config.enabled) return [];

  const alerts: WorkContinuationAlert[] = [];
  for (const work of getOpenWorkForGroup(groupFolder)) {
    if (work.pending_task_id) continue;

    const halt = continuationLimit(work, now, config);
    if (halt) {
      if (haltOpenWork(work.group_folder, work.id, halt)) {
        alerts.push({
          chatJid: work.chat_jid,
          text: `⚠️ Work continuation stopped for "${work.id}": ${halt.reason}.`,
        });
      }
      continue;
    }

    const nextRun = new Date(now.getTime() + config.delayMs).toISOString();
    const scheduled = scheduleOpenWorkTask(
      work,
      {
        id: `${WORK_CONTINUATION_TASK_PREFIX}${crypto.randomUUID()}`,
        group_folder: work.group_folder,
        chat_jid: work.chat_jid,
        prompt: work.remaining,
        schedule_type: 'once',
        schedule_value: nextRun,
        context_mode: 'group',
        next_run: nextRun,
        status: 'active',
        created_at: now.toISOString(),
      },
      continuationCountHasReset(work, now, config),
    );
    if (scheduled) onScheduled(nextRun);
  }
  return alerts;
}

export function recordWorkContinuationTurnOutcome(
  work: OpenWork,
  hadEffect: boolean,
): WorkContinuationAlert[] {
  const current = recordOpenWorkContinuationOutcome(
    work.group_folder,
    work.id,
    hadEffect,
  );
  if (!current || hadEffect) return [];

  if (current.empty_continuation_count < 2) {
    return [
      {
        chatJid: current.chat_jid,
        text: `⚠️ Work continuation "${current.id}" produced no observable effect. If you are working silently, update remaining with open_work or send a message. It will stop after 2 consecutive empty passes.`,
      },
    ];
  }

  const halt: WorkHalt = {
    kind: 'empty',
    reason: `${current.empty_continuation_count} consecutive empty continuation passes`,
  };
  if (!haltOpenWork(current.group_folder, current.id, halt)) {
    return [];
  }
  return [
    {
      chatJid: current.chat_jid,
      text: `⚠️ Work continuation stopped for "${current.id}": ${halt.reason}.`,
    },
  ];
}

export function haltExpiredOpenWork(
  now = new Date(),
  config: WorkContinuationConfig = defaultConfig,
): WorkContinuationAlert[] {
  if (!config.enabled) return [];
  const alerts: WorkContinuationAlert[] = [];
  for (const work of getAllOpenWork()) {
    const halt = workHoursLimit(work, now, config);
    if (!halt || !haltOpenWork(work.group_folder, work.id, halt)) {
      continue;
    }
    alerts.push({
      chatJid: work.chat_jid,
      text: `⚠️ Work continuation stopped for "${work.id}": ${halt.reason}.`,
    });
  }
  return alerts;
}

function continuationCountHasReset(
  work: OpenWork,
  now: Date,
  config: WorkContinuationConfig,
): boolean {
  if (!work.last_continuation_at) return true;
  const silenceMs =
    now.getTime() - new Date(work.last_continuation_at).getTime();
  return silenceMs >= config.silenceResetHours * 60 * 60 * 1000;
}

function continuationLimit(
  work: OpenWork,
  now: Date,
  config: WorkContinuationConfig,
): WorkHalt | null {
  const continuationCount = continuationCountHasReset(work, now, config)
    ? 0
    : work.continuation_count;
  if (continuationCount >= config.maxContinuations) {
    return {
      kind: 'count',
      reason: `continuation count limit (${config.maxContinuations}) reached before ${config.silenceResetHours} hours of silence`,
    };
  }

  return workHoursLimit(work, now, config);
}

function workHoursLimit(
  work: OpenWork,
  now: Date,
  config: WorkContinuationConfig,
): WorkHalt | null {
  const elapsedMs = now.getTime() - new Date(work.opened_at).getTime();
  const maxWorkMs = config.maxWorkHours * 60 * 60 * 1000;
  if (elapsedMs >= maxWorkMs) {
    return {
      kind: 'hours',
      reason: `MAX_WORK_HOURS (${config.maxWorkHours}) reached`,
    };
  }
  return null;
}

function haltedWorkReopenPolicy(
  work: OpenWork,
  now: Date,
): HaltedWorkReopenPolicy | undefined {
  if (work.status !== 'halted') return undefined;
  const reason = work.halted_reason ?? 'work continuation is halted';
  switch (work.halted_kind) {
    case 'hours':
      return resetHaltedWorkPolicy(true);
    case 'empty':
      return resetHaltedWorkPolicy(false);
    case 'count':
      return silenceWindowReopenPolicy(work, now, reason);
    case 'unknown':
      return silenceWindowReopenPolicy(work, now, reason);
    default:
      return silenceWindowReopenPolicy(work, now, reason);
  }
}

function silenceWindowReopenPolicy(
  work: OpenWork,
  now: Date,
  reason: string,
): HaltedWorkReopenPolicy {
  const resetMs = CONTINUATION_SILENCE_RESET_HOURS * 60 * 60 * 1000;
  const lastContinuationAt = new Date(
    work.last_continuation_at ?? work.opened_at,
  ).getTime();
  const elapsedMs = Math.max(0, now.getTime() - lastContinuationAt);
  if (elapsedMs >= resetMs) return resetHaltedWorkPolicy(true);
  const remaining = formatRemainingSilence(resetMs - elapsedMs);
  return rejectedHaltedWorkPolicy(
    `${reason}; ${remaining} of continuation silence remaining before this name can reopen`,
  );
}

function resetHaltedWorkPolicy(
  resetEmptyContinuationCount: boolean,
): HaltedWorkReopenPolicy {
  return {
    accepted: true,
    resetContinuationCount: true,
    resetEmptyContinuationCount,
  };
}

function rejectedHaltedWorkPolicy(reason: string): HaltedWorkReopenPolicy {
  return {
    accepted: false,
    reason,
    resetContinuationCount: false,
    resetEmptyContinuationCount: false,
  };
}

function formatRemainingSilence(milliseconds: number): string {
  const totalMinutes = Math.max(1, Math.ceil(milliseconds / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} ${hours === 1 ? 'hour' : 'hours'}`);
  if (minutes > 0) {
    parts.push(`${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`);
  }
  return parts.join(' ');
}
