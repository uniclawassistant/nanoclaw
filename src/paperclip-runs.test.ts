import { AddressInfo } from 'net';

import { describe, expect, it } from 'vitest';

import { computeSignature } from './paperclip-wake.js';
import {
  createPaperclipRunsHandler,
  createWakeStore,
  RUNS_PATH_PREFIX,
  startPaperclipServer,
} from './paperclip-runs.js';

const SILENT_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function sigHeader(
  secret: string,
  ts: number,
  method: string,
  pathForSig: string,
): string {
  const mac = computeSignature(
    secret,
    ts,
    `${method.toUpperCase()}.${pathForSig}`,
  );
  return `t=${ts},v1=${mac}`;
}

async function withServer<T>(
  opts: Parameters<typeof createPaperclipRunsHandler>[0],
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const handler = createPaperclipRunsHandler({
    logger: SILENT_LOGGER,
    ...opts,
  });
  const server = await startPaperclipServer({
    host: '127.0.0.1',
    port: 0,
    handler,
    logger: SILENT_LOGGER,
  });
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('createWakeStore', () => {
  it('records and retrieves a wake by runId', () => {
    const store = createWakeStore({ now: () => 1000 });
    store.recordWake({ runId: 'r1', agentId: 'a1' });
    const rec = store.get('r1');
    expect(rec).toMatchObject({
      runId: 'r1',
      agentId: 'a1',
      status: 'pending',
      startedAt: 1000,
      finishedAt: null,
    });
  });

  it('ignores wakes without a runId', () => {
    const store = createWakeStore();
    store.recordWake({ agentId: 'a1' });
    expect(store.size()).toBe(0);
  });

  it('is idempotent on re-delivery of the same runId', () => {
    let t = 1000;
    const store = createWakeStore({ now: () => t });
    store.recordWake({ runId: 'r1', agentId: 'a1' });
    t = 2000;
    store.recordWake({ runId: 'r1', agentId: 'a1' });
    expect(store.get('r1')?.startedAt).toBe(1000);
  });

  it('markDone moves pending → done with finishedAt', () => {
    let t = 1000;
    const store = createWakeStore({ now: () => t });
    store.recordWake({ runId: 'r1' });
    t = 2500;
    store.markDone('r1');
    const rec = store.get('r1');
    expect(rec?.status).toBe('done');
    expect(rec?.finishedAt).toBe(2500);
  });

  it('markError moves pending → error with message', () => {
    const store = createWakeStore({ now: () => 1000 });
    store.recordWake({ runId: 'r1' });
    store.markError('r1', 'boom');
    const rec = store.get('r1');
    expect(rec?.status).toBe('error');
    expect(rec?.error).toBe('boom');
  });

  it('does not re-transition a terminal run', () => {
    const store = createWakeStore();
    store.recordWake({ runId: 'r1' });
    store.markDone('r1');
    store.markError('r1', 'late');
    expect(store.get('r1')?.status).toBe('done');
  });

  it('evicts oldest entries when capacity exceeded', () => {
    const store = createWakeStore({ capacity: 2 });
    store.recordWake({ runId: 'a' });
    store.recordWake({ runId: 'b' });
    store.recordWake({ runId: 'c' });
    expect(store.size()).toBe(2);
    expect(store.get('a')).toBeUndefined();
    expect(store.get('c')).toBeDefined();
  });

  it('prune removes finished entries older than cutoff', () => {
    let t = 1000;
    const store = createWakeStore({ now: () => t });
    store.recordWake({ runId: 'old' });
    store.markDone('old');
    t = 15000;
    store.recordWake({ runId: 'new' });
    store.markDone('new');
    t = 20000;
    // cutoff = t - olderThanMs = 20000 - 10000 = 10000
    // 'old' finished at 1000 (< 10000) → removed; 'new' finished at 15000 (≥ 10000) → kept
    const removed = store.prune(10000);
    expect(removed).toBe(1);
    expect(store.get('old')).toBeUndefined();
    expect(store.get('new')).toBeDefined();
  });
});

describe('paperclip-runs handler', () => {
  const SECRET = 'runs-test-secret';

  it('returns 200 + run record for bearer-auth lookup of known run', async () => {
    const store = createWakeStore({ now: () => 5000 });
    store.recordWake({ runId: 'r1', agentId: 'a1' });
    await withServer({ secret: SECRET, store }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}${RUNS_PATH_PREFIX}r1`, {
        headers: { authorization: `Bearer ${SECRET}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        runId: 'r1',
        agentId: 'a1',
        status: 'pending',
        startedAt: 5000,
        finishedAt: null,
      });
    });
  });

  it('returns 404 for unknown runId with bearer auth', async () => {
    const store = createWakeStore();
    await withServer({ secret: SECRET, store }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}${RUNS_PATH_PREFIX}missing`, {
        headers: { authorization: `Bearer ${SECRET}` },
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toMatchObject({ runId: 'missing', status: 'not_found' });
    });
  });

  it('accepts HMAC signature over METHOD.path (no body)', async () => {
    const store = createWakeStore({ now: () => 1700000000_000 });
    store.recordWake({ runId: 'r2' });
    await withServer(
      { secret: SECRET, store, now: () => 1700000000_000 },
      async (baseUrl) => {
        const ts = 1700000000;
        const path = `${RUNS_PATH_PREFIX}r2`;
        const res = await fetch(`${baseUrl}${path}`, {
          headers: {
            'x-paperclip-signature': sigHeader(SECRET, ts, 'GET', path),
          },
        });
        expect(res.status).toBe(200);
      },
    );
  });

  it('rejects HMAC outside the replay window', async () => {
    const store = createWakeStore({ now: () => 1700000000_000 });
    store.recordWake({ runId: 'r3' });
    await withServer(
      {
        secret: SECRET,
        store,
        replayWindowSeconds: 60,
        now: () => 1700000000_000,
      },
      async (baseUrl) => {
        const ts = 1700000000 - 120;
        const path = `${RUNS_PATH_PREFIX}r3`;
        const res = await fetch(`${baseUrl}${path}`, {
          headers: {
            'x-paperclip-signature': sigHeader(SECRET, ts, 'GET', path),
          },
        });
        expect(res.status).toBe(401);
      },
    );
  });

  it('rejects wrong bearer', async () => {
    const store = createWakeStore();
    await withServer({ secret: SECRET, store }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}${RUNS_PATH_PREFIX}anything`, {
        headers: { authorization: 'Bearer nope' },
      });
      expect(res.status).toBe(401);
    });
  });

  it('rejects unauthenticated request', async () => {
    const store = createWakeStore();
    await withServer({ secret: SECRET, store }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}${RUNS_PATH_PREFIX}anything`);
      expect(res.status).toBe(401);
    });
  });

  it('404s non-GET methods and non-matching paths', async () => {
    const store = createWakeStore();
    await withServer({ secret: SECRET, store }, async (baseUrl) => {
      const a = await fetch(`${baseUrl}${RUNS_PATH_PREFIX}r1`, {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}` },
      });
      expect(a.status).toBe(404);
      const b = await fetch(`${baseUrl}/other/r1`, {
        headers: { authorization: `Bearer ${SECRET}` },
      });
      expect(b.status).toBe(404);
    });
  });

  it('throws if constructed without a secret', () => {
    const store = createWakeStore();
    expect(() =>
      createPaperclipRunsHandler({ secret: '', store }),
    ).toThrowError(/secret is required/);
  });
});
