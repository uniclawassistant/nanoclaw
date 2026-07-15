import { describe, expect, it } from 'vitest';

import { SessionInvalidationFence } from './session-invalidation.js';

describe('SessionInvalidationFence', () => {
  it('rejects late persistence of a reset session ID', () => {
    const fence = new SessionInvalidationFence();

    fence.invalidate('old-session');

    expect(fence.canPersist('old-session')).toBe(false);
    expect(fence.canPersist('fresh-session')).toBe(true);
  });

  it('keeps the old ID invalid after a fresh session is accepted', () => {
    const fence = new SessionInvalidationFence();

    fence.invalidate('old-session');
    expect(fence.canPersist('fresh-session')).toBe(true);

    expect(fence.canPersist('old-session')).toBe(false);
  });

  it('bounds retained invalidations', () => {
    const fence = new SessionInvalidationFence(2);

    fence.invalidate('oldest');
    fence.invalidate('middle');
    fence.invalidate('newest');

    expect(fence.canPersist('oldest')).toBe(true);
    expect(fence.canPersist('middle')).toBe(false);
    expect(fence.canPersist('newest')).toBe(false);
  });
});
