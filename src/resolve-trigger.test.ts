import { describe, it, expect } from 'vitest';

import { resolveTriggerMessageId } from './index.js';
import type { NewMessage, RegisteredGroup } from './types.js';

const JID = 'tg:-100123';

function msg(
  id: string,
  content: string,
  over: Partial<NewMessage> = {},
): NewMessage {
  return {
    id,
    chat_jid: JID,
    sender: 'user-1',
    sender_name: 'User',
    content,
    timestamp: `2024-01-01T00:00:${id.padStart(2, '0')}.000Z`,
    ...over,
  };
}

const mainGroup: RegisteredGroup = {
  name: 'main',
  folder: 'main',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

const soloGroup: RegisteredGroup = {
  name: 'dm',
  folder: 'dm',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
  requiresTrigger: false,
};

const triggerGroup: RegisteredGroup = {
  name: 'group',
  folder: 'group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

// FED-39: the piping path and the cold-spawn path both resolve the current
// turn's trigger message from the pending batch through this helper, so a
// reaction without an explicit message_id binds identically on both.
describe('resolveTriggerMessageId', () => {
  it('returns null for an empty batch', () => {
    expect(resolveTriggerMessageId([], mainGroup, JID, true)).toBeNull();
  });

  it('main group: uses the last message in the batch (no trigger needed)', () => {
    const batch = [msg('1', 'hi'), msg('2', 'there')];
    expect(resolveTriggerMessageId(batch, mainGroup, JID, true)).toBe('2');
  });

  it('no-trigger solo group: uses the last message in the batch', () => {
    const batch = [msg('1', 'hi'), msg('2', 'there')];
    expect(resolveTriggerMessageId(batch, soloGroup, JID, false)).toBe('2');
  });

  it('trigger group: uses the last trigger-matching message, not the last message', () => {
    const batch = [
      msg('1', '@Andy first', { is_from_me: true }),
      msg('2', '@Andy second', { is_from_me: true }),
      msg('3', 'plain follow-up without trigger', { is_from_me: true }),
    ];
    // The last *trigger-matching* message wins, not the trailing plain message.
    expect(resolveTriggerMessageId(batch, triggerGroup, JID, false)).toBe('2');
  });

  it('trigger group: returns null when no message matches the trigger', () => {
    const batch = [msg('1', 'no trigger here'), msg('2', 'still nothing')];
    expect(resolveTriggerMessageId(batch, triggerGroup, JID, false)).toBeNull();
  });
});
