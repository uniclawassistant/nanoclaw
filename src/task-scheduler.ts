import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import { ASSISTANT_NAME, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllTasks,
  getDueTasks,
  getTaskById,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { isRespawnTask } from './reset-lifecycle.js';
import { RegisteredGroup, ScheduledTask } from './types.js';
import {
  checkThreshold,
  formatUsageLine,
  getState,
  recordUsage,
} from './usage-tracker.js';
import {
  claimWorkContinuation,
  isWorkContinuationTask,
  scheduleWorkContinuationsAtTurnEnd,
} from './work-continuation.js';

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  /**
   * Persist a respawn task's cold-spawned session back to the group so the
   * bootstrapped session becomes the ongoing one (FED-37). Normal scheduled
   * tasks keep their session ephemeral; only `respawn:` tasks call this.
   */
  persistGroupSession?: (folder: string, sessionId: string) => void;
  /**
   * FED-37: apply a queued session reset before a task spawns, so a task that
   * would otherwise resume a to-be-reset session cold-spawns fresh instead.
   */
  applyPendingResetPreTurn?: (folder: string) => void;
  /**
   * FED-37: apply a queued reset after a task turn ends, with respawn. This is
   * what makes an autonomous self-reset (agent calls reset_session from inside a
   * scheduled-task turn — the primary night use case) actually take effect and
   * bring the group back, instead of hanging until the next inbound message.
   */
  applyPendingResetAtTurnEnd?: (folder: string) => Promise<boolean>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  const isWorkContinuation = isWorkContinuationTask(task.id);
  if (isWorkContinuation && !claimWorkContinuation(task.id)) {
    logger.info({ taskId: task.id }, 'Skipping cancelled work continuation');
    updateTaskAfterRun(task.id, null, 'Cancelled');
    return;
  }
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  // FED-37: apply any reset queued in a prior turn before this task reads the
  // session, so a group-context task cold-spawns fresh instead of resuming a
  // session that was meant to be reset.
  deps.applyPendingResetPreTurn?.(task.group_folder);

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;
  const usageLine = isWorkContinuation
    ? null
    : formatUsageLine(task.chat_jid, sessionId);
  const prompt = usageLine ? `${usageLine}\n${task.prompt}` : task.prompt;

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(task.chat_jid);
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        isWorkContinuation,
        taskId: task.id,
        assistantName: ASSISTANT_NAME,
        script: task.script || undefined,
        contextThreshold: group.containerConfig?.contextThreshold,
      },
      (proc, containerName) =>
        deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        // FED-37: a respawn task cold-spawns a fresh session; persist it back to
        // the group so the bootstrapped session becomes the ongoing one instead
        // of being thrown away when the task completes.
        if (isRespawnTask(task.id) && streamedOutput.newSessionId) {
          deps.persistGroupSession?.(
            task.group_folder,
            streamedOutput.newSessionId,
          );
        }
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Forward result to user (sendMessage handles formatting)
          await deps.sendMessage(task.chat_jid, streamedOutput.result);
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_jid);
          scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
        if (streamedOutput.turnEnd && streamedOutput.usage) {
          recordUsage({
            jid: task.chat_jid,
            sessionId: streamedOutput.newSessionId ?? sessionId ?? null,
            usage: streamedOutput.usage,
            origin: 'scheduled',
          });
          const state = getState(task.chat_jid);
          if (state) {
            const threshold = checkThreshold(state);
            if (threshold) {
              await deps.sendMessage(task.chat_jid, threshold.message);
            }
          }
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (isRespawnTask(task.id) && output.newSessionId) {
      deps.persistGroupSession?.(task.group_folder, output.newSessionId);
    }

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  // FED-37: if the agent called reset_session during this scheduled-task turn
  // (the primary autonomous / night use case), apply it now the turn is over —
  // kill the session and respawn with a bootstrap prompt so the work continues.
  // Runs regardless of task error: a requested self-reset should still take.
  // Respawn tasks are exempt so a fresh bootstrap can't immediately re-reset.
  const resetApplied = isRespawnTask(task.id)
    ? false
    : await deps.applyPendingResetAtTurnEnd?.(task.group_folder);
  if (!resetApplied) {
    const alerts = scheduleWorkContinuationsAtTurnEnd(
      task.group_folder,
      new Date(),
      undefined,
      armSchedulerWake,
    );
    for (const alert of alerts) {
      await deps.sendMessage(alert.chatJid, alert.text);
    }
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

let schedulerRunning = false;
let schedulerDeps: SchedulerDependencies | null = null;
let scheduledPokeTimer: ReturnType<typeof setTimeout> | null = null;
let scheduledPokeAt = Number.POSITIVE_INFINITY;

export function armSchedulerWake(runAt: string): void {
  const timestamp = new Date(runAt).getTime();
  if (!Number.isFinite(timestamp) || timestamp >= scheduledPokeAt) return;
  if (scheduledPokeTimer) clearTimeout(scheduledPokeTimer);
  scheduledPokeAt = timestamp;
  scheduledPokeTimer = setTimeout(
    () => {
      scheduledPokeTimer = null;
      scheduledPokeAt = Number.POSITIVE_INFINITY;
      pokeScheduler();
      armNextWorkContinuation();
    },
    Math.max(0, timestamp - Date.now()),
  );
}

function armNextWorkContinuation(): void {
  const next = getAllTasks()
    .filter(
      (task) =>
        isWorkContinuationTask(task.id) &&
        task.status === 'active' &&
        task.schedule_type === 'once' &&
        task.next_run !== null &&
        new Date(task.next_run).getTime() > Date.now(),
    )
    .sort((left, right) => left.next_run!.localeCompare(right.next_run!))[0];
  if (next?.next_run) armSchedulerWake(next.next_run);
}

/**
 * Enqueue every task whose `next_run` is due. Shared by the periodic loop and
 * the on-demand poke. `enqueueTask` dedupes by task id, so an overlapping poke
 * and loop tick can never double-run the same task.
 */
function enqueueDueTasks(deps: SchedulerDependencies): void {
  const dueTasks = getDueTasks();
  if (dueTasks.length > 0) {
    logger.info({ count: dueTasks.length }, 'Found due tasks');
  }

  for (const task of dueTasks) {
    // Re-check task status in case it was paused/cancelled
    const currentTask = getTaskById(task.id);
    if (!currentTask || currentTask.status !== 'active') {
      continue;
    }

    deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
      runTask(currentTask, deps),
    );
  }
}

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  schedulerDeps = deps;
  logger.info('Scheduler loop started');
  armNextWorkContinuation();

  const loop = async () => {
    try {
      enqueueDueTasks(deps);
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/**
 * Run a due-task check immediately instead of waiting for the next poll tick.
 * Used right after a respawn task is created so a self-reset / `/new` brings the
 * agent back in seconds rather than up to a full poll interval later. Safe to
 * call any time: no-op before the loop starts, and enqueue dedupe prevents any
 * overlap with the periodic tick.
 */
export function pokeScheduler(): void {
  if (!schedulerDeps) return;
  try {
    enqueueDueTasks(schedulerDeps);
  } catch (err) {
    logger.error({ err }, 'pokeScheduler failed');
  }
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
  schedulerDeps = null;
  if (scheduledPokeTimer) clearTimeout(scheduledPokeTimer);
  scheduledPokeTimer = null;
  scheduledPokeAt = Number.POSITIVE_INFINITY;
}
