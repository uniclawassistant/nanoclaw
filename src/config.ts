import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'ONECLI_URL',
  'TZ',
  'CONTAINER_NAMESPACE',
  'WORK_CONTINUATIONS_ENABLED',
  'CONTINUATION_DELAY',
  'MAX_CONTINUATIONS',
  'MAX_WORK_HOURS',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

export function nonNegativeInteger(
  value: string | undefined,
  fallback: number,
): number {
  const normalized = value?.trim() ?? '';
  if (!normalized) return fallback;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function nonNegativeNumber(
  value: string | undefined,
  fallback: number,
): number {
  const normalized = value?.trim() ?? '';
  if (!normalized) return fallback;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export const WORK_CONTINUATIONS_ENABLED =
  (process.env.WORK_CONTINUATIONS_ENABLED ||
    envConfig.WORK_CONTINUATIONS_ENABLED ||
    'true') !== 'false';
export const CONTINUATION_DELAY = nonNegativeInteger(
  process.env.CONTINUATION_DELAY || envConfig.CONTINUATION_DELAY,
  300000,
);
export const MAX_CONTINUATIONS = nonNegativeInteger(
  process.env.MAX_CONTINUATIONS || envConfig.MAX_CONTINUATIONS,
  8,
);
export const MAX_WORK_HOURS = nonNegativeNumber(
  process.env.MAX_WORK_HOURS || envConfig.MAX_WORK_HOURS,
  4,
);

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';

const rawContainerNamespace =
  process.env.CONTAINER_NAMESPACE || envConfig.CONTAINER_NAMESPACE || '';
if (
  rawContainerNamespace &&
  (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(rawContainerNamespace) ||
    rawContainerNamespace.includes('--'))
) {
  throw new Error(
    'CONTAINER_NAMESPACE must be 1-32 lowercase letters, digits, or single hyphens',
  );
}
export const CONTAINER_NAMESPACE = rawContainerNamespace;
export const CONTAINER_NAME_PREFIX = CONTAINER_NAMESPACE
  ? `nanoclaw-${CONTAINER_NAMESPACE}--`
  : 'nanoclaw-';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const ONECLI_URL =
  process.env.ONECLI_URL || envConfig.ONECLI_URL || 'http://localhost:10254';
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
// Scheduled tasks are single-turn (poll → ack → exit). 5 min of silent inactivity
// means the container is hung, not legit work. User-message containers keep the
// longer 30 min window because real research / sub-agent runs can idle that long.
export const SCHEDULED_TASK_IDLE_TIMEOUT_MS = parseInt(
  process.env.SCHEDULED_TASK_IDLE_TIMEOUT_MS || '300000',
  10,
);
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

// Reset lifecycle guards (FED-37). An agent-initiated `reset_session mode:new`
// on a session younger than this is refused — a fresh session that tries to
// reset itself is almost always acting on a stale/unknown host-status ctx
// reading, and honoring it would spin a refresh loop. Legit self-resets only
// happen once real work has pushed ctx to threshold, which is far longer than
// this floor.
export const MIN_RESET_AGE_MS = parseInt(
  process.env.MIN_RESET_AGE_MS || '600000',
  10,
); // 10 min
// Circuit breaker: if more than MAX respawns fire within WINDOW for one group,
// stop respawning and alert the user instead of burning credits in a loop.
export const RESPAWN_CIRCUIT_WINDOW_MS = parseInt(
  process.env.RESPAWN_CIRCUIT_WINDOW_MS || '1800000',
  10,
); // 30 min
export const RESPAWN_CIRCUIT_MAX = Math.max(
  1,
  parseInt(process.env.RESPAWN_CIRCUIT_MAX || '3', 10) || 3,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds an anchored, case-insensitive matcher for a trigger prefix.
 *
 * Uses a Unicode-aware negative lookahead `(?![\p{L}\p{N}_])` (with the `u`
 * flag) rather than `\b`: JS `\b` is ASCII-only, so Cyrillic names like `@Аня`
 * would never fire. The lookahead lets punctuation follow the trigger
 * (`@Andy's thing`, `@Andy, hi`) while rejecting partial names (`@Andyextra`).
 */
export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}(?![\\p{L}\\p{N}_])`, 'iu');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();
