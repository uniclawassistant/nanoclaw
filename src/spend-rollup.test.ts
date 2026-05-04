import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'spend-rollup.sh');

let tmpDir: string;
let jsonl: string;
let outFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-rollup-'));
  jsonl = path.join(tmpDir, 'spend.jsonl');
  outFile = path.join(tmpDir, 'spend-log.md');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeJsonl(rows: object[]): void {
  fs.writeFileSync(jsonl, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function run(args: string[] = []): string {
  return execFileSync('bash', [SCRIPT, ...args], { encoding: 'utf-8' });
}

describe('scripts/spend-rollup.sh', () => {
  it('aggregates a day with mixed origins and missing-cost turns', () => {
    writeJsonl([
      {
        ts: '2026-05-03T10:00:00.000Z',
        jid: 'j1',
        sessionId: 's1',
        cost: 0.42,
        input: 1000,
        output: 500,
        cacheRead: 2000,
        cacheCreate: 300,
        contextUsed: 3300,
        contextWindow: 1_000_000,
        origin: 'interactive',
      },
      {
        ts: '2026-05-03T11:00:00.000Z',
        jid: 'j1',
        sessionId: 's1',
        cost: 0.18,
        input: 800,
        output: 200,
        cacheRead: 15000,
        cacheCreate: 0,
        contextUsed: 15800,
        contextWindow: 1_000_000,
        origin: 'scheduled',
      },
      {
        ts: '2026-05-03T12:00:00.000Z',
        jid: 'j1',
        sessionId: 's1',
        cost: null,
        input: 500,
        output: 100,
        cacheRead: 1000,
        cacheCreate: 0,
        contextUsed: 1600,
        contextWindow: 1_000_000,
        origin: 'interactive',
      },
    ]);

    run(['--date', '2026-05-03', '--jsonl', jsonl, '--out', outFile]);
    const md = fs.readFileSync(outFile, 'utf-8');
    expect(md).toContain('## 2026-05-03');
    expect(md).toMatch(/Total: \$0\.60 \(3 turns\)/);
    expect(md).toMatch(/Interactive: \$0\.42 \(2 turns\)/);
    expect(md).toMatch(/Scheduled: \$0\.18 \(1 turns\)/);
    expect(md).toMatch(/Avg context: 7k tokens/);
    expect(md).toMatch(/Turns with no cost data: 1/);
  });

  it('is idempotent — second run with same date does not duplicate', () => {
    writeJsonl([
      {
        ts: '2026-05-03T10:00:00.000Z',
        jid: 'j1',
        sessionId: 's1',
        cost: 0.1,
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheCreate: 0,
        contextUsed: 10,
        contextWindow: 1_000_000,
        origin: 'interactive',
      },
    ]);
    run(['--date', '2026-05-03', '--jsonl', jsonl, '--out', outFile]);
    const out1 = fs.readFileSync(outFile, 'utf-8');
    run(['--date', '2026-05-03', '--jsonl', jsonl, '--out', outFile]);
    const out2 = fs.readFileSync(outFile, 'utf-8');
    expect(out2).toBe(out1);
    const sectionCount = (out2.match(/^## 2026-05-03$/gm) ?? []).length;
    expect(sectionCount).toBe(1);
  });

  it('skips dates with no entries', () => {
    writeJsonl([
      {
        ts: '2026-05-03T10:00:00.000Z',
        jid: 'j1',
        sessionId: 's1',
        cost: 0.1,
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheCreate: 0,
        contextUsed: 10,
        contextWindow: 1_000_000,
        origin: 'interactive',
      },
    ]);
    const stdout = run([
      '--date',
      '2026-05-04',
      '--jsonl',
      jsonl,
      '--out',
      outFile,
    ]);
    expect(stdout).toMatch(/no entries/);
    if (fs.existsSync(outFile)) {
      expect(fs.readFileSync(outFile, 'utf-8')).toBe('');
    }
  });

  it('exits cleanly when JSONL file is missing', () => {
    const stdout = run([
      '--date',
      '2026-05-03',
      '--jsonl',
      path.join(tmpDir, 'nonexistent.jsonl'),
      '--out',
      outFile,
    ]);
    expect(stdout).toMatch(/no JSONL/);
  });

  it('--dry-run prints section without writing the file', () => {
    writeJsonl([
      {
        ts: '2026-05-03T10:00:00.000Z',
        jid: 'j1',
        sessionId: 's1',
        cost: 0.05,
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheCreate: 0,
        contextUsed: 10,
        contextWindow: 1_000_000,
        origin: 'interactive',
      },
    ]);
    const stdout = run([
      '--date',
      '2026-05-03',
      '--jsonl',
      jsonl,
      '--out',
      outFile,
      '--dry-run',
    ]);
    expect(stdout).toContain('DRY RUN');
    expect(stdout).toContain('## 2026-05-03');
    expect(fs.existsSync(outFile)).toBe(false);
  });
});
