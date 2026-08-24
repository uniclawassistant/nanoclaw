import { describe, expect, it } from 'vitest';

import { buildInitialPrompt } from './initial-prompt.js';

describe('initial prompt', () => {
  it('preserves a work continuation verbatim', () => {
    const remaining = 'line 1\nline 2';

    const prompt = buildInitialPrompt(remaining, true, true, []);

    expect(prompt.split('\n')).toEqual(remaining.split('\n'));
  });

  it('keeps the existing header for ordinary scheduled tasks', () => {
    const prompt = buildInitialPrompt('run report', true, false, []);

    expect(prompt).toContain('[SCHEDULED TASK');
    expect(prompt).toContain('run report');
  });
});
