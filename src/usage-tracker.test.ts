import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContainerUsage } from './container-runner.js';
import {
  _resetForTests,
  checkThreshold,
  formatUsageLine,
  getDailyJsonlPath,
  getState,
  recordUsage,
  snapshotForJid,
} from './usage-tracker.js';

function makeUsage(partial: Partial<ContainerUsage>): ContainerUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalCostUsd: 0,
    contextWindow: 1_000_000,
    contextUsedTokens: 0,
    numTurns: 1,
    ...partial,
  };
}

let tmpDir: string;

beforeEach(() => {
  _resetForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-tracker-'));
  process.env.SPEND_DAILY_JSONL_PATH = path.join(tmpDir, 'spend.jsonl');
  delete process.env.CONTEXT_MAX;
  delete process.env.CTX_WARN_THRESHOLD;
  delete process.env.CTX_FIRM_THRESHOLD;
  delete process.env.CTX_ALERT_THRESHOLD;
});

afterEach(() => {
  delete process.env.SPEND_DAILY_JSONL_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('recordUsage — per-turn / cumulative math', () => {
  it('aggregates input/output/cost across turns within the same session', () => {
    recordUsage({
      jid: 'g1',
      sessionId: 'sess-A',
      origin: 'interactive',
      usage: makeUsage({
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 10,
        cacheCreationInputTokens: 5,
        totalCostUsd: 0.12,
        contextUsedTokens: 115,
      }),
    });
    recordUsage({
      jid: 'g1',
      sessionId: 'sess-A',
      origin: 'interactive',
      usage: makeUsage({
        inputTokens: 200,
        outputTokens: 80,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 10,
        totalCostUsd: 0.3,
        contextUsedTokens: 230,
      }),
    });

    const state = getState('g1');
    expect(state).toBeDefined();
    expect(state!.session.inputTokens).toBe(300);
    expect(state!.session.outputTokens).toBe(130);
    expect(state!.session.cacheReadInputTokens).toBe(30);
    expect(state!.session.cacheCreationInputTokens).toBe(15);
    expect(state!.session.costUsd).toBeCloseTo(0.42, 6);
    expect(state!.session.turns).toBe(2);
    expect(state!.lastTurn?.contextUsedTokens).toBe(230);
  });

  it('skips cost accumulation when SDK returns null total_cost_usd but still bumps turns/tokens', () => {
    recordUsage({
      jid: 'g1',
      sessionId: 'sess-A',
      origin: 'interactive',
      usage: makeUsage({
        inputTokens: 100,
        outputTokens: 20,
        totalCostUsd: null,
        contextUsedTokens: 100,
      }),
    });

    const state = getState('g1')!;
    expect(state.session.costUsd).toBe(0);
    expect(state.day.costUsd).toBe(0);
    expect(state.session.turns).toBe(1);
    expect(state.session.inputTokens).toBe(100);
  });

  it('resets session totals when sessionId changes (new container session)', () => {
    recordUsage({
      jid: 'g1',
      sessionId: 'sess-A',
      origin: 'interactive',
      usage: makeUsage({ inputTokens: 100, totalCostUsd: 0.1 }),
    });
    recordUsage({
      jid: 'g1',
      sessionId: 'sess-B',
      origin: 'interactive',
      usage: makeUsage({ inputTokens: 50, totalCostUsd: 0.05 }),
    });

    const state = getState('g1')!;
    expect(state.sessionId).toBe('sess-B');
    expect(state.session.inputTokens).toBe(50);
    expect(state.session.costUsd).toBeCloseTo(0.05, 6);
    expect(state.session.turns).toBe(1);
    expect(state.day.costUsd).toBeCloseTo(0.15, 6);
    expect(state.day.turns).toBe(2);
  });

  it('rolls daily totals at UTC midnight', () => {
    recordUsage({
      jid: 'g1',
      sessionId: 'sess-A',
      origin: 'interactive',
      usage: makeUsage({ totalCostUsd: 0.5 }),
      now: new Date('2026-05-03T23:30:00Z'),
    });
    recordUsage({
      jid: 'g1',
      sessionId: 'sess-A',
      origin: 'interactive',
      usage: makeUsage({ totalCostUsd: 0.2 }),
      now: new Date('2026-05-04T00:30:00Z'),
    });

    const state = getState('g1')!;
    expect(state.day.date).toBe('2026-05-04');
    expect(state.day.costUsd).toBeCloseTo(0.2, 6);
    expect(state.day.turns).toBe(1);
    expect(state.session.costUsd).toBeCloseTo(0.7, 6);
    expect(state.session.turns).toBe(2);
  });
});

describe('JSONL persistence', () => {
  it('appends one line per recorded turn with the expected shape', () => {
    recordUsage({
      jid: 'g1',
      sessionId: 'sess-A',
      origin: 'interactive',
      usage: makeUsage({
        inputTokens: 10,
        outputTokens: 5,
        totalCostUsd: 0.01,
        contextUsedTokens: 10,
      }),
      now: new Date('2026-05-04T10:00:00Z'),
    });
    recordUsage({
      jid: 'g1',
      sessionId: 'sess-A',
      origin: 'scheduled',
      usage: makeUsage({
        inputTokens: 20,
        totalCostUsd: null,
        contextUsedTokens: 20,
      }),
      now: new Date('2026-05-04T11:00:00Z'),
    });

    const lines = fs
      .readFileSync(getDailyJsonlPath(), 'utf-8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    expect(first.origin).toBe('interactive');
    expect(first.cost).toBe(0.01);
    expect(first.contextUsed).toBe(10);
    expect(second.origin).toBe('scheduled');
    expect(second.cost).toBeNull();
  });
});

describe('checkThreshold — 70/85/95% bands and anti-spam', () => {
  function recordCtx(jid: string, ctx: number, sessionId = 'sess-A') {
    recordUsage({
      jid,
      sessionId,
      origin: 'interactive',
      usage: makeUsage({
        inputTokens: ctx,
        contextUsedTokens: ctx,
        contextWindow: 1_000_000,
        totalCostUsd: 0.01,
      }),
    });
  }

  it('returns null below 70%', () => {
    recordCtx('g1', 600_000);
    const state = getState('g1')!;
    expect(checkThreshold(state)).toBeNull();
  });

  it('fires 70% band exactly once and remembers it (anti-spam)', () => {
    recordCtx('g1', 700_000);
    const state = getState('g1')!;
    const first = checkThreshold(state);
    expect(first?.band).toBe(0.7);
    expect(first?.message).toContain('compact');
    expect(checkThreshold(state)).toBeNull();
  });

  it('escalates to 85% on next turn even after 70% already warned', () => {
    recordCtx('g1', 700_000);
    const state = getState('g1')!;
    expect(checkThreshold(state)?.band).toBe(0.7);

    recordCtx('g1', 870_000);
    expect(checkThreshold(state)?.band).toBe(0.85);
    expect(checkThreshold(state)).toBeNull();
  });

  it('escalates to 95% (alert) and remains anti-spammed', () => {
    recordCtx('g1', 960_000);
    const state = getState('g1')!;
    const ev = checkThreshold(state);
    expect(ev?.band).toBe(0.95);
    expect(ev?.message).toContain('approaching limit');
    expect(ev?.message).toContain('/new');
    expect(checkThreshold(state)).toBeNull();
  });

  it('resets warned threshold when context drops below 65% (e.g. after compact)', () => {
    recordCtx('g1', 880_000);
    const state = getState('g1')!;
    expect(checkThreshold(state)?.band).toBe(0.85);

    recordCtx('g1', 200_000);
    expect(checkThreshold(state)).toBeNull();
    expect(state.warnedThreshold).toBe(0);

    recordCtx('g1', 720_000);
    expect(checkThreshold(state)?.band).toBe(0.7);
  });

  it('uses CONTEXT_MAX env when SDK does not provide contextWindow', () => {
    process.env.CONTEXT_MAX = '200000';
    recordUsage({
      jid: 'g1',
      sessionId: 'sess-A',
      origin: 'interactive',
      usage: makeUsage({
        contextUsedTokens: 150_000,
        contextWindow: null,
        totalCostUsd: 0.01,
      }),
    });
    const state = getState('g1')!;
    const ev = checkThreshold(state);
    expect(ev?.band).toBe(0.7);
    expect(ev?.contextMaxK).toBe(200);
  });

  it('respects env-overridden threshold values', () => {
    process.env.CTX_WARN_THRESHOLD = '0.5';
    recordUsage({
      jid: 'g1',
      sessionId: 'sess-A',
      origin: 'interactive',
      usage: makeUsage({
        contextUsedTokens: 600_000,
        contextWindow: 1_000_000,
        totalCostUsd: 0.01,
      }),
    });
    const state = getState('g1')!;
    expect(checkThreshold(state)?.band).toBe(0.7);
  });
});

describe('formatUsageLine', () => {
  it('restores today from JSONL before the first turn is recorded', () => {
    const today = new Date().toISOString();
    fs.writeFileSync(
      getDailyJsonlPath(),
      [
        JSON.stringify({
          ts: today,
          jid: 'g1',
          cost: 0.31,
        }),
        JSON.stringify({
          ts: today,
          jid: 'g1',
          cost: 0.11,
        }),
        JSON.stringify({
          ts: today,
          jid: 'other',
          cost: 99,
        }),
      ].join('\n'),
    );

    expect(formatUsageLine('g1', null)).toBe(
      '[host-status] ctx: unknown · session: $0.00 (0 turns) · today: $0.42',
    );
  });

  it('produces a one-liner with ctx / session / today after a turn', () => {
    recordUsage({
      jid: 'g1',
      sessionId: 'sess-A',
      origin: 'interactive',
      usage: makeUsage({
        inputTokens: 200_000,
        outputTokens: 1_000,
        cacheReadInputTokens: 50_000,
        contextUsedTokens: 250_000,
        totalCostUsd: 0.42,
        contextWindow: 1_000_000,
      }),
    });
    const line = formatUsageLine('g1', 'sess-A');
    expect(line).toMatch(/^\[host-status\] ctx: 250k\/1000k \(25%\)/);
    expect(line).toMatch(/session: \$0\.42 \(1 turns\)/);
    expect(line).toMatch(/today: \$0\.42$/);
  });

  // FED-34: the first turn of a fresh session must not inherit the prior
  // session's cached ctx (an inflated counter that would trip the agent's
  // proactive-reset threshold and drop the tail).
  it('reports ctx: unknown on the first turn of a new session (reset)', () => {
    recordUsage({
      jid: 'g1',
      sessionId: 'sess-A',
      origin: 'interactive',
      usage: makeUsage({
        contextUsedTokens: 385_000,
        totalCostUsd: 0.42,
        contextWindow: 1_000_000,
      }),
    });
    // mode='new' cleared the cached sessionId; the next turn resumes nothing.
    const line = formatUsageLine('g1', null);
    expect(line).toBe(
      '[host-status] ctx: unknown · session: $0.00 (0 turns) · today: $0.42',
    );
  });

  it('reports ctx: unknown when a different session is about to run', () => {
    recordUsage({
      jid: 'g1',
      sessionId: 'sess-A',
      origin: 'interactive',
      usage: makeUsage({
        contextUsedTokens: 385_000,
        totalCostUsd: 0.42,
        contextWindow: 1_000_000,
      }),
    });
    const line = formatUsageLine('g1', 'sess-B');
    expect(line).toMatch(/^\[host-status\] ctx: unknown/);
    expect(line).toMatch(/session: \$0\.00 \(0 turns\)/);
  });

  it('reports the real ctx once the new session has recorded its own turn', () => {
    recordUsage({
      jid: 'g1',
      sessionId: 'sess-A',
      origin: 'interactive',
      usage: makeUsage({ contextUsedTokens: 385_000, totalCostUsd: 0.42 }),
    });
    // Second turn belongs to sess-B; recordUsage rolls the session forward.
    recordUsage({
      jid: 'g1',
      sessionId: 'sess-B',
      origin: 'interactive',
      usage: makeUsage({
        contextUsedTokens: 64_000,
        totalCostUsd: 0.05,
        contextWindow: 1_000_000,
      }),
    });
    const line = formatUsageLine('g1', 'sess-B');
    expect(line).toMatch(/^\[host-status\] ctx: 64k\/1000k \(6%\)/);
    expect(line).toMatch(/session: \$0\.05 \(1 turns\)/);
  });
});

describe('snapshotForJid', () => {
  it('returns nulls for unknown jid', () => {
    const snap = snapshotForJid('nope');
    expect(snap).toEqual({
      context: null,
      session: null,
      today: null,
      lastTurn: null,
    });
  });

  it('returns full snapshot after recording', () => {
    recordUsage({
      jid: 'g1',
      sessionId: 'sess-A',
      origin: 'interactive',
      usage: makeUsage({
        inputTokens: 100,
        outputTokens: 20,
        contextUsedTokens: 100,
        contextWindow: 1_000_000,
        totalCostUsd: 0.05,
      }),
    });
    const snap = snapshotForJid('g1');
    expect(snap.context?.current).toBe(100);
    expect(snap.context?.max).toBe(1_000_000);
    expect(snap.session?.totalUsd).toBeCloseTo(0.05, 6);
    expect(snap.today?.turns).toBe(1);
    expect(snap.lastTurn?.costUsd).toBeCloseTo(0.05, 6);
  });
});
