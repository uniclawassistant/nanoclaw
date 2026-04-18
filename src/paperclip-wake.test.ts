import crypto from 'crypto';
import { AddressInfo } from 'net';

import { describe, expect, it, vi } from 'vitest';

import {
  computeSignature,
  createPaperclipWakeHandler,
  HEALTH_PATH,
  PaperclipWakePayload,
  startPaperclipWakeServer,
  verifyWakeAuth,
  WAKE_PATH,
  type WakeStream,
} from './paperclip-wake.js';

const SILENT_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

/**
 * Sign `${ts}.${body}` exactly how the shipped adapter signs it in
 * `@fury_ios/nanoclaw-paperclip-adapter@0.1.3/src/hmac.ts:signPayload`.
 */
function signHeaders(
  secret: string,
  ts: number,
  body: string,
): Record<string, string> {
  return {
    'x-paperclip-timestamp': String(ts),
    'x-paperclip-signature': computeSignature(secret, ts, body),
  };
}

async function postRaw(
  baseUrl: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; contentType: string; body: string }> {
  const res = await fetch(`${baseUrl}${WAKE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
  const text = await res.text();
  return {
    status: res.status,
    contentType: res.headers.get('content-type') ?? '',
    body: text,
  };
}

async function withServer<T>(
  opts: Parameters<typeof startPaperclipWakeServer>[0],
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = await startPaperclipWakeServer({
    logger: SILENT_LOGGER,
    ...opts,
  });
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('computeSignature (pinned canonical form)', () => {
  it('matches HMAC-SHA256 over "${t}.${body}"', () => {
    // This pin reproduces the adapter-side signPayload() verbatim. If this
    // breaks, the nanoclaw daemon has diverged from the contract.
    const ref = crypto
      .createHmac('sha256', 'k')
      .update('100.{"a":1}')
      .digest('hex');
    expect(computeSignature('k', 100, '{"a":1}')).toBe(ref);
  });

  it('signs empty body (GET poll / health probe) as "${t}."', () => {
    const ref = crypto.createHmac('sha256', 'k').update('100.').digest('hex');
    expect(computeSignature('k', 100, '')).toBe(ref);
  });
});

describe('verifyWakeAuth', () => {
  const secret = 'hunter2';
  const body = '{"hello":"world"}';
  const now = 1_700_000_000;

  it('accepts plain-hex signature + timestamp headers', () => {
    const result = verifyWakeAuth({
      secret,
      headers: signHeaders(secret, now, body),
      rawBody: body,
      nowSeconds: now,
      replayWindowSeconds: 300,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.method).toBe('hmac');
  });

  it('accepts valid bearer token (legacy compat)', () => {
    const result = verifyWakeAuth({
      secret,
      headers: { authorization: `Bearer ${secret}` },
      rawBody: body,
      nowSeconds: now,
      replayWindowSeconds: 300,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.method).toBe('bearer');
  });

  it('rejects wrong bearer token', () => {
    const result = verifyWakeAuth({
      secret,
      headers: { authorization: 'Bearer nope' },
      rawBody: body,
      nowSeconds: now,
      replayWindowSeconds: 300,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects HMAC with wrong secret', () => {
    const result = verifyWakeAuth({
      secret,
      headers: signHeaders('other-secret', now, body),
      rawBody: body,
      nowSeconds: now,
      replayWindowSeconds: 300,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects HMAC computed over a different body', () => {
    const result = verifyWakeAuth({
      secret,
      headers: signHeaders(secret, now, 'other-body'),
      rawBody: body,
      nowSeconds: now,
      replayWindowSeconds: 300,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects HMAC outside the replay window', () => {
    const result = verifyWakeAuth({
      secret,
      headers: signHeaders(secret, now - 3600, body),
      rawBody: body,
      nowSeconds: now,
      replayWindowSeconds: 300,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/replay window/);
  });

  it('accepts HMAC just inside the window (boundary)', () => {
    const result = verifyWakeAuth({
      secret,
      headers: signHeaders(secret, now - 300, body),
      rawBody: body,
      nowSeconds: now,
      replayWindowSeconds: 300,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects signature without paired timestamp', () => {
    const result = verifyWakeAuth({
      secret,
      headers: { 'x-paperclip-signature': 'a'.repeat(64) },
      rawBody: body,
      nowSeconds: now,
      replayWindowSeconds: 300,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects timestamp without paired signature', () => {
    const result = verifyWakeAuth({
      secret,
      headers: { 'x-paperclip-timestamp': String(now) },
      rawBody: body,
      nowSeconds: now,
      replayWindowSeconds: 300,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects when both auth methods are absent', () => {
    const result = verifyWakeAuth({
      secret,
      headers: {},
      rawBody: body,
      nowSeconds: now,
      replayWindowSeconds: 300,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/missing auth/);
  });

  it('rejects signature that is not 64-char hex', () => {
    const result = verifyWakeAuth({
      secret,
      headers: {
        'x-paperclip-timestamp': String(now),
        'x-paperclip-signature': 'not-hex',
      },
      rawBody: body,
      nowSeconds: now,
      replayWindowSeconds: 300,
    });
    expect(result.ok).toBe(false);
  });
});

describe('createPaperclipWakeHandler (in-process)', () => {
  it('throws if secret is empty', () => {
    expect(() =>
      createPaperclipWakeHandler({
        secret: '',
        onWake: () => {},
        logger: SILENT_LOGGER,
      }),
    ).toThrowError(/secret is required/);
  });
});

describe('paperclip-wake server (end-to-end)', () => {
  const secret = 'super-secret-xyz';

  it('returns 404 for wrong path', async () => {
    await withServer(
      {
        host: '127.0.0.1',
        port: 0,
        secret,
        onWake: () => {},
      },
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}/other`, { method: 'POST' });
        expect(res.status).toBe(404);
      },
    );
  });

  it('returns 404 for POST to non-wake path', async () => {
    await withServer(
      { host: '127.0.0.1', port: 0, secret, onWake: () => {} },
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}/paperclip/other`, {
          method: 'GET',
        });
        expect(res.status).toBe(404);
      },
    );
  });

  it('GET /paperclip/health returns 200 without auth', async () => {
    await withServer(
      { host: '127.0.0.1', port: 0, secret, onWake: () => {} },
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}${HEALTH_PATH}`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ok: boolean; uptime: number };
        expect(body.ok).toBe(true);
        expect(typeof body.uptime).toBe('number');
      },
    );
  });

  it('rejects unauthenticated POSTs with 401', async () => {
    await withServer(
      { host: '127.0.0.1', port: 0, secret, onWake: () => {} },
      async (baseUrl) => {
        const r = await postRaw(baseUrl, {}, '{}');
        expect(r.status).toBe(401);
      },
    );
  });

  it('accepts adapter-signed request and streams NDJSON (done frame)', async () => {
    const onWake = vi.fn<
      (
        p: PaperclipWakePayload,
        raw: string,
        stream: WakeStream,
      ) => void | Promise<void>
    >((_payload, _raw, stream) => {
      stream.log('stdout', 'hello\n');
      stream.done({ exitCode: 0, summary: 'ok' });
    });
    const body = JSON.stringify({
      runId: 'run-xyz',
      taskId: 't-1',
      agentId: 'agent-1',
      containerId: 'main',
      workspacePath: '/workspace/main',
      wakePayload: {
        env: {},
        config: {},
        context: { wakeReason: 'issue_commented' },
        runtime: {},
      },
    });
    const ts = Math.floor(Date.now() / 1000);

    await withServer(
      {
        host: '127.0.0.1',
        port: 0,
        secret,
        onWake,
      },
      async (baseUrl) => {
        const r = await postRaw(baseUrl, signHeaders(secret, ts, body), body);
        expect(r.status).toBe(200);
        expect(r.contentType).toContain('application/x-ndjson');
        // Response body is newline-delimited JSON frames.
        const lines = r.body.split('\n').filter(Boolean);
        const frames = lines.map((l) => JSON.parse(l));
        expect(frames.some((f) => f.type === 'log' && f.chunk === 'hello\n'))
          .toBe(true);
        const done = frames.find((f) => f.type === 'done');
        expect(done).toBeDefined();
        expect(done.exitCode).toBe(0);
        expect(done.summary).toBe('ok');
      },
    );

    expect(onWake).toHaveBeenCalledOnce();
    const [payload, raw] = onWake.mock.calls[0];
    expect(payload.runId).toBe('run-xyz');
    expect(payload.containerId).toBe('main');
    expect(payload.workspacePath).toBe('/workspace/main');
    expect(payload.wakePayload?.context).toMatchObject({
      wakeReason: 'issue_commented',
    });
    expect(raw).toBe(body);
  });

  it('emits synthetic done frame when onWake returns without calling done()', async () => {
    const body = JSON.stringify({ runId: 'r', agentId: 'a' });
    const ts = Math.floor(Date.now() / 1000);
    await withServer(
      {
        host: '127.0.0.1',
        port: 0,
        secret,
        onWake: () => {
          /* no-op: never calls stream.done() */
        },
      },
      async (baseUrl) => {
        const r = await postRaw(baseUrl, signHeaders(secret, ts, body), body);
        expect(r.status).toBe(200);
        const frames = r.body
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l));
        const done = frames.find((f) => f.type === 'done');
        expect(done).toBeDefined();
        expect(done.exitCode).toBe(1);
        expect(done.errorMessage).toMatch(/without terminal frame/);
      },
    );
  });

  it('emits error done frame when onWake throws', async () => {
    const body = JSON.stringify({ runId: 'r' });
    const ts = Math.floor(Date.now() / 1000);
    await withServer(
      {
        host: '127.0.0.1',
        port: 0,
        secret,
        onWake: () => {
          throw new Error('boom');
        },
      },
      async (baseUrl) => {
        const r = await postRaw(baseUrl, signHeaders(secret, ts, body), body);
        expect(r.status).toBe(200);
        const frames = r.body
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l));
        const done = frames.find((f) => f.type === 'done');
        expect(done).toBeDefined();
        expect(done.exitCode).toBe(1);
        expect(done.errorMessage).toBe('boom');
      },
    );
  });

  it('rejects bodies larger than the configured limit with 413', async () => {
    await withServer(
      {
        host: '127.0.0.1',
        port: 0,
        secret,
        maxBodyBytes: 64,
        onWake: () => {},
      },
      async (baseUrl) => {
        const body = JSON.stringify({ blob: 'x'.repeat(500) });
        const r = await postRaw(
          baseUrl,
          { authorization: `Bearer ${secret}` },
          body,
        );
        expect(r.status).toBe(413);
      },
    );
  });

  it('rejects invalid JSON with 400 after auth passes', async () => {
    await withServer(
      { host: '127.0.0.1', port: 0, secret, onWake: () => {} },
      async (baseUrl) => {
        const r = await postRaw(
          baseUrl,
          { authorization: `Bearer ${secret}` },
          'not-json{',
        );
        expect(r.status).toBe(400);
      },
    );
  });
});
