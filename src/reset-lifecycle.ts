import { randomUUID } from 'crypto';

import {
  MIN_RESET_AGE_MS,
  RESPAWN_CIRCUIT_MAX,
  RESPAWN_CIRCUIT_WINDOW_MS,
} from './config.js';
import type { ScheduledTask } from './types.js';

/**
 * Reset lifecycle guards + autonomous respawn (FED-37).
 *
 * Two failure modes this module defends against, both rooted in an
 * agent-initiated `reset_session mode:new`:
 *
 *   A. A fresh session reads a stale/`unknown` host-status ctx figure right
 *      after a wake, decides "better refresh just in case", and resets itself —
 *      spinning a refresh loop that burns credits with no human in the loop.
 *   B. A legitimate self-reset during autonomous work goes silent, because the
 *      poller only wakes on inbound messages; the night's work stalls until the
 *      user happens to write.
 *
 * The pieces here are pure decisions; `index.ts` owns the mutable state
 * (session-start timestamps, respawn history) and wires them in.
 */

/** One-shot bootstrap tasks are tagged so the scheduler persists their session
 * back to the group (a normal scheduled task's session is ephemeral). */
export const RESPAWN_TASK_ID_PREFIX = 'respawn:';

export function isRespawnTask(taskId: string): boolean {
  return taskId.startsWith(RESPAWN_TASK_ID_PREFIX);
}

export interface AgeGateResult {
  accepted: boolean;
  /** Human-readable refusal, surfaced to the agent as the reset_session error. */
  reason?: string;
}

/**
 * Guard #1 — min-session-age gate. Decides whether an agent-initiated
 * `reset_session mode:new` should be honored. A session younger than
 * `minAgeMs` is almost certainly reacting to an unreliable post-wake ctx
 * reading, so the reset is refused and the agent keeps its current session.
 * `restart` mode and user-initiated `/new` never reach this gate.
 */
export function evaluateResetAgeGate(
  startedAt: number | undefined,
  now: number,
  minAgeMs: number = MIN_RESET_AGE_MS,
): AgeGateResult {
  if (startedAt === undefined) return { accepted: true };
  const ageMs = now - startedAt;
  if (ageMs >= minAgeMs) return { accepted: true };
  const ageMin = Math.max(1, Math.round(ageMs / 60_000));
  const floorMin = Math.round(minAgeMs / 60_000);
  return {
    accepted: false,
    reason:
      `Session is only ~${ageMin} min old (reset floor ${floorMin} min) — reset suppressed to prevent a refresh loop. ` +
      `Right after a wake the host-status ctx figure is unreliable and is not a reason to reset. Keep working in this session.`,
  };
}

export interface CircuitResult {
  allowed: boolean;
  /** History pruned to the window (with `now` appended when allowed). */
  history: number[];
  /** Respawn count in the window, including this one when allowed. */
  count: number;
}

/**
 * Guard #2 — respawn circuit breaker. Caps how many respawns may fire for one
 * group inside a rolling window; beyond the cap it stops respawning so a loop
 * the age gate somehow missed cannot burn credits unattended.
 */
export function evaluateRespawnCircuit(
  history: number[],
  now: number,
  windowMs: number = RESPAWN_CIRCUIT_WINDOW_MS,
  max: number = RESPAWN_CIRCUIT_MAX,
): CircuitResult {
  const pruned = history.filter((t) => now - t < windowMs);
  if (pruned.length >= max) {
    return { allowed: false, history: pruned, count: pruned.length };
  }
  return { allowed: true, history: [...pruned, now], count: pruned.length + 1 };
}

/**
 * Layer A — pre-reset tail flush prompt. Run as one final resumed turn on the
 * still-alive session right before a self-`mode:new` kill, so the handoff tail
 * is guaranteed fresh even if the agent forgot to write it. The agent has full
 * context here; it just needs to persist it to disk. Output is suppressed by
 * the caller — this is a maintenance turn, not a chat message.
 */
export function buildTailFlushPrompt(): string {
  return [
    '[auto-tail] Your session is about to be reset (you requested reset_session mode:new) and the container will stop right after this turn.',
    '',
    'Before it does, use the Write tool to save your handoff tail to /workspace/group/tail.md now — what was happening, what is done, what is next, and anything non-obvious your next session will need. Overwrite any stale tail; do not append blindly.',
    '',
    'Writing that file is the only action this turn: send no chat message and call no tools other than Write.',
  ].join('\n');
}

/**
 * Bootstrap prompt for a respawned session. Tells the fresh agent it woke
 * itself, to restore from its tail and continue pending work — and, crucially,
 * not to reset again on an early ctx reading (discipline layer on top of the
 * age-gate mechanism).
 */
export function buildBootstrapPrompt(): string {
  return [
    '[auto-wake] You just refreshed your own session (self-reset, most likely on a context-size threshold). No new user message triggered this — it is an automatic respawn so your autonomous work does not stall in silence.',
    '',
    '1. Read /workspace/group/tail.md to restore where you left off.',
    '2. Continue any pending work under its "What\'s next".',
    '3. If there is no pending work, end the turn immediately without sending a message — do not idle or burn credits.',
    '',
    'Your context is fresh. Ignore any ctx figure in host-status for the first few minutes after this wake — it is unreliable and is not a reason to reset again. Do not call reset_session during this turn.',
  ].join('\n');
}

/**
 * Build the one-shot scheduled task that respawns a group after a self-reset.
 * Due immediately (`next_run = nowIso`) so it fires on the next scheduler poll;
 * `context_mode: 'group'` cold-spawns (the session was just cleared) and the
 * `respawn:` id prefix makes the scheduler persist the new session back.
 */
export function buildRespawnTask(
  groupFolder: string,
  chatJid: string,
  nowIso: string,
): ScheduledTask {
  return {
    id: `${RESPAWN_TASK_ID_PREFIX}${groupFolder}:${randomUUID()}`,
    group_folder: groupFolder,
    chat_jid: chatJid,
    prompt: buildBootstrapPrompt(),
    script: null,
    schedule_type: 'once',
    schedule_value: 'respawn',
    context_mode: 'group',
    next_run: nowIso,
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: nowIso,
  };
}
