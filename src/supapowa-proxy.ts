/**
 * Supapowa forwarder: lets this instance's agent containers use Supapowa (the owner's capability gateway on
 * this Mac: provider APIs with keys the agent never sees, owner questions) as one registered agent.
 *
 * Supapowa's local endpoint listens on 127.0.0.1 only and wants a loopback Host, so containers cannot reach
 * it. This forwarder listens where containers can (next to the credential proxy) and passes their requests on
 * as a local program, swapping the container's per-run key for the agent's Supapowa token:
 *
 *   container: Authorization: Bearer $SUPAPOWA_KEY  →  forwarder  →  127.0.0.1:<port>, Authorization: Bearer <token>
 *
 * - The token stays on the host (Supapowa's token file, read per request so a new token needs no restart).
 * - Each container run gets its own random key; it stops working when the container exits. Requests
 *   without a live key are refused here, so other containers on the bridge are not the agent.
 * - Off unless SUPAPOWA_AGENT is set in .env (another instance on the same code stays as it was).
 */
import { randomBytes, timingSafeEqual } from 'crypto';
import fs from 'fs';
import { createServer, request as httpRequest, Server } from 'http';
import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export interface SupapowaConfig {
  /** The agent's name as registered in Supapowa (Agents). */
  agent: string;
  /** Where the forwarder listens (port on the proxy bind host). */
  port: number;
  /** The agent's token, written by Supapowa's "Save Token File". */
  tokenFile: string;
  /** Supapowa's endpoint port, saved by Supapowa (JSON {"port": N}). */
  endpointFile: string;
}

/** A request waits while the owner is asked (Supapowa waits up to 10 minutes). */
const UPSTREAM_TIMEOUT_MS = 11 * 60 * 1000;

const env = (name: string): string | undefined =>
  process.env[name] || readEnvFile([name])[name] || undefined;

/** The forwarder's settings from .env, or null when it is off. */
export function supapowaConfig(): SupapowaConfig | null {
  const agent = env('SUPAPOWA_AGENT');
  if (!agent) return null;
  const safe = agent.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60);
  return {
    agent,
    port: parseInt(env('SUPAPOWA_PROXY_PORT') || '3002', 10),
    tokenFile:
      env('SUPAPOWA_TOKEN_FILE') ||
      path.join(os.homedir(), '.config/supapowa/tokens', `${safe}.token`),
    endpointFile:
      env('SUPAPOWA_ENDPOINT_FILE') ||
      path.join(
        os.homedir(),
        'Library/Application Support/Supapowa/Gateway/endpoint.json',
      ),
  };
}

// Per-container keys: key → container name.
const keys = new Map<string, string>();

/** A key for one container run (passed to it as SUPAPOWA_KEY). */
export function issueSupapowaKey(containerName: string): string {
  const key = randomBytes(24).toString('hex');
  keys.set(key, containerName);
  return key;
}

/** The container exited: its key stops working. */
export function revokeSupapowaKeys(containerName: string): void {
  for (const [key, name] of keys) if (name === containerName) keys.delete(key);
}

function liveKey(presented: string): string | undefined {
  const given = Buffer.from(presented);
  for (const [key, name] of keys) {
    const known = Buffer.from(key);
    if (known.length === given.length && timingSafeEqual(known, given))
      return name;
  }
  return undefined;
}

/** Headers never passed on: hop-by-hop, the container's key, and browser-only ones Supapowa refuses. */
const DROPPED = new Set([
  'host',
  'authorization',
  'origin',
  'referer',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'proxy-authorization',
  'proxy-connection',
  'upgrade',
]);

function refuse(
  res: import('http').ServerResponse,
  status: number,
  code: string,
  message: string,
) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Supapowa-Error': 'true',
  });
  res.end(JSON.stringify({ code, message }));
}

export function startSupapowaProxy(
  config: SupapowaConfig,
  host: string,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const auth = req.headers['authorization'] || '';
      const presented = /^bearer\s+/i.test(auth)
        ? auth.replace(/^bearer\s+/i, '').trim()
        : '';
      const container = presented ? liveKey(presented) : undefined;
      if (!container) {
        req.resume();
        return refuse(
          res,
          401,
          'notThisAgent',
          'Send Authorization: Bearer $SUPAPOWA_KEY (the key of this container run).',
        );
      }
      let token: string;
      let port: number;
      try {
        token = fs.readFileSync(config.tokenFile, 'utf8').trim();
        port = JSON.parse(fs.readFileSync(config.endpointFile, 'utf8')).port;
        if (!token || !Number.isInteger(port)) throw new Error('empty');
        // eslint-disable-next-line no-catch-all/no-catch-all -- any read or parse failure means "not set up"
      } catch {
        req.resume();
        return refuse(
          res,
          503,
          'supapowaNotSetUp',
          `Supapowa is not set up for ${config.agent} on this Mac (token or endpoint missing). Ask the owner.`,
        );
      }

      const headers: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined || DROPPED.has(name)) continue;
        headers[name] = value;
      }
      headers['authorization'] = `Bearer ${token}`;

      const started = Date.now();
      const pathOnly = (req.url || '/').split('?')[0];
      const upstream = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path: req.url,
          method: req.method,
          headers,
          timeout: UPSTREAM_TIMEOUT_MS,
        },
        (upRes) => {
          res.writeHead(upRes.statusCode || 502, upRes.headers);
          upRes.pipe(res);
          logger.info(
            {
              container,
              method: req.method,
              path: pathOnly,
              status: upRes.statusCode,
              receipt: upRes.headers['x-supapowa-receipt'],
              ms: Date.now() - started,
            },
            'Supapowa request',
          );
        },
      );
      upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
      upstream.on('error', (err) => {
        logger.warn(
          { container, path: pathOnly, err: err.message },
          'Supapowa unreachable',
        );
        if (!res.headersSent)
          refuse(
            res,
            502,
            'supapowaUnreachable',
            'Supapowa did not answer (not running, or quit by the owner).',
          );
        else res.destroy();
      });
      req.pipe(upstream);
    });
    server.requestTimeout = 0; // a request may wait for the owner's answer
    server.headersTimeout = 60_000;
    server.on('error', reject);
    server.listen(config.port, host, () => {
      logger.info(
        { port: config.port, host, agent: config.agent },
        'Supapowa forwarder started',
      );
      resolve(server);
    });
  });
}
