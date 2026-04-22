import { Channel } from './types.js';

/**
 * If the channel has a cached 👀 reaction on the last user message in this chat,
 * clear it. Returns true when a clear was issued, false otherwise.
 *
 * Non-👀 cached reactions (e.g. 👌 set as explicit done-signal by the agent)
 * are left untouched — auto-clear is only for unresolved "working" markers.
 */
export async function autoClearEyeIfSet(
  channel: Channel | undefined,
  getLastUserMessageId: (jid: string) => string | null,
  jid: string,
): Promise<boolean> {
  if (!channel || !channel.setReaction || !channel.getCachedReaction) {
    return false;
  }
  const messageId = getLastUserMessageId(jid);
  if (!messageId) return false;
  const cached = channel.getCachedReaction(jid, messageId);
  if (cached !== '👀') return false;
  await channel.setReaction(jid, messageId, null);
  return true;
}
