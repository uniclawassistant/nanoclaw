import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const BUILD_SCRIPT = path.resolve('container/build.sh');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-build-test-'));
const runtimePath = path.join(tempDir, 'container-runtime');
const buildLogPath = path.join(tempDir, 'build.log');

fs.writeFileSync(
  runtimePath,
  '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$BUILD_LOG"\n',
  { mode: 0o755 },
);

function runBuild(args: string[] = [], containerImage?: string) {
  const env = {
    ...process.env,
    BUILD_LOG: buildLogPath,
    CONTAINER_RUNTIME: runtimePath,
    NANOCLAW_BUILD_CLEANUP: '0',
  };

  if (containerImage === undefined) {
    delete env.CONTAINER_IMAGE;
  } else {
    env.CONTAINER_IMAGE = containerImage;
  }

  return spawnSync('bash', [BUILD_SCRIPT, ...args], {
    encoding: 'utf8',
    env,
  });
}

beforeEach(() => {
  fs.writeFileSync(buildLogPath, '');
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('container/build.sh', () => {
  it('fails before invoking the container runtime when no image name is provided', () => {
    const result = runBuild();
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain('nanoclaw-agent-unic:latest');
    expect(output).toContain('nanoclaw-agent-chef:latest');
    expect(output).toContain('./container/build.sh');
    expect(output).toContain('CONTAINER_IMAGE=');
    expect(fs.readFileSync(buildLogPath, 'utf8')).toBe('');
  });

  it('uses an explicit positional image name', () => {
    const result = runBuild(['custom-agent:latest']);

    expect(result.status).toBe(0);
    expect(fs.readFileSync(buildLogPath, 'utf8')).toBe(
      'build -t custom-agent:latest .\n',
    );
  });

  it('uses the CONTAINER_IMAGE environment variable', () => {
    const result = runBuild([], 'custom-env-agent:latest');

    expect(result.status).toBe(0);
    expect(fs.readFileSync(buildLogPath, 'utf8')).toBe(
      'build -t custom-env-agent:latest .\n',
    );
  });
});
