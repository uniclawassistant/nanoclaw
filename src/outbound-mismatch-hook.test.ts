import { describe, it, expect, afterEach } from 'vitest';

import {
  beginTurn,
  endTurn,
  getActiveTurn,
  recordOutbound,
  recordReaction,
  updateTurnTrigger,
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

// FED-39: piped follow-up turns reuse the live container without a fresh
// beginTurn, so updateTurnTrigger refreshes the snapshot to the current turn's
// message. Without it the trigger stays frozen at the cold-spawn message and
// react() lands on the wrong (spawn-time) message for the container's lifetime.
describe('updateTurnTrigger (piping-path refresh)', () => {
  it('refreshes the active turn trigger to the piped message', () => {
    beginTurn(JID, {
      groupName: 'g',
      isUserFacing: true,
      triggerMessageId: 'spawn-msg',
    });

    updateTurnTrigger(JID, 'piped-msg');

    expect(getActiveTurn(JID)?.triggerMessageId).toBe('piped-msg');
  });

  it('advances across multiple piped follow-up turns', () => {
    beginTurn(JID, {
      groupName: 'g',
      isUserFacing: true,
      triggerMessageId: 'spawn-msg',
    });

    updateTurnTrigger(JID, 'piped-1');
    updateTurnTrigger(JID, 'piped-2');

    expect(getActiveTurn(JID)?.triggerMessageId).toBe('piped-2');
  });

  it('is a no-op when no turn is active', () => {
    updateTurnTrigger(JID, 'piped-msg');

    expect(getActiveTurn(JID)).toBeUndefined();
  });
});
