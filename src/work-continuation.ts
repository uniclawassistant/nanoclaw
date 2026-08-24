import crypto from 'crypto';

import {
  CONTINUATION_DELAY,
  MAX_CONTINUATIONS,
  MAX_WORK_HOURS,
  WORK_CONTINUATIONS_ENABLED,
} from './config.js';
import {
  claimOpenWorkTask,
  closeOpenWork,
  getOpenWorkForGroup,
  haltOpenWork,
  scheduleOpenWorkTask,
  upsertOpenWork,
} from './db.js';
import { OpenWork } from './types.js';

const WORK_CONTINUATION_TASK_PREFIX = 'work-continuation:';

export interface WorkContinuationConfig {
  enabled: boolean;
  delayMs: number;
  maxContinuations: number;
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
  maxWorkHours: MAX_WORK_HOURS,
};

export function openWork(
  groupFolder: string,
  chatJid: string,
  id: string,
  remaining: string,
  now = new Date(),
): { accepted: true; work: OpenWork } | { accepted: false; reason: string } {
  return upsertOpenWork({
    id,
    group_folder: groupFolder,
    chat_jid: chatJid,
    remaining,
    opened_at: now.toISOString(),
  });
}

export function closeWork(groupFolder: string, id: string): boolean {
  return closeOpenWork(groupFolder, id);
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
    const scheduled = scheduleOpenWorkTask(work, {
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
    });
    if (scheduled) onScheduled(nextRun);
  }
  return alerts;
}

function continuationLimitReason(
  work: OpenWork,
  now: Date,
  config: WorkContinuationConfig,
): string | null {
  if (work.continuation_count >= config.maxContinuations) {
    return `MAX_CONTINUATIONS (${config.maxContinuations}) reached`;
  }

  const elapsedMs = now.getTime() - new Date(work.opened_at).getTime();
  const maxWorkMs = config.maxWorkHours * 60 * 60 * 1000;
  if (elapsedMs >= maxWorkMs) {
    return `MAX_WORK_HOURS (${config.maxWorkHours}) reached`;
  }
  return null;
}
