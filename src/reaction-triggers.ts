/**
 * Reaction triggers whitelist loader.
 *
 * Reads `~/.config/nanoclaw/reaction-triggers.json` — a JSON array of emoji
 * strings whose presence on a non-bot reactor's `new_reaction` for a bot
 * outbound message should wake the agent.
 *
 * Hot-reload: re-reads the file on every call. The file is tiny and reactions
 * are rare, so a watcher is unnecessary.
 *
 * Fail-safe: missing / malformed / non-array / parse-error → empty set, which
 * means no reaction wakes the bot. We intentionally fail closed: a fail-open
 * would let any reaction (including spam) burn API credits.
 */
import fs from 'fs';

import { REACTION_TRIGGERS_PATH } from './config.js';
import { logger } from './logger.js';

let lastErrorSignature: string | null = null;

export function loadReactionTriggers(
  filePath: string = REACTION_TRIGGERS_PATH,
): Set<string> {
  try {
    if (!fs.existsSync(filePath)) {
      noteOnce(`missing:${filePath}`, () => {
        logger.info(
          { path: filePath },
          'reaction-triggers file absent — no reactions will wake the bot',
        );
      });
      return new Set();
    }

    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;

    if (!Array.isArray(parsed)) {
      noteOnce('not-array', () => {
        logger.error(
          { path: filePath },
          'reaction-triggers must be a JSON array of emoji strings — fail-safe: no reactions wake',
        );
      });
      return new Set();
    }

    const emojis = parsed.filter(
      (v): v is string => typeof v === 'string' && v.length > 0,
    );

    // Successful load resets the error signature so the next failure logs again.
    lastErrorSignature = null;

    return new Set(emojis);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    noteOnce(`err:${msg}`, () => {
      logger.error(
        { path: filePath, err: msg },
        'reaction-triggers load failed — fail-safe: no reactions wake',
      );
    });
    return new Set();
  }
}

/**
 * Suppress repeat-logging for the same error/missing condition. Reactions are
 * rare but a watch loop would still spam logs over weeks of no triggers file.
 */
function noteOnce(signature: string, log: () => void): void {
  if (lastErrorSignature === signature) return;
  lastErrorSignature = signature;
  log();
}

// Test helper — reset the dedup state so tests can assert log behavior.
export function _resetReactionTriggersLogState(): void {
  lastErrorSignature = null;
}
