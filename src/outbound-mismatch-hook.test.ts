import { describe, it, expect, afterEach } from 'vitest';

import { beginTurn, endTurn, getActiveTurn } from './outbound-mismatch-hook.js';

const JID = 'tg:-100123';

afterEach(() => {
  endTurn(JID);
});

describe('turn lifecycle', () => {
  it('registers an active turn on beginTurn', () => {
    beginTurn(JID, { groupName: 'g', isUserFacing: true });

    const turn = getActiveTurn(JID);
    expect(turn?.groupName).toBe('g');
    expect(turn?.isUserFacing).toBe(true);
    expect(turn?.outboundCount).toBe(0);
    expect(turn?.lastReactionEmoji).toBeNull();
  });

  it('clears the active turn on endTurn', () => {
    beginTurn(JID, { groupName: 'g', isUserFacing: true });
    endTurn(JID);

    expect(getActiveTurn(JID)).toBeUndefined();
  });
});
