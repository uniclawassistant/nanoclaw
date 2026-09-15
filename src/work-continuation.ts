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
import { OpenWork } from './types.js';
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
  const result = upsertOpenWork({
    id,
    group_folder: groupFolder,
    chat_jid: chatJid,
    remaining,
    opened_at: now.toISOString(),
    reopenHalted: previous ? isWorkHoursLimitHalt(previous) : false,
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

    const limitReason = continuationLimitReason(work, now, config);
    if (limitReason) {
      if (haltOpenWork(work.group_folder, work.id, limitReason)) {
        alerts.push({
          chatJid: work.chat_jid,
          text: `⚠️ Work continuation stopped for "${work.id}": ${limitReason}.`,
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

  const reason = `${current.empty_continuation_count} consecutive empty continuation passes`;
  if (!haltOpenWork(current.group_folder, current.id, reason)) return [];
  return [
    {
      chatJid: current.chat_jid,
      text: `⚠️ Work continuation stopped for "${current.id}": ${reason}.`,
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
    const reason = workHoursLimitReason(work, now, config);
    if (!reason || !haltOpenWork(work.group_folder, work.id, reason)) continue;
    alerts.push({
      chatJid: work.chat_jid,
      text: `⚠️ Work continuation stopped for "${work.id}": ${reason}.`,
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

function continuationLimitReason(
  work: OpenWork,
  now: Date,
  config: WorkContinuationConfig,
): string | null {
  const continuationCount = continuationCountHasReset(work, now, config)
    ? 0
    : work.continuation_count;
  if (continuationCount >= config.maxContinuations) {
    return `continuation count limit (${config.maxContinuations}) reached before ${config.silenceResetHours} hours of silence`;
  }

  return workHoursLimitReason(work, now, config);
}

function workHoursLimitReason(
  work: OpenWork,
  now: Date,
  config: WorkContinuationConfig,
): string | null {
  const elapsedMs = now.getTime() - new Date(work.opened_at).getTime();
  const maxWorkMs = config.maxWorkHours * 60 * 60 * 1000;
  if (elapsedMs >= maxWorkMs) {
    return `MAX_WORK_HOURS (${config.maxWorkHours}) reached`;
  }
  return null;
}

function isWorkHoursLimitHalt(work: OpenWork): boolean {
  return (
    work.status === 'halted' &&
    work.halted_reason?.startsWith('MAX_WORK_HOURS (') === true
  );
}
