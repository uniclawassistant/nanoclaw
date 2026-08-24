import { describe, expect, it, vi } from 'vitest';

import { TurnBoundary } from './turn-boundary.js';

describe('TurnBoundary', () => {
  it('handles an unfinished turn when the run rejects', async () => {
    const boundary = new TurnBoundary();
    const handle = vi.fn(async () => {});

    await boundary.handlePending(handle);

    expect(handle).toHaveBeenCalledTimes(1);
    expect(boundary.isPending()).toBe(false);
  });

  it('does not handle an observed turn end twice in finally', async () => {
    const boundary = new TurnBoundary();
    const handle = vi.fn(async () => {});

    await boundary.handleObserved(handle);
    await boundary.handlePending(handle);

    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('tracks activity after an earlier completed turn', async () => {
    const boundary = new TurnBoundary();
    const handle = vi.fn(async () => {});
    await boundary.handleObserved(handle);

    boundary.markActivity();
    await boundary.handlePending(handle);

    expect(handle).toHaveBeenCalledTimes(2);
  });
});
