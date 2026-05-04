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

export interface TurnState {
  groupName: string;
  jid: string;
  outboundCount: number;
  isUserFacing: boolean;
}

const RAW_SAMPLE_LIMIT = 2000;
const ACK_INTERNAL_SAMPLE_LIMIT = 200;
const INTERNAL_RX = /<internal>[\s\S]*?<\/internal>/g;
const INTERNAL_CONTENT_RX = /<internal>([\s\S]*?)<\/internal>/g;
const INTERNAL_OPEN_RX = /<internal>/g;
const ACK_PREFIX = '[host] Юник ушёл в тишину';
const ACK_FALLBACK = `${ACK_PREFIX} без внутренней записки.`;
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

function extractInternalSample(raw: string): string {
  let combined = '';
  for (const m of raw.matchAll(INTERNAL_CONTENT_RX)) combined += m[1];
  return combined.trim();
}

function buildAckStub(raw: string): string {
  const sample = extractInternalSample(raw);
  if (!sample) return ACK_FALLBACK;
  const truncated =
    sample.length > ACK_INTERNAL_SAMPLE_LIMIT
      ? `${sample.slice(0, ACK_INTERNAL_SAMPLE_LIMIT)}…`
      : sample;
  return `${ACK_PREFIX} (внутренняя записка: ${truncated})`;
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
  if (!state.isUserFacing) return;
  if (state.outboundCount > 0) return;
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

  const ackStub = buildAckStub(raw);
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

  await opts.sendAckStub(ackStub);
}

export function _resetSilentFinishCounter(): void {
  silentFinish.hour = '';
  silentFinish.hourCount = 0;
  silentFinish.total = 0;
}

export const _RAW_SAMPLE_LIMIT = RAW_SAMPLE_LIMIT;
