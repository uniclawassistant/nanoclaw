import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Large-context Claude model list', () => {
  it('host and container copies stay in sync', () => {
    const hostList = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, 'large-context-models.json'),
        'utf-8',
      ),
    );
    const containerList = JSON.parse(
      fs.readFileSync(
        path.resolve(
          __dirname,
          '../container/agent-runner/src/large-context-models.json',
        ),
        'utf-8',
      ),
    );

    expect(Array.isArray(hostList)).toBe(true);
    expect(Array.isArray(containerList)).toBe(true);
    expect(hostList).toEqual(containerList);
  });
});
