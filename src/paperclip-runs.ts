import crypto from 'crypto';
import http from 'http';

import { logger as defaultLogger } from './logger.js';
import {
  parseSignatureHeader,
  computeSignature,
  WAKE_PATH,
  type PaperclipWakePayload,
  type WakeLogger,
} from './paperclip-wake.js';

export const RUNS_PATH_PREFIX = '/paperclip/runs/';

export type RunStatus = 'pending' | 'done' | 'error';

export interface RunRecord {
  runId: string;
  agentId: string | null;
  status: RunStatus;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}

export interface WakeStore {
  recordWake(payload: PaperclipWakePayload): void;
  markDone(runId: string): void;
  markError(runId: string, error: string): void;
  get(runId: string): RunRecord | undefined;
  size(): number;
  prune(olderThanMs: number): number;
}

/**
 * In-memory store for Paperclip run status. Holds the last N wakes by runId so
 * the Paperclip adapter plugin can reconnect with a status poll after a dropped
 * wake response. Not persisted across nanoclaw restarts.
 */
export function createWakeStore(opts?: {
  now?: () => number;
  capacity?: number;
}): WakeStore {
  const now = opts?.now ?? (() => Date.now());
  const capacity = opts?.capacity ?? 1000;
  const runs = new Map<string, RunRecord>();

  const evictIfFull = () => {
    while (runs.size > capacity) {
      const oldestKey = runs.keys().next().value;
      if (!oldestKey) return;
      runs.delete(oldestKey);
    }
  };

  return {
    recordWake(payload) {
      if (typeof payload.runId !== 'string' || payload.runId.length === 0) {
        return;
      }
      const existing = runs.get(payload.runId);
      if (existing) return; // idempotent on re-delivery
      runs.set(payload.runId, {
        runId: payload.runId,
        agentId: typeof payload.agentId === 'string' ? payload.agentId : null,
        status: 'pending',
        startedAt: now(),
        finishedAt: null,
        error: null,
      });
      evictIfFull();
    },
    markDone(runId) {
      const rec = runs.get(runId);
      if (!rec || rec.status !== 'pending') return;
      rec.status = 'done';
      rec.finishedAt = now();
    },
    markError(runId, error) {
      const rec = runs.get(runId);
      if (!rec || rec.status !== 'pending') return;
      rec.status = 'error';
      rec.finishedAt = now();
      rec.error = error;
    },
    get(runId) {
      return runs.get(runId);
    },
    size() {
      return runs.size;
    },
    prune(olderThanMs) {
      const cutoff = now() - olderThanMs;
      let removed = 0;
      for (const [id, rec] of runs) {
        if (rec.finishedAt != null && rec.finishedAt < cutoff) {
          runs.delete(id);
          removed++;
        }
      }
      return removed;
    },
  };
}

/**
 * Verify a status-lookup request using the same shared secret as the wake
 * endpoint. Accepts bearer or Stripe-style HMAC — reusing the wake auth shape
 * rather than growing a second one.
 *
 * For the GET path there is no body, so the HMAC canonical string is
 * `${timestamp}.${method}.${path}`.
 */
function verifyRunsAuth(params: {
  secret: string;
  method: string;
  pathForSig: string;
  headers: http.IncomingHttpHeaders;
  nowSeconds: number;
  replayWindowSeconds: number;
}):
  | { ok: true; method: 'bearer' | 'hmac' }
  | { ok: false; status: 401; reason: string } {
  const {
    secret,
    method,
    pathForSig,
    headers,
    nowSeconds,
    replayWindowSeconds,
  } = params;

  const authHeader = headerString(headers['authorization']);
  const sigHeader = headerString(headers['x-paperclip-signature']);

  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    const presented = authHeader.slice(7).trim();
    if (
      presented.length === secret.length &&
      crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(secret))
    ) {
      return { ok: true, method: 'bearer' };
    }
  }

  if (sigHeader) {
    const parsed = parseSignatureHeader(sigHeader);
    if (!parsed) {
      return { ok: false, status: 401, reason: 'malformed signature header' };
    }
    if (Math.abs(nowSeconds - parsed.timestampSeconds) > replayWindowSeconds) {
      return {
        ok: false,
        status: 401,
        reason: 'signature timestamp outside replay window',
      };
    }
    const canonical = `${method.toUpperCase()}.${pathForSig}`;
    const expected = computeSignature(
      secret,
      parsed.timestampSeconds,
      canonical,
    );
    if (!safeEqualHex(expected, parsed.mac)) {
      return { ok: false, status: 401, reason: 'signature mismatch' };
    }
    return { ok: true, method: 'hmac' };
  }

  if (authHeader) {
    return { ok: false, status: 401, reason: 'bearer token mismatch' };
  }
  return { ok: false, status: 401, reason: 'missing auth' };
}

function headerString(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

export interface PaperclipRunsDeps {
  secret: string;
  store: WakeStore;
  replayWindowSeconds?: number;
  logger?: WakeLogger;
  now?: () => number;
}

/**
 * Build an http handler for `GET /paperclip/runs/{runId}`. Other methods and
 * paths return 404 so this can be composed onto a shared server.
 */
export function createPaperclipRunsHandler(
  deps: PaperclipRunsDeps,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const logger = deps.logger ?? defaultLogger;
  const now = deps.now ?? (() => Date.now());
  const replayWindowSeconds = deps.replayWindowSeconds ?? 300;
  if (!deps.secret) {
    throw new Error(
      'paperclip-runs: secret is required (set PAPERCLIP_WAKE_SECRET)',
    );
  }

  return (req, res) => {
    const url = req.url || '';
    if (req.method !== 'GET' || !url.startsWith(RUNS_PATH_PREFIX)) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const runId = url.slice(RUNS_PATH_PREFIX.length).split('?')[0] || '';
    if (!runId) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    const verification = verifyRunsAuth({
      secret: deps.secret,
      method: 'GET',
      pathForSig: url,
      headers: req.headers,
      nowSeconds: Math.floor(now() / 1000),
      replayWindowSeconds,
    });
    if (!verification.ok) {
      logger.warn(
        { reason: verification.reason, runId },
        'paperclip-runs: auth failed',
      );
      sendJson(res, verification.status, { error: verification.reason });
      return;
    }

    const rec = deps.store.get(runId);
    if (!rec) {
      sendJson(res, 404, { runId, status: 'not_found' });
      return;
    }
    sendJson(res, 200, {
      runId: rec.runId,
      agentId: rec.agentId,
      status: rec.status,
      startedAt: rec.startedAt,
      finishedAt: rec.finishedAt,
      error: rec.error,
    });
  };
}

/**
 * Compose wake + runs handlers onto a single http server. Each handler
 * independently 404s paths it doesn't own; the dispatcher picks the first
 * match and falls through to 404 if neither owns the path.
 */
export function createPaperclipServerHandler(
  wakeHandler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  runsHandler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (req, res) => {
    const url = req.url || '';
    if (url.startsWith(WAKE_PATH)) {
      wakeHandler(req, res);
      return;
    }
    if (url.startsWith(RUNS_PATH_PREFIX)) {
      runsHandler(req, res);
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  };
}

export interface StartPaperclipServerOptions {
  host: string;
  port: number;
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  logger?: WakeLogger;
}

export async function startPaperclipServer(
  opts: StartPaperclipServerOptions,
): Promise<http.Server> {
  const server = http.createServer(opts.handler);
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(opts.port, opts.host);
  });
  (opts.logger ?? defaultLogger).info(
    { host: opts.host, port: opts.port },
    'paperclip: listening (wake + runs)',
  );
  return server;
}
