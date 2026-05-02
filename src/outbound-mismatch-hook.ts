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
// Phase 1 = log-only. Both detectors emit a structured logger.warn with a raw
// sample so we can grep nanoclaw.log and decide on Phase 2 (suppress / auto-ack)
// after a couple weeks of real-world data.

export interface TurnState {
  groupName: string;
  jid: string;
  outboundCount: number;
  isUserFacing: boolean;
}

const RAW_SAMPLE_LIMIT = 2000;
const INTERNAL_RX = /<internal>[\s\S]*?<\/internal>/g;
const INTERNAL_OPEN_RX = /<internal>/g;

const activeTurns = new Map<string, TurnState>();

export function beginTurn(
  jid: string,
  opts: { groupName: string; isUserFacing: boolean },
): TurnState {
  const state: TurnState = {
    groupName: opts.groupName,
    jid,
    outboundCount: 0,
    isUserFacing: opts.isUserFacing,
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

export function checkClassB(
  state: TurnState,
  raw: string,
  opts: { hadError: boolean },
): void {
  if (opts.hadError) return;
  if (!state.isUserFacing) return;
  if (state.outboundCount > 0) return;
  const stripped = raw.replace(INTERNAL_RX, '').trim();
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
