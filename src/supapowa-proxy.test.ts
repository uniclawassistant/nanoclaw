import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  issueSupapowaKey,
  revokeSupapowaKeys,
  startSupapowaProxy,
  supapowaConfig,
  SupapowaConfig,
} from './supapowa-proxy.js';

interface Seen {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

describe('Supapowa forwarder', () => {
  let dir: string;
  let upstream: http.Server;
  let proxy: http.Server;
  let seen: Seen[];
  let config: SupapowaConfig;
  let proxyPort: number;

  const send = (
    method: string,
    url: string,
    headers: Record<string, string>,
    body = '',
  ): Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
    body: string;
  }> =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port: proxyPort, path: url, method, headers },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () =>
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              body: data,
            }),
          );
        },
      );
      req.on('error', reject);
      req.end(body);
    });

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supapowa-'));
    seen = [];
    upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body,
        });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'X-Agent-Desktop-Gateway-Receipt': 'r-1',
        });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const upstreamPort = (upstream.address() as AddressInfo).port;
    fs.writeFileSync(path.join(dir, 'Unic.token'), 'real-token\n');
    fs.writeFileSync(
      path.join(dir, 'endpoint.json'),
      JSON.stringify({ port: upstreamPort }),
    );
    config = {
      agent: 'Unic',
      port: 0,
      tokenFile: path.join(dir, 'Unic.token'),
      endpointFile: path.join(dir, 'endpoint.json'),
    };
    proxy = await startSupapowaProxy(config, '127.0.0.1');
    proxyPort = (proxy.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise((r) => proxy.close(r));
    await new Promise((r) => upstream.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses requests without a live container key', async () => {
    const none = await send('GET', '/_access', {});
    expect(none.status).toBe(401);
    expect(JSON.parse(none.body).code).toBe('notThisAgent');
    const guessed = await send('GET', '/_access', {
      Authorization: 'Bearer guess',
    });
    expect(guessed.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('passes a request on with the agent token instead of the key', async () => {
    const key = issueSupapowaKey('nanoclaw-unic--main-1');
    const res = await send(
      'POST',
      '/gemini/v1beta/models/m:generateContent?alt=json',
      {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Origin: 'http://evil.example',
      },
      '{"contents":[]}',
    );
    expect(res.status).toBe(200);
    expect(res.body).toBe('{"ok":true}');
    expect(res.headers['x-agent-desktop-gateway-receipt']).toBe('r-1');
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('POST');
    expect(seen[0].url).toBe(
      '/gemini/v1beta/models/m:generateContent?alt=json',
    );
    expect(seen[0].headers.authorization).toBe('Bearer real-token');
    expect(seen[0].headers.host).toMatch(/^127\.0\.0\.1:/);
    expect(seen[0].headers.origin).toBeUndefined();
    expect(seen[0].body).toBe('{"contents":[]}');
    revokeSupapowaKeys('nanoclaw-unic--main-1');
  });

  it('stops a key when its container exits', async () => {
    const key = issueSupapowaKey('nanoclaw-unic--main-2');
    revokeSupapowaKeys('nanoclaw-unic--main-2');
    const res = await send('GET', '/_access', {
      Authorization: `Bearer ${key}`,
    });
    expect(res.status).toBe(401);
  });

  it('says so when the token is missing', async () => {
    const key = issueSupapowaKey('nanoclaw-unic--main-3');
    fs.rmSync(config.tokenFile);
    const res = await send('GET', '/_access', {
      Authorization: `Bearer ${key}`,
    });
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).code).toBe('supapowaNotSetUp');
    revokeSupapowaKeys('nanoclaw-unic--main-3');
  });

  it('says so when Supapowa does not answer', async () => {
    const key = issueSupapowaKey('nanoclaw-unic--main-4');
    await new Promise((r) => upstream.close(r));
    upstream = http.createServer();
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const closedPort = (upstream.address() as AddressInfo).port;
    await new Promise((r) => upstream.close(r));
    upstream = http.createServer();
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    fs.writeFileSync(config.endpointFile, JSON.stringify({ port: closedPort }));
    const res = await send('GET', '/_access', {
      Authorization: `Bearer ${key}`,
    });
    expect(res.status).toBe(502);
    expect(JSON.parse(res.body).code).toBe('supapowaUnreachable');
    revokeSupapowaKeys('nanoclaw-unic--main-4');
  });
});

describe('supapowaConfig', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('is off without SUPAPOWA_AGENT', () => {
    delete process.env.SUPAPOWA_AGENT;
    // readEnvFile reads .env in the working directory; the test checkout has none with this key.
    expect(supapowaConfig()).toBeNull();
  });

  it('defaults the token file from the agent name', () => {
    process.env.SUPAPOWA_AGENT = 'Unic';
    const c = supapowaConfig()!;
    expect(c.port).toBe(3002);
    expect(c.tokenFile).toBe(
      path.join(os.homedir(), '.config/agent-desktop/tokens/Unic.token'),
    );
  });
});
