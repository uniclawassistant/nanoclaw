import fs from 'fs';
import path from 'path';

import { STORE_DIR } from './config.js';
import type { ContainerUsage } from './container-runner.js';
import { logger } from './logger.js';

export interface UsageSession {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
  turns: number;
  startedAt: number;
}

export interface UsageDay {
  date: string;
  costUsd: number;
  turns: number;
}

export interface UsageLastTurn {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  contextUsedTokens: number;
  contextWindow: number | null;
  costUsd: number | null;
  ts: number;
}

export type ThresholdBand = 0 | 0.7 | 0.85 | 0.95;

export interface UsageState {
  jid: string;
  sessionId: string | null;
  lastTurn: UsageLastTurn | null;
  session: UsageSession;
  day: UsageDay;
  warnedThreshold: ThresholdBand;
}

export interface ThresholdEvent {
  band: 0.7 | 0.85 | 0.95;
  pct: number;
  contextK: number;
  contextMaxK: number;
  message: string;
}

export interface RecordUsageInput {
  jid: string;
  sessionId?: string | null;
  usage: ContainerUsage;
  origin: 'interactive' | 'scheduled';
  now?: Date;
}

const TRACKED_BANDS: ThresholdBand[] = [0.95, 0.85, 0.7];
const RESET_BAND_FLOOR = 0.65;

function todayUtc(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function defaultDay(now: Date): UsageDay {
  return { date: todayUtc(now), costUsd: 0, turns: 0 };
}

function defaultSession(now: Date): UsageSession {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd: 0,
    turns: 0,
    startedAt: now.getTime(),
  };
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function getContextMaxDefault(): number {
  return envNumber('CONTEXT_MAX', 1_000_000);
}

export function getThreshold(band: 0.7 | 0.85 | 0.95): number {
  if (band === 0.7) return envNumber('CTX_WARN_THRESHOLD', 0.7);
  if (band === 0.85) return envNumber('CTX_FIRM_THRESHOLD', 0.85);
  return envNumber('CTX_ALERT_THRESHOLD', 0.95);
}

const states = new Map<string, UsageState>();

export function getState(jid: string): UsageState | undefined {
  return states.get(jid);
}

export function _resetForTests(): void {
  states.clear();
}

function ensureState(jid: string, now: Date): UsageState {
  let state = states.get(jid);
  if (!state) {
    state = {
      jid,
      sessionId: null,
      lastTurn: null,
      session: defaultSession(now),
      day: defaultDay(now),
      warnedThreshold: 0,
    };
    states.set(jid, state);
  } else if (state.day.date !== todayUtc(now)) {
    state.day = defaultDay(now);
  }
  return state;
}

function rollSessionIfChanged(
  state: UsageState,
  sessionId: string | null | undefined,
  now: Date,
): void {
  const incoming = sessionId ?? null;
  if (incoming !== null && state.sessionId !== incoming) {
    state.sessionId = incoming;
    state.session = defaultSession(now);
    state.lastTurn = null;
    state.warnedThreshold = 0;
  }
}

export function recordUsage(input: RecordUsageInput): UsageState {
  const now = input.now ?? new Date();
  const state = ensureState(input.jid, now);
  rollSessionIfChanged(state, input.sessionId ?? null, now);

  const u = input.usage;
  state.lastTurn = {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadInputTokens: u.cacheReadInputTokens,
    cacheCreationInputTokens: u.cacheCreationInputTokens,
    contextUsedTokens: u.contextUsedTokens,
    contextWindow: u.contextWindow,
    costUsd: u.totalCostUsd,
    ts: now.getTime(),
  };

  state.session.inputTokens += u.inputTokens;
  state.session.outputTokens += u.outputTokens;
  state.session.cacheReadInputTokens += u.cacheReadInputTokens;
  state.session.cacheCreationInputTokens += u.cacheCreationInputTokens;
  if (u.totalCostUsd !== null) {
    state.session.costUsd += u.totalCostUsd;
    state.day.costUsd += u.totalCostUsd;
  } else {
    logger.warn(
      { jid: input.jid },
      'usage tracker: SDK result missing total_cost_usd, cost not accumulated',
    );
  }
  state.session.turns += 1;
  state.day.turns += 1;

  appendDailyJsonl({
    ts: now.toISOString(),
    jid: input.jid,
    sessionId: state.sessionId,
    cost: u.totalCostUsd,
    input: u.inputTokens,
    output: u.outputTokens,
    cacheRead: u.cacheReadInputTokens,
    cacheCreate: u.cacheCreationInputTokens,
    contextUsed: u.contextUsedTokens,
    contextWindow: u.contextWindow,
    origin: input.origin,
  });

  return state;
}

export function checkThreshold(
  state: UsageState,
  contextMaxOverride?: number,
): ThresholdEvent | null {
  if (!state.lastTurn) return null;
  const max =
    state.lastTurn.contextWindow ??
    contextMaxOverride ??
    getContextMaxDefault();
  if (max <= 0) return null;

  const used = state.lastTurn.contextUsedTokens;
  const ratio = used / max;

  if (ratio < RESET_BAND_FLOOR && state.warnedThreshold !== 0) {
    state.warnedThreshold = 0;
  }

  for (const band of TRACKED_BANDS) {
    if (band === 0) continue;
    const cutoff = getThreshold(band as 0.7 | 0.85 | 0.95);
    if (ratio >= cutoff && (state.warnedThreshold ?? 0) < band) {
      const pct = Math.round(ratio * 100);
      const contextK = Math.round(used / 1000);
      const contextMaxK = Math.round(max / 1000);
      const message = formatThresholdMessage(
        band as 0.7 | 0.85 | 0.95,
        contextK,
        contextMaxK,
        pct,
      );
      state.warnedThreshold = band;
      return {
        band: band as 0.7 | 0.85 | 0.95,
        pct,
        contextK,
        contextMaxK,
        message,
      };
    }
  }
  return null;
}

function formatThresholdMessage(
  band: 0.7 | 0.85 | 0.95,
  contextK: number,
  contextMaxK: number,
  pct: number,
): string {
  if (band === 0.7) {
    return `[host] Context ${contextK}k/${contextMaxK}k (${pct}%) — consider /compact before the next task.`;
  }
  if (band === 0.85) {
    return `[host] Context ${contextK}k/${contextMaxK}k (${pct}%) — recommend /compact now.`;
  }
  return `[host] Context approaching limit (${pct}%) — run /compact or /new now.`;
}

export function formatUsageLine(jid: string): string | null {
  const state = states.get(jid);
  if (!state || !state.lastTurn) return null;

  const max = state.lastTurn.contextWindow ?? getContextMaxDefault();
  const used = state.lastTurn.contextUsedTokens;
  const pct = Math.round((used / max) * 100);
  const ctxK = Math.round(used / 1000);
  const maxK = Math.round(max / 1000);
  const sessionUsd = state.session.costUsd;
  const dayUsd = state.day.costUsd;

  return `[host-status] ctx: ${ctxK}k/${maxK}k (${pct}%) · session: $${sessionUsd.toFixed(2)} (${state.session.turns} turns) · today: $${dayUsd.toFixed(2)}`;
}

export function snapshotForJid(jid: string): {
  context: { current: number; max: number; pct: number } | null;
  session: {
    totalUsd: number;
    turns: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  } | null;
  today: { totalUsd: number; turns: number; date: string } | null;
  lastTurn: UsageLastTurn | null;
} {
  const state = states.get(jid);
  if (!state) {
    return { context: null, session: null, today: null, lastTurn: null };
  }
  const max = state.lastTurn?.contextWindow ?? getContextMaxDefault();
  const used = state.lastTurn?.contextUsedTokens ?? 0;
  return {
    context: {
      current: used,
      max,
      pct: max > 0 ? Math.round((used / max) * 100) : 0,
    },
    session: {
      totalUsd: state.session.costUsd,
      turns: state.session.turns,
      inputTokens: state.session.inputTokens,
      outputTokens: state.session.outputTokens,
      cacheReadInputTokens: state.session.cacheReadInputTokens,
      cacheCreationInputTokens: state.session.cacheCreationInputTokens,
    },
    today: {
      totalUsd: state.day.costUsd,
      turns: state.day.turns,
      date: state.day.date,
    },
    lastTurn: state.lastTurn,
  };
}

interface DailyJsonlEntry {
  ts: string;
  jid: string;
  sessionId: string | null;
  cost: number | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  contextUsed: number;
  contextWindow: number | null;
  origin: 'interactive' | 'scheduled';
}

export function getDailyJsonlPath(): string {
  return (
    process.env.SPEND_DAILY_JSONL_PATH ||
    path.join(STORE_DIR, 'spend-daily.jsonl')
  );
}

function appendDailyJsonl(entry: DailyJsonlEntry): void {
  const filepath = getDailyJsonlPath();
  try {
    fs.mkdirSync(path.dirname(filepath), { recursive: true });
    fs.appendFileSync(filepath, JSON.stringify(entry) + '\n');
  } catch (err) {
    logger.warn(
      { err, filepath },
      'usage tracker: failed to append spend-daily.jsonl',
    );
  }
}
