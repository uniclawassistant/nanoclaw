import { describe, expect, it } from 'vitest';

import {
  filterTasksByStatus,
  parseTaskFilter,
  taskStatusEmoji,
} from './tasks-filter.js';

describe('parseTaskFilter', () => {
  it('returns active default for undefined / null / empty input', () => {
    expect(parseTaskFilter(undefined)).toEqual({
      filter: 'active',
      unknownArg: null,
    });
    expect(parseTaskFilter(null)).toEqual({
      filter: 'active',
      unknownArg: null,
    });
    expect(parseTaskFilter('')).toEqual({
      filter: 'active',
      unknownArg: null,
    });
    expect(parseTaskFilter('   ')).toEqual({
      filter: 'active',
      unknownArg: null,
    });
  });

  it('accepts canonical tokens', () => {
    expect(parseTaskFilter('active').filter).toBe('active');
    expect(parseTaskFilter('paused').filter).toBe('paused');
    expect(parseTaskFilter('all').filter).toBe('all');
  });

  it('is case-insensitive and trims', () => {
    expect(parseTaskFilter('  ALL  ').filter).toBe('all');
    expect(parseTaskFilter('Paused').filter).toBe('paused');
  });

  it('falls back to active and reports unknown args verbatim', () => {
    expect(parseTaskFilter('failed')).toEqual({
      filter: 'active',
      unknownArg: 'failed',
    });
    expect(parseTaskFilter('  done\t')).toEqual({
      filter: 'active',
      unknownArg: 'done',
    });
  });
});

describe('filterTasksByStatus', () => {
  const tasks = [
    { id: 'a', status: 'active' as const },
    { id: 'b', status: 'paused' as const },
    { id: 'c', status: 'completed' as const },
    { id: 'd', status: 'active' as const },
  ];

  it('keeps only active when filter is active', () => {
    expect(filterTasksByStatus(tasks, 'active').map((t) => t.id)).toEqual([
      'a',
      'd',
    ]);
  });

  it('keeps only paused when filter is paused', () => {
    expect(filterTasksByStatus(tasks, 'paused').map((t) => t.id)).toEqual([
      'b',
    ]);
  });

  it('returns a fresh copy when filter is all', () => {
    const out = filterTasksByStatus(tasks, 'all');
    expect(out.map((t) => t.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(out).not.toBe(tasks);
  });

  it('handles empty input', () => {
    expect(filterTasksByStatus([], 'active')).toEqual([]);
    expect(filterTasksByStatus([], 'all')).toEqual([]);
  });
});

describe('taskStatusEmoji', () => {
  it('returns ✓ for active', () => {
    expect(taskStatusEmoji('active')).toBe('✓');
  });

  it('returns ⏸ for paused', () => {
    expect(taskStatusEmoji('paused')).toBe('⏸');
  });

  it('returns ✗ for completed and any other state', () => {
    expect(taskStatusEmoji('completed')).toBe('✗');
    expect(taskStatusEmoji('expired')).toBe('✗');
    expect(taskStatusEmoji('failed')).toBe('✗');
    expect(taskStatusEmoji('')).toBe('✗');
  });
});
