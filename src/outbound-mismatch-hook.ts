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
// Both classes are log-only. Class B never sends a message to the chat.
//
// FED-30 — two legitimate silent finishes must NOT trip Class B diagnostics:
//   (a) Scheduled-task / poller wakes. These never run through this hook at all
//       (task-scheduler.ts drives them and never calls checkClassB); on the
//       user-message path they surface as isUserFacing=false. The existing
//       isUserFacing gate covers both.
//   (b) React-as-reply. The agent can answer a user-facing message with a
//       terminal reaction (👌 / 🫡 / 💯 …) and nothing else — that IS a reply,
//       not a deadlock. A bare 👀 does NOT count: it is the transient "working"
//       marker that auto-clears on turn end (see auto-clear-eye.ts), so a
//       react(👀)+freeze still produces a diagnostic warning.

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

const activeTurns = new Map<string, TurnState>();

export function beginTurn(
  jid: string,
  opts: {
    groupName: string;
    isUserFacing: boolean;
  },
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
// on turn end) and must not suppress the Class B diagnostic.
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
}

export function checkClassB(
  state: TurnState,
  raw: string,
  opts: CheckClassBOpts,
): void {
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
}

export const _RAW_SAMPLE_LIMIT = RAW_SAMPLE_LIMIT;
