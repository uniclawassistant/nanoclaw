import { ASSISTANT_NAME } from './config.js';
import { logger } from './logger.js';

// FED-9 — guard against the two mirror-image outbound mismatches:
//   Class A (recap leak): a turn that already delivered via an MCP outbound
//     tool (send_message / send_image / send_voice / send_file / generate_image
//     / edit_image) ALSO emits trailing plain-text → user sees a duplicate
//     meta-recap right after the real reply.
//   Class B (silent deadlock): a user-facing turn ends with zero outbound —
//     final output empty or wholly inside <internal>...</internal> → user sees
//     silence and assumes the agent hung.
//
// Phase 1 = log-only. Phase 2 (FED-16) = host-side ack-stub on Class B: when
// a Class B trigger fires the hook ships a `[host] ...` message via the
// supplied sendAckStub callback, increments an in-memory counter and warns
// when the per-hour count exceeds SILENT_FINISH_THRESHOLD_PER_HOUR.
//
// FED-30 — two legitimate silent finishes must NOT trip the Class B ack-stub:
//   (a) Scheduled-task / poller wakes. These never run through this hook at all
//       (task-scheduler.ts drives them and never calls checkClassB); on the
//       user-message path they surface as isUserFacing=false. The existing
//       isUserFacing gate covers both.
//   (b) React-as-reply. The agent can answer a user-facing message with a
//       terminal reaction (👌 / 🫡 / 💯 …) and nothing else — that IS a reply,
//       not a deadlock. A bare 👀 does NOT count: it is the transient "working"
//       marker that auto-clears on turn end (see auto-clear-eye.ts), so a
//       react(👀)+freeze must still trip the stub or we re-open the 2026-05-04
//       silent-turn scar.

const EYE_EMOJI = '👀';

export interface TurnState {
  groupName: string;
  jid: string;
  outboundCount: number;
  isUserFacing: boolean;
  // Last emoji the agent set via the react tool this turn (null = none / cleared).
  // A non-null, non-👀 value means the turn was answered with a terminal react.
  lastReactionEmoji: string | null;
}

const RAW_SAMPLE_LIMIT = 2000;
const INTERNAL_RX = /<internal>[\s\S]*?<\/internal>/g;
const INTERNAL_OPEN_RX = /<internal>/g;
// FED-31: the silence-stub must NEVER expose `<internal>` block content to the
// chat. A single neutral string is used regardless of whether the turn was
// truly empty or contained only internal reasoning — the agent's private notes
// are not leakable through this surface. Per-turn diagnostics (rawLen,
// internalBlockCount) still go to logs at `warn` for post-hoc debug.
const ACK_STUB = `[host] ${ASSISTANT_NAME} завершил ход, не отправив сообщения в чат.`;
const SILENT_FINISH_THRESHOLD_DEFAULT = 5;

const activeTurns = new Map<string, TurnState>();

const silentFinish = {
  hour: '',
  hourCount: 0,
  total: 0,
};

function silentFinishThreshold(): number {
  const raw = process.env.SILENT_FINISH_THRESHOLD_PER_HOUR;
  if (!raw) return SILENT_FINISH_THRESHOLD_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : SILENT_FINISH_THRESHOLD_DEFAULT;
}

function bumpSilentFinishCounter(now: Date = new Date()): {
  hour: string;
  hourCount: number;
  total: number;
} {
  const hour = now.toISOString().slice(0, 13);
  if (silentFinish.hour !== hour) {
    silentFinish.hour = hour;
    silentFinish.hourCount = 0;
  }
  silentFinish.hourCount++;
  silentFinish.total++;
  return {
    hour,
    hourCount: silentFinish.hourCount,
    total: silentFinish.total,
  };
}

export function beginTurn(
  jid: string,
  opts: { groupName: string; isUserFacing: boolean },
): TurnState {
  const state: TurnState = {
    groupName: opts.groupName,
    jid,
    outboundCount: 0,
    isUserFacing: opts.isUserFacing,
    lastReactionEmoji: null,
  };
  activeTurns.set(jid, state);
  return state;
}

export function endTurn(jid: string): void {
  activeTurns.delete(jid);
}

export function getActiveTurn(jid: string): TurnState | undefined {
  return activeTurns.get(jid);
}

export function recordOutbound(jid: string): void {
  const state = activeTurns.get(jid);
  if (state) state.outboundCount++;
}

// FED-30 signal (b): record the emoji the agent set via the react tool this
// turn. `emoji === null` is a clear (housekeeping) and resets the marker.
export function recordReaction(jid: string, emoji: string | null): void {
  const state = activeTurns.get(jid);
  if (state) state.lastReactionEmoji = emoji;
}

// A turn counts as answered-by-reaction only when it ended on a terminal,
// non-👀 reaction. A bare 👀 is the transient "working" marker (auto-cleared
// on turn end) and must not suppress the Class B stub.
function turnAnsweredByReaction(state: TurnState): boolean {
  return (
    state.lastReactionEmoji != null && state.lastReactionEmoji !== EYE_EMOJI
  );
}

export function checkClassA(state: TurnState, text: string): void {
  if (state.outboundCount === 0) return;
  if (text.length === 0) return;
  logger.warn(
    {
      group: state.groupName,
      jid: state.jid,
      leakedTextLen: text.length,
      leakedTextSample: text.slice(0, RAW_SAMPLE_LIMIT),
    },
    'CLASS_A_RECAP_LEAK: agent emitted plain text after outbound tool call',
  );
}

export interface CheckClassBOpts {
  hadError: boolean;
  sendAckStub?: (text: string) => Promise<void>;
}

export async function checkClassB(
  state: TurnState,
  raw: string,
  opts: CheckClassBOpts,
): Promise<void> {
  if (opts.hadError) return;
  if (!state.isUserFacing) return; // FED-30 signal (a): scheduled-task / non-user-facing
  if (state.outboundCount > 0) return;
  if (turnAnsweredByReaction(state)) return; // FED-30 signal (b): react-as-reply
  const stripped = raw.replace(INTERNAL_RX, '').trim();
  if (stripped.length > 0) return;
  const internalBlockCount = (raw.match(INTERNAL_OPEN_RX) || []).length;
  logger.warn(
    {
      group: state.groupName,
      jid: state.jid,
      rawLen: raw.length,
      strippedLen: stripped.length,
      internalBlockCount,
      rawSample: raw.slice(0, RAW_SAMPLE_LIMIT),
    },
    'CLASS_B_SILENT_DEADLOCK: user-facing turn ended without outbound',
  );

  if (!opts.sendAckStub) return;

  const { hour, hourCount, total } = bumpSilentFinishCounter();
  logger.info(
    { hour, hourCount, total },
    `silent_finish_count=${hourCount} / hour=${hour} / total=${total}`,
  );

  const threshold = silentFinishThreshold();
  if (hourCount > threshold) {
    logger.warn(
      {
        group: state.groupName,
        jid: state.jid,
        hour,
        hourCount,
        threshold,
      },
      'excess silent finishes',
    );
  }

  await opts.sendAckStub(ACK_STUB);
}

export function _resetSilentFinishCounter(): void {
  silentFinish.hour = '';
  silentFinish.hourCount = 0;
  silentFinish.total = 0;
}

export const _RAW_SAMPLE_LIMIT = RAW_SAMPLE_LIMIT;
