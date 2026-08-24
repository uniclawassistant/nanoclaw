import { describe, expect, it } from 'vitest';

import { nonNegativeInteger, nonNegativeNumber } from './config.js';

describe('numeric configuration parsing', () => {
  it('rejects partially numeric integer values', () => {
    expect(nonNegativeInteger('5m', 300_000)).toBe(300_000);
    expect(nonNegativeInteger('10.5', 8)).toBe(8);
  });

  it('accepts complete non-negative integer values', () => {
    expect(nonNegativeInteger('0', 8)).toBe(0);
    expect(nonNegativeInteger(' 300000 ', 0)).toBe(300_000);
  });

  it('rejects partially numeric decimal values', () => {
    expect(nonNegativeNumber('4h', 4)).toBe(4);
    expect(nonNegativeNumber('-1', 4)).toBe(4);
  });

  it('accepts complete non-negative decimal values', () => {
    expect(nonNegativeNumber('0', 4)).toBe(0);
    expect(nonNegativeNumber('1.5', 4)).toBe(1.5);
  });
});
