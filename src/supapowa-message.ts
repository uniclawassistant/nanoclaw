import { randomUUID } from 'crypto';

import { storeMessage } from './db.js';

/** Store a host notification for the existing message loop to wake the main group. */
export function storeSupapowaMessage(
  groups: Record<string, { isMain?: boolean }>,
  content: string,
): void {
  const main = Object.entries(groups).find(([, group]) => group.isMain);
  if (!main) throw new Error('Main group is not registered');
  storeMessage({
    id: `supapowa-${randomUUID()}`,
    chat_jid: main[0],
    sender: 'supapowa',
    sender_name: 'Supapowa',
    content,
    timestamp: new Date().toISOString(),
    is_from_me: false,
    is_bot_message: false,
  });
}
