import { createHmac, timingSafeEqual } from 'crypto';
import fs from 'fs';
import http, { IncomingMessage, ServerResponse } from 'http';

import { logger } from './logger.js';
import {
  createSupapowaHandler,
  issueSupapowaKey,
  revokeSupapowaKeys,
  SupapowaConfig,
} from './supapowa-proxy.js';

const EVENTS_PATH = '/supapowa/events';
const MAX_BODY = 64 * 1024;

interface Hook {
  id: string;
  admin: string;
  url: string;
}

interface Subscription {
  id: string;
  secret: string;
}

/** Reject non-loopback peers even if the listener is accidentally exposed. */
export function isSupapowaLoopback(address: string | undefined): boolean {
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1'
  );
}

/** Host-only webhook state. No event or admin response body is logged. */
export class SupapowaEvents {
  private subscription?: Subscription;

  constructor(private readonly deliver: (message: string) => void) {}

  /** Reconcile only Unic's subscription at this exact URL, once per startup. */
  async register(
    url: string,
    secretFile: string,
    admin: (args: string[]) => Promise<unknown>,
  ): Promise<boolean> {
    this.subscription = undefined;
    try {
      const listing = (await admin(['hooks'])) as {
        ok: boolean;
        hooks: Hook[];
      };
      if (listing.ok !== true || !Array.isArray(listing.hooks))
        throw new Error('invalid hooks');
      const matching = listing.hooks.filter(
        (hook) => hook.admin === 'Unic' && hook.url === url,
      );
      let secret: string | undefined;
      try {
        secret = fs.readFileSync(secretFile, 'utf8').trim() || undefined;
        if (secret) fs.chmodSync(secretFile, 0o600);
        // eslint-disable-next-line no-catch-all/no-catch-all -- unreadable host secret requires narrow recovery
      } catch {
        secret = undefined;
      }
      if (matching.length && secret) {
        this.subscription = { id: matching[0].id, secret };
        return true;
      }
      for (const hook of matching) {
        const removed = (await admin(['hook', 'remove', hook.id])) as {
          ok: boolean;
        };
        if (removed.ok !== true) throw new Error('remove failed');
      }
      const created = (await admin([
        'hook',
        'add',
        url,
        '--events',
        'questions,macos',
        '--every',
        '30s',
      ])) as { ok: boolean; hook: Hook & { secret: string } };
      if (
        created.ok !== true ||
        created.hook?.admin !== 'Unic' ||
        created.hook.url !== url ||
        typeof created.hook.id !== 'string' ||
        typeof created.hook.secret !== 'string' ||
        !created.hook.secret.trim()
      ) {
        throw new Error('add failed');
      }
      const fd = fs.openSync(secretFile, 'w', 0o600);
      try {
        fs.fchmodSync(fd, 0o600);
        fs.writeFileSync(fd, created.hook.secret, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      this.subscription = { id: created.hook.id, secret: created.hook.secret };
      if (matching.length) logger.info('hook recreated: no local secret');
      return true;
      // eslint-disable-next-line no-catch-all/no-catch-all -- never log admin errors containing a one-time secret
    } catch {
      logger.warn('Supapowa events disabled: hook registration failed');
      return false;
    }
  }

  /** Handle only authenticated loopback webhook deliveries. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let eventCount = 0;
    const finish = (status: number) => {
      logger.info(
        { method: req.method, path: EVENTS_PATH, status, eventCount },
        'Supapowa events',
      );
      req.resume();
      res.writeHead(status);
      res.end();
    };
    if (!isSupapowaLoopback(req.socket.remoteAddress)) return finish(403);
    if (req.method !== 'POST') return finish(405);
    const signature = req.headers['x-supapowa-signature'];
    if (
      typeof signature !== 'string' ||
      !/^sha256=[a-fA-F0-9]{64}$/.test(signature)
    )
      return finish(401);
    const subscription = this.subscription;
    if (!subscription) return finish(503);
    let failureStatus = 400;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) return finish(413);
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks);
      const expected = createHmac('sha256', subscription.secret)
        .update(body)
        .digest();
      if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex')))
        return finish(401);
      const payload = JSON.parse(body.toString('utf8')) as {
        hook: string;
        events: unknown[];
      };
      if (payload.hook !== subscription.id || !Array.isArray(payload.events))
        return finish(400);
      const summaries = payload.events.map(eventSummary);
      if (summaries.some((summary) => summary === null)) return finish(400);
      eventCount = summaries.length;
      failureStatus = 500;
      if (eventCount)
        this.deliver(`Supapowa has pending questions: ${summaries.join('; ')}`);
      finish(204);
      // eslint-disable-next-line no-catch-all/no-catch-all -- malformed payloads and delivery failures must not leak bodies
    } catch {
      finish(failureStatus);
    }
  }
}

function eventSummary(event: unknown): string | null {
  if (!event || typeof event !== 'object') return null;
  const value = event as Record<string, unknown>;
  const short = (text: string) => text.replace(/[\r\n\t]/g, ' ').slice(0, 300);
  if (
    value.type === 'question' &&
    typeof value.agent === 'string' &&
    typeof value.kind === 'string' &&
    typeof value.summary === 'string'
  ) {
    return `${short(value.agent)} / ${short(value.kind)}: ${short(value.summary)}`;
  }
  if (
    value.type === 'macos' &&
    typeof value.app === 'string' &&
    value.asks !== undefined
  ) {
    const asks =
      typeof value.asks === 'string' ? value.asks : JSON.stringify(value.asks);
    return `macOS / ${short(value.app)}: ${short(asks)} asks`;
  }
  return null;
}

/** Use the existing forwarder admin route with a short-lived host key. */
export async function callSupapowaAdmin(
  config: SupapowaConfig,
  host: string,
  args: string[],
): Promise<unknown> {
  const container = 'host-supapowa-hooks';
  const key = issueSupapowaKey(container);
  try {
    return await new Promise((resolve, reject) => {
      const request = http.request(
        {
          hostname: host,
          port: config.port,
          path: '/_admin',
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          timeout: 15_000,
        },
        (response) => {
          let body = '';
          response.on('data', (chunk) => {
            body += chunk;
            if (body.length > MAX_BODY)
              response.destroy(new Error('response too large'));
          });
          response.on('error', reject);
          response.on('end', () => {
            try {
              if (response.statusCode !== 200) throw new Error('admin failed');
              resolve(JSON.parse(body));
              // eslint-disable-next-line no-catch-all/no-catch-all -- sanitized by registration caller
            } catch {
              reject(new Error('invalid admin response'));
            }
          });
        },
      );
      request.on('timeout', () => request.destroy(new Error('admin timeout')));
      request.on('error', reject);
      request.end(JSON.stringify({ args }));
    });
  } finally {
    revokeSupapowaKeys(container);
  }
}

/** Start a separate loopback listener; container-facing routing stays unchanged. */
export async function startSupapowaEvents(
  config: SupapowaConfig,
  host: string,
  deliver: (message: string) => void,
): Promise<http.Server> {
  const events = new SupapowaEvents(deliver);
  const server = http.createServer(createSupapowaHandler(config, events));
  server.requestTimeout = 30_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.eventsPort ?? 3003, '127.0.0.1', resolve);
  });
  const port = (server.address() as import('net').AddressInfo).port;
  await events.register(
    `http://127.0.0.1:${port}${EVENTS_PATH}`,
    `${config.tokenFile}.hooks-secret`,
    (args) => callSupapowaAdmin(config, host, args),
  );
  return server;
}
