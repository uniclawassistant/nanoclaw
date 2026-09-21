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

describe('work continuation header', () => {
  it('names the work so the woken session can close it', () => {
    const initial = buildInitialPrompt(
      'finish the audit',
      true,
      true,
      [],
      'weekly-memory-audit-2026-09-13',
    );

    expect(initial).toContain('weekly-memory-audit-2026-09-13');
    expect(initial).toContain('close_work');
    expect(initial.endsWith('finish the audit')).toBe(true);
  });

  it('carries remaining verbatim below the header', () => {
    const remaining = 'line 1\nline 2\n  indented\ttab';

    const initial = buildInitialPrompt(remaining, true, true, [], 'canary');

    expect(initial.slice(initial.length - remaining.length)).toBe(remaining);
  });

  it('adds no header when the host sent no work id', () => {
    const initial = buildInitialPrompt('finish the audit', true, true, []);

    expect(initial).toBe('finish the audit');
  });
});
