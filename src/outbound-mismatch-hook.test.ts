import { describe, it, expect, afterEach } from 'vitest';

import {
  beginTurn,
  endTurn,
  getActiveTurn,
  recordOutbound,
  recordReaction,
} from './outbound-mismatch-hook.js';

const JID = 'tg:-100123';

afterEach(() => {
  endTurn(JID);
});

// FED-37: the trigger message is snapshotted at turn start so react() without
// an explicit message_id binds to the message that woke the agent — stable for
// the whole turn regardless of newer messages or intervening tool calls.
describe('turn trigger-message snapshot', () => {
  it('stores the trigger message id passed at turn start', () => {
    beginTurn(JID, {
      groupName: 'g',
      isUserFacing: true,
      triggerMessageId: 'trigger-1',
    });

    expect(getActiveTurn(JID)?.triggerMessageId).toBe('trigger-1');
  });

  it('defaults triggerMessageId to null when omitted', () => {
    beginTurn(JID, { groupName: 'g', isUserFacing: true });

    expect(getActiveTurn(JID)?.triggerMessageId).toBeNull();
  });

  it('keeps the snapshot fixed across reactions and outbound during the turn', () => {
    beginTurn(JID, {
      groupName: 'g',
      isUserFacing: true,
      triggerMessageId: 'trigger-1',
    });

    // Simulate the agent working the turn: 👀, an outbound, then a done react.
    recordReaction(JID, '👀');
    recordOutbound(JID);
    recordReaction(JID, '👌');

    // The snapshot must not drift — both the 👀 and the 👌 resolve to it.
    expect(getActiveTurn(JID)?.triggerMessageId).toBe('trigger-1');
  });

  it('clears the snapshot when the turn ends', () => {
    beginTurn(JID, {
      groupName: 'g',
      isUserFacing: true,
      triggerMessageId: 'trigger-1',
    });
    endTurn(JID);

    expect(getActiveTurn(JID)).toBeUndefined();
  });
});
