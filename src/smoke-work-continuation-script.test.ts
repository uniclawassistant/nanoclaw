import Database from 'better-sqlite3';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve('scripts/smoke-work-continuation.sh');
const CLIENT = path.resolve('scripts/work-continuation-smoke-client.mjs');
let tempDir: string;
let checkout: string;
let runtimePath: string;
let runtimeLog: string;

const fakeRuntime = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.RUNTIME_LOG, JSON.stringify(args) + '\\n');
let outputDir;
let ipcDir;
const env = {};
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '-v') {
    const value = args[index + 1];
    if (value.endsWith(':/smoke-output')) outputDir = value.slice(0, -':/smoke-output'.length);
    if (value.endsWith(':/workspace/ipc')) ipcDir = value.slice(0, -':/workspace/ipc'.length);
    index += 1;
  } else if (args[index] === '-e') {
    const value = args[index + 1];
    const separator = value.indexOf('=');
    env[value.slice(0, separator)] = value.slice(separator + 1);
    index += 1;
  }
}
if (!outputDir) throw new Error('missing smoke output mount');
const response = (text) => {
  const value = { content: [{ type: 'text', text }] };
  return { response: value, responseJson: JSON.stringify(value), text };
};
const remainingPreview = env.SMOKE_REMAINING.length > 50
  ? env.SMOKE_REMAINING.slice(0, 50) + '...'
  : env.SMOKE_REMAINING;
const workLine = 'Declared work:\\n- ▶ [' + env.SMOKE_WORK_ID + '] ' + remainingPreview + ' - open, continuations: 0, empty passes: 0, pending task: none';
const events = [
  { step: 'open_work', tool: 'open_work', ...response('{"ok":true}') },
  { step: 'list_work', tool: 'list_work', ...response(workLine) },
];
if (process.env.FAKE_MODE === 'rotate-log') {
  const checkout = path.resolve(ipcDir, '..', '..', '..');
  const log = path.join(checkout, 'logs', 'nanoclaw.log');
  fs.renameSync(log, log + '.rotated');
  fs.writeFileSync(log, 'replacement log without errors\\n');
}
if (process.env.FAKE_MODE === 'close-false') {
  events.push(
    { step: 'close_work', tool: 'close_work', ...response('{"ok":true,"closed":false}') },
    { step: 'post_close_list_initial', tool: 'list_work', ...response(workLine) },
    { step: 'cleanup_close_work', tool: 'close_work', ...response('{"ok":true,"closed":true}') },
    { step: 'post_close_list', tool: 'list_work', ...response('No work found.') },
  );
} else {
  events.push(
    { step: 'close_work', tool: 'close_work', ...response('{"ok":true,"closed":true}') },
    { step: 'post_close_list', tool: 'list_work', ...response('No work found.') },
  );
}
fs.writeFileSync(
  outputDir + '/result.json',
  JSON.stringify({ version: 1, exitCode: 0, events }) + '\\n',
);
`;

function createCheckout(): void {
  checkout = path.join(tempDir, 'checkout');
  fs.mkdirSync(path.join(checkout, 'store'), { recursive: true });
  fs.mkdirSync(path.join(checkout, 'data', 'ipc', 'test-group'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(checkout, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(checkout, 'logs', 'nanoclaw.log'), 'before\n');
  fs.writeFileSync(
    path.join(checkout, 'logs', 'nanoclaw.error.log'),
    'before\n',
  );
  const database = new Database(path.join(checkout, 'store', 'messages.db'));
  database.exec(`
    CREATE TABLE open_work (
      id TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      remaining TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      continuation_count INTEGER NOT NULL DEFAULT 0,
      pending_task_id TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      halted_reason TEXT,
      claimed_task_id TEXT,
      last_continuation_at TEXT,
      empty_continuation_count INTEGER NOT NULL DEFAULT 0,
      halted_kind TEXT,
      PRIMARY KEY (group_folder, id)
    );
  `);
  database.close();
}

function runSmoke(
  extraArgs: string[] = [],
  extraEnv: Record<string, string> = {},
  includeWorkId = true,
) {
  const workIdArgs = includeWorkId ? ['--work-id', 'smoke-test'] : [];
  return spawnSync(
    'bash',
    [
      SCRIPT,
      '--checkout',
      checkout,
      '--image',
      'fake-agent:latest',
      '--group',
      'test-group',
      '--chat-jid',
      'tg:test',
      ...workIdArgs,
      '--remaining',
      'Synthetic smoke remaining that is deliberately longer than fifty characters',
      '--container-runtime',
      runtimePath,
      ...extraArgs,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        RUNTIME_LOG: runtimeLog,
        ...extraEnv,
      },
    },
  );
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-work-smoke-'));
  runtimePath = path.join(tempDir, 'fake-container');
  runtimeLog = path.join(tempDir, 'runtime.log');
  fs.writeFileSync(runtimePath, fakeRuntime, { mode: 0o755 });
  fs.writeFileSync(runtimeLog, '');
  createCheckout();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('scripts/smoke-work-continuation.sh', () => {
  it('runs the real image path contract and passes a synthetic lifecycle', () => {
    const result = runSmoke();
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).toContain('smoke-work-continuation/1');
    expect(output).toContain(
      'MCP step=open_work tool=open_work response:\n' +
        '{"content":[{"type":"text","text":"{\\"ok\\":true}"}]}',
    );
    expect(output).toContain(
      'MCP step=close_work tool=close_work text:\n' +
        '{"ok":true,"closed":true}',
    );
    expect(output).toContain('LOG nanoclaw.log ERRORS count=0');
    expect(output).toContain('LOG nanoclaw.error.log ERRORS count=0');
    expect(output).toContain('PASS work-continuation smoke');

    const invocation = JSON.parse(
      fs.readFileSync(runtimeLog, 'utf8').trim(),
    ) as string[];
    expect(invocation).toContain('--entrypoint');
    expect(invocation).toContain('fake-agent:latest');
    expect(invocation.at(-1)).toBe('/smoke/work-continuation-smoke-client.mjs');
    expect(invocation).toContain(
      `${path.join(checkout, 'data', 'ipc', 'test-group')}:/workspace/ipc`,
    );
  });

  it('fails at the named open_work expectation when exact text is changed', () => {
    const result = runSmoke([
      '--expect-open-text',
      '{"ok":true,"unexpected":true}',
    ]);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain('FAIL step=open_work-exact');
    expect(output).toContain('got \'{"ok":true}\'');
    expect(output).not.toContain('PASS work-continuation smoke');
  });

  it('fails at close_work and still removes work through MCP for a wrong close id', () => {
    const result = runSmoke(['--close-work-id', 'does-not-exist'], {
      FAKE_MODE: 'close-false',
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain('FAIL step=close_work-exact');
    expect(output).toContain('{"ok":true,"closed":false}');
    expect(output).toContain(
      'MCP step=cleanup_close_work tool=close_work text:\n' +
        '{"ok":true,"closed":true}',
    );
    expect(output).toContain('STATE after (read-only): []');
  });

  it('cleans up through MCP when the real close id returns closed false', () => {
    const result = runSmoke([], { FAKE_MODE: 'close-false' });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain('FAIL step=close_work-exact');
    expect(output).toContain(
      'MCP step=cleanup_close_work tool=close_work text:\n' +
        '{"ok":true,"closed":true}',
    );
    expect(output).toContain('STATE after (read-only): []');
  });

  it('detects replacement even when the new log is larger than the offset', () => {
    const result = runSmoke([], { FAKE_MODE: 'rotate-log' });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain('rotated_or_truncated=true');
    expect(output).toContain('scan_scope=whole-current-file-after-rotation');
    expect(output).toContain('FAIL step=logs-nanoclaw.log-rotation');
  });

  it('generates a synthetic id when --work-id is omitted', () => {
    const result = runSmoke([], {}, false);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).toMatch(
      /work_id=smoke-work-continuation-\d{8}T\d{6}Z-\d+-\d+/,
    );
    expect(output).toContain('PASS work-continuation smoke');
  });

  it('refuses to overwrite a pre-existing id without --existing-work', () => {
    const database = new Database(path.join(checkout, 'store', 'messages.db'));
    database
      .prepare(
        `INSERT INTO open_work (
          id, group_folder, chat_jid, remaining, opened_at, status
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'smoke-test',
        'test-group',
        'tg:test',
        'do not overwrite me',
        '2026-09-21T00:00:00.000Z',
        'halted',
      );
    database.close();

    const result = runSmoke();
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain('FAIL step=preflight-synthetic-id');
    expect(output).toContain('do not overwrite me');
    expect(fs.readFileSync(runtimeLog, 'utf8')).toBe('');
  });
});

describe('scripts/work-continuation-smoke-client.mjs', () => {
  it('allowlists the MCP server environment and does not forward inference keys', () => {
    const sdkRoot = path.join(tempDir, 'fake-sdk');
    const clientDir = path.join(sdkRoot, 'client');
    fs.mkdirSync(clientDir, { recursive: true });
    fs.writeFileSync(
      path.join(sdkRoot, 'package.json'),
      JSON.stringify({ type: 'module' }),
    );
    fs.writeFileSync(
      path.join(clientDir, 'stdio.js'),
      `export class StdioClientTransport {
        constructor(options) { this.options = options; this.stderr = null; }
      }\n`,
    );
    fs.writeFileSync(
      path.join(clientDir, 'index.js'),
      `import fs from 'node:fs';
      export class Client {
        async connect(transport) {
          fs.writeFileSync(process.env.CLIENT_LOG, JSON.stringify(transport.options.env));
          this.open = false;
        }
        async callTool(call) {
          if (call.name === 'open_work') {
            this.open = true;
            return { content: [{ type: 'text', text: '{"ok":true}' }] };
          }
          if (call.name === 'list_work') {
            return { content: [{ type: 'text', text: this.open
              ? 'Declared work:\\n- ▶ [client-test] remaining - open, continuations: 0, empty passes: 0, pending task: none'
              : 'No work found.' }] };
          }
          if (call.name === 'close_work') {
            this.open = false;
            return { content: [{ type: 'text', text: '{"ok":true,"closed":true}' }] };
          }
          throw new Error('unexpected tool ' + call.name);
        }
        async close() {}
      }\n`,
    );
    const resultPath = path.join(tempDir, 'client-result.json');
    const clientLog = path.join(tempDir, 'client-env.json');

    const result = spawnSync('node', [CLIENT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        MCP_SDK_ROOT: sdkRoot,
        SMOKE_RESULT_PATH: resultPath,
        SMOKE_WORK_ID: 'client-test',
        SMOKE_REMAINING: 'remaining',
        NANOCLAW_CHAT_JID: 'tg:test',
        NANOCLAW_GROUP_FOLDER: 'test-group',
        NANOCLAW_IS_MAIN: '0',
        CLIENT_LOG: clientLog,
        ANTHROPIC_API_KEY: 'must-not-cross-the-boundary',
      },
    });

    expect(result.status).toBe(0);
    const serverEnv = JSON.parse(fs.readFileSync(clientLog, 'utf8')) as Record<
      string,
      string
    >;
    expect(serverEnv).toEqual({
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      NANOCLAW_CHAT_JID: 'tg:test',
      NANOCLAW_GROUP_FOLDER: 'test-group',
      NANOCLAW_IS_MAIN: '0',
    });
    expect(serverEnv).not.toHaveProperty('ANTHROPIC_API_KEY');
    const clientResult = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as {
      events: Array<{ step: string }>;
    };
    expect(clientResult.events.map((event) => event.step)).toEqual([
      'open_work',
      'list_work',
      'close_work',
      'post_close_list',
    ]);
  });
});
