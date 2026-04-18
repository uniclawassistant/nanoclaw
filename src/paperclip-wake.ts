import crypto from 'crypto';
import http from 'http';

import { logger as defaultLogger } from './logger.js';

/**
 * Wake payload Paperclip delivers.
 *
 * The shipped adapter (`@fury_ios/nanoclaw-paperclip-adapter@0.1.3`) sends
 * the following top-level shape to `POST /paperclip/wake`:
 *
 *   {
 *     runId, taskId, agentId, containerId, workspacePath,
 *     wakePayload: { env, config, context, runtime },
 *     callbackUrl, callbackJwt
 *   }
 *
 * The daemon routes on the TOP-LEVEL `containerId` / `workspacePath` — it
 * treats `wakePayload.context` as opaque passthrough for the agent runner.
 * Unknown fields are tolerated.
 */
export interface PaperclipWakePayload {
  runId?: string;
  taskId?: string | null;
  agentId?: string;
  containerId?: string;
  workspacePath?: string;
  wakePayload?: {
    env?: Record<string, unknown>;
    config?: Record<string, unknown>;
    context?: Record<string, unknown>;
    runtime?: Record<string, unknown>;
    [key: string]: unknown;
  };
  callbackUrl?: string | null;
  callbackJwt?: string | null;
  // Legacy/inline-context fields — retained so older senders still route.
  companyId?: string;
  context?: Record<string, unknown>;
  [key: string]: unknown;
}

export type WakeLogger = Pick<
  typeof defaultLogger,
  'info' | 'warn' | 'error' | 'debug'
>;

/**
 * One NDJSON frame streamed back on the open `POST /paperclip/wake` response.
 * Matches the frames the adapter's NDJSON parser accepts (see the adapter
 * `src/ndjson.ts` for the authoritative shape).
 */
export type WakeLogStream = 'stdout' | 'stderr';
export interface WakeLogFrame {
  type: 'log';
  stream: WakeLogStream;
  chunk: string;
}
export interface WakeDoneFrame {
  type: 'done';
  exitCode: number | null;
  signal?: string | null;
  timedOut?: boolean;
  errorMessage?: string | null;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
  };
  sessionParams?: Record<string, unknown> | null;
  sessionDisplayId?: string | null;
  provider?: string | null;
  model?: string | null;
  costUsd?: number | null;
  summary?: string | null;
  resultJson?: Record<string, unknown> | null;
}
export type WakeFrame = WakeLogFrame | WakeDoneFrame;

/** Stream handle passed to `onWake` — lets the handler emit NDJSON frames. */
export interface WakeStream {
  log(stream: WakeLogStream, chunk: string): void;
  done(frame: Omit<WakeDoneFrame, 'type'>): void;
  /**
   * True once `done()` has been called or the connection has ended. Further
   * `log()` calls are no-ops after this flips.
   */
  readonly closed: boolean;
}

export interface PaperclipWakeDeps {
  /** Shared secret used for HMAC verification and bearer fallback. */
  secret: string;
  /** Accept signatures whose timestamp is within ± this many seconds of now. */
  replayWindowSeconds?: number;
  /**
   * Callback for a verified wake. The handler is responsible for driving the
   * NDJSON stream via `stream.log()` / `stream.done()`. If it returns without
   * calling `done()`, the wrapper emits a synthetic `done` with `exitCode=1`
   * so the adapter side never hangs.
   *
   * Errors thrown are logged; a terminal `done` frame with the error is sent
   * if the stream is still open.
   */
  onWake: (
    payload: PaperclipWakePayload,
    rawBody: string,
    stream: WakeStream,
  ) => void | Promise<void>;
  /** Optional logger override (tests inject fakes). */
  logger?: WakeLogger;
  /** Optional clock override (tests pin the wall clock). Returns ms. */
  now?: () => number;
  /** Max body size in bytes. Requests above this are rejected with 413. */
  maxBodyBytes?: number;
}

export const WAKE_PATH = '/paperclip/wake';
export const HEALTH_PATH = '/paperclip/health';
const DEFAULT_REPLAY_WINDOW_SECONDS = 300;
const DEFAULT_MAX_BODY_BYTES = 1_048_576; // 1 MiB
const HEX_SIGNATURE_RE = /^[a-f0-9]{64}$/i;

/** Constant-time hex string comparison. */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Compute `hmac-sha256(secret, "${timestamp}.${rawBody}")` as lowercase hex.
 *
 * This is the canonical signing string the shipped adapter uses for BOTH
 * `POST /paperclip/wake` (with the full JSON body) and
 * `GET /paperclip/runs/{runId}` / `GET /paperclip/health` (with rawBody="").
 * See adapter `src/hmac.ts`.
 */
export function computeSignature(
  secret: string,
  timestampSeconds: number,
  rawBody: string,
): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestampSeconds}.${rawBody}`)
    .digest('hex');
}

export type VerifyResult =
  | { ok: true; method: 'bearer' | 'hmac' }
  | { ok: false; status: 401 | 403; reason: string };

/**
 * Verify a request's auth. Accepts either:
 *   - `Authorization: Bearer <secret>` (exact match, constant-time) — retained
 *     for backward compatibility with the in-tree static-bearer path.
 *   - `x-paperclip-timestamp: <unix-seconds>` + `x-paperclip-signature: <hex>`
 *     where the HMAC-SHA256 of `${timestamp}.${rawBody}` equals the signature
 *     and |now - timestamp| ≤ the replay window.
 *
 * The shipped adapter (@fury_ios/nanoclaw-paperclip-adapter@0.1.3) sends the
 * two-header HMAC form; see its `src/hmac.ts` / `src/wake.ts`.
 */
export function verifyWakeAuth(params: {
  secret: string;
  headers: http.IncomingHttpHeaders;
  rawBody: string;
  nowSeconds: number;
  replayWindowSeconds: number;
}): VerifyResult {
  const { secret, headers, rawBody, nowSeconds, replayWindowSeconds } = params;

  const authHeader = headerString(headers['authorization']);
  const sigHeader = headerString(headers['x-paperclip-signature']);
  const tsHeader = headerString(headers['x-paperclip-timestamp']);

  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    const presented = authHeader.slice(7).trim();
    const expected = secret;
    if (
      presented.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(expected))
    ) {
      return { ok: true, method: 'bearer' };
    }
    // Fall through — combined headers still get a chance via HMAC.
  }

  if (sigHeader || tsHeader) {
    if (!sigHeader || !tsHeader) {
      return {
        ok: false,
        status: 401,
        reason: 'missing x-paperclip-signature or x-paperclip-timestamp',
      };
    }
    const ts = Number(tsHeader);
    if (!Number.isFinite(ts)) {
      return { ok: false, status: 401, reason: 'timestamp not numeric' };
    }
    const skew = Math.abs(nowSeconds - ts);
    if (skew > replayWindowSeconds) {
      return {
        ok: false,
        status: 401,
        reason: 'signature timestamp outside replay window',
      };
    }
    if (!HEX_SIGNATURE_RE.test(sigHeader)) {
      return { ok: false, status: 401, reason: 'malformed signature format' };
    }
    const expected = computeSignature(secret, ts, rawBody);
    if (expected.length !== sigHeader.length) {
      return { ok: false, status: 401, reason: 'signature length mismatch' };
    }
    if (!safeEqualHex(expected, sigHeader)) {
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

async function readBody(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<{ ok: true; body: string } | { ok: false; status: 413 | 400 }> {
  return new Promise((resolve) => {
    let total = 0;
    let overflowed = false;
    const chunks: Buffer[] = [];
    let settled = false;
    const settle = (
      result: { ok: true; body: string } | { ok: false; status: 413 | 400 },
    ) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        overflowed = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (overflowed) {
        settle({ ok: false, status: 413 });
        return;
      }
      settle({ ok: true, body: Buffer.concat(chunks).toString('utf8') });
    });
    req.on('error', () => {
      settle({ ok: false, status: 400 });
    });
  });
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

/**
 * Open the NDJSON streaming response on a `POST /paperclip/wake` request.
 * Returns a `WakeStream` handle that writes `\n`-delimited JSON frames.
 */
function openWakeStream(res: http.ServerResponse): WakeStream {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/x-ndjson');
  res.setHeader('cache-control', 'no-cache');
  // Flush headers immediately so the client can start reading.
  if (typeof (res as http.ServerResponse & { flushHeaders?: () => void }).flushHeaders === 'function') {
    (res as http.ServerResponse & { flushHeaders: () => void }).flushHeaders();
  }
  let closed = false;
  const writeFrame = (frame: WakeFrame): void => {
    if (closed) return;
    try {
      res.write(`${JSON.stringify(frame)}\n`);
    } catch {
      closed = true;
    }
  };
  res.on('close', () => {
    closed = true;
  });
  return {
    log(stream, chunk) {
      if (closed) return;
      writeFrame({ type: 'log', stream, chunk });
    },
    done(frame) {
      if (closed) return;
      writeFrame({ type: 'done', ...frame });
      closed = true;
      try {
        res.end();
      } catch {
        // ignore — connection already torn down
      }
    },
    get closed() {
      return closed;
    },
  };
}

/**
 * Build an http handler that processes `POST /paperclip/wake` and the public
 * `GET /paperclip/health` readiness probe. All other method/path combinations
 * return 404.
 */
export function createPaperclipWakeHandler(
  deps: PaperclipWakeDeps,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const logger = deps.logger ?? defaultLogger;
  const now = deps.now ?? (() => Date.now());
  const replayWindowSeconds =
    deps.replayWindowSeconds ?? DEFAULT_REPLAY_WINDOW_SECONDS;
  const maxBodyBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const secret = deps.secret;
  if (!secret) {
    throw new Error(
      'paperclip-wake: secret is required (set PAPERCLIP_WAKE_SECRET)',
    );
  }
  const startedAt = now();

  return (req, res) => {
    const url = req.url || '';
    // /paperclip/health — readiness probe, no auth required. The adapter's
    // testEnvironment() preflight hits this; it also signs the request but
    // ignores the response auth outcome.
    if (req.method === 'GET' && url.startsWith(HEALTH_PATH)) {
      sendJson(res, 200, {
        ok: true,
        uptime: Math.max(0, Math.floor((now() - startedAt) / 1000)),
      });
      return;
    }
    if (req.method !== 'POST' || !url.startsWith(WAKE_PATH)) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    void readBody(req, maxBodyBytes).then((result) => {
      if (!result.ok) {
        sendJson(res, result.status, {
          error: result.status === 413 ? 'payload too large' : 'bad request',
        });
        return;
      }
      const rawBody = result.body;

      const verification = verifyWakeAuth({
        secret,
        headers: req.headers,
        rawBody,
        nowSeconds: Math.floor(now() / 1000),
        replayWindowSeconds,
      });
      if (!verification.ok) {
        logger.warn(
          { reason: verification.reason },
          'paperclip-wake: auth failed',
        );
        sendJson(res, verification.status, { error: verification.reason });
        return;
      }

      let payload: PaperclipWakePayload;
      try {
        payload = JSON.parse(rawBody) as PaperclipWakePayload;
      } catch (err) {
        logger.warn({ err }, 'paperclip-wake: invalid JSON body');
        sendJson(res, 400, { error: 'invalid json' });
        return;
      }

      if (typeof payload !== 'object' || payload === null) {
        sendJson(res, 400, { error: 'payload must be an object' });
        return;
      }

      const stream = openWakeStream(res);

      logger.info(
        {
          method: verification.method,
          runId: payload.runId,
          agentId: payload.agentId,
          containerId: payload.containerId,
          taskId: payload.taskId,
        },
        'paperclip-wake: accepted',
      );

      void (async () => {
        try {
          await deps.onWake(payload, rawBody, stream);
        } catch (err) {
          logger.error(
            { err, runId: payload.runId, agentId: payload.agentId },
            'paperclip-wake: onWake handler threw',
          );
          if (!stream.closed) {
            stream.done({
              exitCode: 1,
              errorMessage:
                err instanceof Error ? err.message : 'onWake handler error',
            });
          }
          return;
        }
        // Handler returned without calling done(). Emit a synthetic terminal
        // frame so the adapter's NDJSON parser doesn't wait forever.
        if (!stream.closed) {
          stream.done({
            exitCode: 1,
            errorMessage: 'onWake returned without terminal frame',
          });
        }
      })();
    });
  };
}

export interface StartWakeServerOptions extends PaperclipWakeDeps {
  port: number;
  host: string;
}

/**
 * Start a dedicated HTTP server for /paperclip/wake + /paperclip/health.
 * Returns the server so callers can close it on shutdown.
 */
export async function startPaperclipWakeServer(
  opts: StartWakeServerOptions,
): Promise<http.Server> {
  const handler = createPaperclipWakeHandler(opts);
  const server = http.createServer(handler);
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
    { host: opts.host, port: opts.port, path: WAKE_PATH },
    'paperclip-wake: listening',
  );
  return server;
}
