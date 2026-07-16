import { logger } from './logger.js';
import { Channel } from './types.js';

/**
 * Clear every 👀 "working" marker this process set in `jid`, reading the target
 * messages straight from the channel's reaction cache. Clearing where the 👀 was
 * actually set — rather than re-resolving a single target at turn-end, which
 * drifts off the set-message when messages arrive mid-turn — guarantees no
 * orphaned 👀 regardless of trigger drift.
 *
 * Non-👀 cached reactions (e.g. 👌 set as an explicit done-signal by the agent)
 * are never returned by getCachedEyeMessageIds, so they are left untouched.
 * Returns the number of markers cleared.
 */
export async function autoClearEyeIfSet(
  channel: Channel | undefined,
  jid: string,
): Promise<number> {
  if (!channel || !channel.setReaction || !channel.getCachedEyeMessageIds) {
    return 0;
  }
  const messageIds = channel.getCachedEyeMessageIds(jid);
  let cleared = 0;
  for (const messageId of messageIds) {
    try {
      await channel.setReaction(jid, messageId, null);
      cleared++;
    } catch (err) {
      // Best-effort: a failed clear leaves the 👀 cached, so the next turn's
      // Stop hook retries it. Don't let one failure block the remaining ids.
      logger.warn({ jid, messageId, err }, 'Failed to auto-clear 👀 reaction');
    }
  }
  return cleared;
}
