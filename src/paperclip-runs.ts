import http from 'http';

import { logger as defaultLogger } from './logger.js';
import {
  verifyWakeAuth,
  WAKE_PATH,
  HEALTH_PATH,
  type PaperclipWakePayload,
  type WakeLogger,
  type WakeDoneFrame,
} from './paperclip-wake.js';

export const RUNS_PATH_PREFIX = '/paperclip/runs/';

/**
 * Run lifecycle state.
 *
 * Maps 1:1 onto the adapter's `parsePollResult` accept list in
 * `@fury_ios/nanoclaw-paperclip-adapter@0.1.3/src/wake.ts`:
 *   - "running" → keep polling (parser returns null)
 *   - "done" | "error" | "timeout" → terminal, parser returns a done frame
 */
export type RunStatus = 'running' | 'done' | 'error' | 'timeout';

export interface RunRecord {
  runId: string;
  agentId: string | null;
  status: RunStatus;
  startedAt: number;
  finishedAt: number | null;
  /** Process exit code on terminal states. 0 on done, non-zero otherwise. */
  exitCode: number | null;
  /** Optional diagnostic — surfaces to the adapter for error/timeout status. */
  errorMessage: string | null;
  /** Optional terminal-frame fields echoed from the handler's done() call. */
  signal: string | null;
  timedOut: boolean;
  usage: WakeDoneFrame['usage'] | null;
  sessionParams: Record<string, unknown> | null;
  sessionDisplayId: string | null;
  provider: string | null;
  model: string | null;
  costUsd: number | null;
  summary: string | null;
  resultJson: Record<string, unknown> | null;
}

export interface TerminalPatch {
  status: 'done' | 'error' | 'timeout';
  exitCode?: number | null;
  errorMessage?: string | null;
  signal?: string | null;
  timedOut?: boolean;
  usage?: WakeDoneFrame['usage'] | null;
  sessionParams?: Record<string, unknown> | null;
  sessionDisplayId?: string | null;
  provider?: string | null;
  model?: string | null;
  costUsd?: number | null;
  summary?: string | null;
  resultJson?: Record<string, unknown> | null;
}

export interface WakeStore {
  recordWake(payload: PaperclipWakePayload): void;
  /** Mark a run as terminal with the adapter-visible fields. */
  markTerminal(runId: string, patch: TerminalPatch): void;
  /** Back-compat convenience: done with exitCode=0. */
  markDone(runId: string, patch?: Omit<TerminalPatch, 'status'>): void;
  /** Back-compat convenience: error with exitCode=1 unless overridden. */
  markError(
    runId: string,
    error: string,
    patch?: Omit<TerminalPatch, 'status' | 'errorMessage'>,
  ): void;
  get(runId: string): RunRecord | undefined;
  size(): number;
  prune(olderThanMs: number): number;
}

/**
 * In-memory LRU store for Paperclip run status. Holds the last N wakes by
 * runId so the adapter can reconnect with a status poll after a dropped
 * NDJSON wake stream. Not persisted across nanoclaw restarts.
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

  const blankTerminal = (): Pick<
    RunRecord,
    | 'exitCode'
    | 'errorMessage'
    | 'signal'
    | 'timedOut'
    | 'usage'
    | 'sessionParams'
    | 'sessionDisplayId'
    | 'provider'
    | 'model'
    | 'costUsd'
    | 'summary'
    | 'resultJson'
  > => ({
    exitCode: null,
    errorMessage: null,
    signal: null,
    timedOut: false,
    usage: null,
    sessionParams: null,
    sessionDisplayId: null,
    provider: null,
    model: null,
    costUsd: null,
    summary: null,
    resultJson: null,
  });

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
        status: 'running',
        startedAt: now(),
        finishedAt: null,
        ...blankTerminal(),
      });
      evictIfFull();
    },
    markTerminal(runId, patch) {
      const rec = runs.get(runId);
      if (!rec || rec.status !== 'running') return;
      rec.status = patch.status;
      rec.finishedAt = now();
      const defaultExit = patch.status === 'done' ? 0 : 1;
      rec.exitCode =
        typeof patch.exitCode === 'number' ? patch.exitCode : defaultExit;
      rec.errorMessage = patch.errorMessage ?? null;
      rec.signal = patch.signal ?? null;
      rec.timedOut =
        patch.timedOut ?? (patch.status === 'timeout' ? true : false);
      rec.usage = patch.usage ?? null;
      rec.sessionParams = patch.sessionParams ?? null;
      rec.sessionDisplayId = patch.sessionDisplayId ?? null;
      rec.provider = patch.provider ?? null;
      rec.model = patch.model ?? null;
      rec.costUsd = patch.costUsd ?? null;
      rec.summary = patch.summary ?? null;
      rec.resultJson = patch.resultJson ?? null;
    },
    markDone(runId, patch) {
      this.markTerminal(runId, {
        status: 'done',
        exitCode: 0,
        ...(patch ?? {}),
      });
    },
    markError(runId, error, patch) {
      this.markTerminal(runId, {
        status: 'error',
        exitCode: 1,
        errorMessage: error,
        ...(patch ?? {}),
      });
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

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

async function readEmptyBody(req: http.IncomingMessage): Promise<string> {
  // Shipped adapter never sends a GET body, but drain to be safe.
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => resolve(body));
    req.on('error', () => resolve(body));
  });
}

export interface PaperclipRunsDeps {
  secret: string;
  store: WakeStore;
  replayWindowSeconds?: number;
  logger?: WakeLogger;
  now?: () => number;
}

/**
 * Build an http handler for `GET /paperclip/runs/{runId}`.
 *
 * Auth: same HMAC rules as `/paperclip/wake` — but the canonical signed
 * string is `${timestamp}.` (empty rawBody, because GET has no body).
 * See adapter `src/hmac.ts` and `src/wake.ts:pollForResult` where
 * `body = ""` is passed to `buildSignedHeaders`.
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

    void readEmptyBody(req).then((rawBody) => {
      const verification = verifyWakeAuth({
        secret: deps.secret,
        headers: req.headers,
        rawBody,
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
      // Response shape — matches adapter's parsePollResult expectations.
      sendJson(res, 200, {
        runId: rec.runId,
        agentId: rec.agentId,
        status: rec.status,
        startedAt: rec.startedAt,
        finishedAt: rec.finishedAt,
        exitCode: rec.exitCode,
        signal: rec.signal,
        timedOut: rec.timedOut,
        errorMessage: rec.errorMessage,
        usage: rec.usage,
        sessionParams: rec.sessionParams,
        sessionDisplayId: rec.sessionDisplayId,
        provider: rec.provider,
        model: rec.model,
        costUsd: rec.costUsd,
        summary: rec.summary,
        resultJson: rec.resultJson,
      });
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
    if (url.startsWith(WAKE_PATH) || url.startsWith(HEALTH_PATH)) {
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
    'paperclip: listening (wake + runs + health)',
  );
  return server;
}
