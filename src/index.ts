import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  ASSISTANT_NAME,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  ONECLI_URL,
  CREDENTIAL_PROXY_PORT,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import { startCredentialProxy } from './credential-proxy.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  ensureNetworkKeepalive,
  PROXY_BIND_HOST,
  waitForHostAddress,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  deleteSession,
  getAllTasks,
  getLastBotMessageTimestamp,
  getLastIncomingThreadId,
  getLastUserMessageId,
  getMessageById,
  getMessagesAroundTimestamp,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  searchMessages,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  storeOutgoingMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { autoClearEyeIfSet } from './auto-clear-eye.js';
import { startIpcWatcher } from './ipc.js';
import {
  beginTurn,
  checkClassA,
  checkClassB,
  endTurn,
  recordOutbound,
} from './outbound-mismatch-hook.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { editImage, generateImage } from './image-gen.js';
import { buildVoiceDirective, synthesize } from './tts.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSessionCleanup } from './session-cleanup.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

function recordOutgoing(
  jid: string,
  messageId: string | undefined,
  args: {
    content: string;
    messageType: 'text' | 'photo' | 'document' | 'voice' | 'video';
    filePath?: string;
    generation?: {
      prompt: string;
      preset?: string;
      original_png_path: string;
      source_message_id?: string;
    };
  },
): void {
  if (!messageId) return;
  try {
    storeOutgoingMessage({
      id: messageId,
      chat_jid: jid,
      sender: ASSISTANT_NAME,
      sender_name: ASSISTANT_NAME,
      content: args.content,
      timestamp: new Date().toISOString(),
      message_type: args.messageType,
      file_path: args.filePath ?? null,
      generation: args.generation ?? null,
    });
  } catch (err) {
    logger.warn({ err, jid, messageId }, 'Failed to record outgoing message');
  }
}

export async function sendText(
  channel: Channel,
  jid: string,
  text: string,
  threadId?: string,
): Promise<void> {
  const msgId = await channel.sendMessage(jid, text, threadId);
  recordOutgoing(jid, msgId, { content: text, messageType: 'text' });
}

export interface ImageGenDelivery {
  ok: true;
  message_id: string;
  file_path: string;
  message_type: 'photo' | 'document';
}

/**
 * Generate or edit an image and ship it to chat. Returns `{ ok, message_id }`
 * for the MCP tool, or `{ ok: false, error }` on any terminal failure
 * (moderation / bad params / source missing / Telegram reject). Transient
 * fetch errors are also surfaced so the agent can retry explicitly.
 */
async function generateAndDeliverImage(
  channel: Channel,
  jid: string,
  groupFolder: string,
  prompt: string,
  presets: string[] | undefined,
  caption: string | undefined,
  threadId: string | undefined,
): Promise<ImageGenDelivery | { ok: false; error: string }> {
  const attachmentsDir = path.join(GROUPS_DIR, groupFolder, 'attachments');
  const outcome = await generateImage(prompt, attachmentsDir, presets);
  return deliverImageOutcome(
    channel,
    jid,
    groupFolder,
    prompt,
    outcome,
    caption,
    threadId,
  );
}

async function editAndDeliverImage(
  channel: Channel,
  jid: string,
  groupFolder: string,
  sourceAbsPath: string,
  sourceMessageId: string,
  prompt: string,
  presets: string[] | undefined,
  caption: string | undefined,
  threadId: string | undefined,
): Promise<ImageGenDelivery | { ok: false; error: string }> {
  const attachmentsDir = path.join(GROUPS_DIR, groupFolder, 'attachments');
  const outcome = await editImage(
    sourceAbsPath,
    prompt,
    attachmentsDir,
    presets,
  );
  return deliverImageOutcome(
    channel,
    jid,
    groupFolder,
    prompt,
    outcome,
    caption,
    threadId,
    sourceMessageId,
  );
}

async function deliverImageOutcome(
  channel: Channel,
  jid: string,
  groupFolder: string,
  prompt: string,
  outcome: Awaited<ReturnType<typeof generateImage>>,
  caption: string | undefined,
  threadId: string | undefined,
  sourceMessageId?: string,
): Promise<ImageGenDelivery | { ok: false; error: string }> {
  if (!outcome) {
    return { ok: false, error: 'image generation not configured (no API key)' };
  }
  if (outcome.ok === false) {
    const detail = outcome.message ? `: ${outcome.message}` : '';
    return { ok: false, error: `${outcome.reason}${detail}` };
  }
  const groupRootAbs = path.resolve(GROUPS_DIR, groupFolder);
  const relOriginal = path.relative(groupRootAbs, outcome.originalPath);
  const relPreview = path.relative(groupRootAbs, outcome.previewPath);

  // Telegram's bot-API photo endpoint rejects files >10MB. Fall back to
  // sending the full-fidelity original as a document for oversized previews.
  const previewSize = fs.statSync(outcome.previewPath).size;
  const PHOTO_SIZE_CAP = 9 * 1024 * 1024;

  if (previewSize > PHOTO_SIZE_CAP && channel.sendDocument) {
    logger.info(
      { jid, previewSize, relOriginal },
      'Preview exceeds photo size cap, falling back to document',
    );
    const docResult = await channel.sendDocument(
      jid,
      outcome.originalPath,
      caption,
      threadId,
    );
    if (!docResult.ok) return { ok: false, error: docResult.error };
    recordOutgoing(jid, docResult.message_id, {
      content: `[Document] (${relOriginal})${caption ? ' ' + caption : ''}`,
      messageType: 'document',
      filePath: relOriginal,
      generation: {
        prompt,
        original_png_path: relOriginal,
        ...(sourceMessageId ? { source_message_id: sourceMessageId } : {}),
      },
    });
    return {
      ok: true,
      message_id: docResult.message_id,
      file_path: relOriginal,
      message_type: 'document',
    };
  }

  if (!channel.sendPhoto) {
    return { ok: false, error: 'channel does not support sendPhoto' };
  }
  const photoResult = await channel.sendPhoto(
    jid,
    outcome.previewPath,
    caption,
    threadId,
  );
  if (!photoResult.ok) return { ok: false, error: photoResult.error };
  recordOutgoing(jid, photoResult.message_id, {
    content: `[Photo] (${relPreview})${caption ? ' ' + caption : ''}`,
    messageType: 'photo',
    filePath: relPreview,
    generation: {
      prompt,
      original_png_path: relOriginal,
      ...(sourceMessageId ? { source_message_id: sourceMessageId } : {}),
    },
  });
  return {
    ok: true,
    message_id: photoResult.message_id,
    file_path: relPreview,
    message_type: 'photo',
  };
}

/**
 * Send a local image (already on disk) as a compressed photo with optional
 * caption. Returns `{ ok, message_id }` or `{ ok: false, error }`.
 */
async function sendImageFromPath(
  channel: Channel,
  jid: string,
  groupFolder: string,
  hostPath: string,
  caption: string | undefined,
  threadId: string | undefined,
): Promise<ImageGenDelivery | { ok: false; error: string }> {
  if (!channel.sendPhoto) {
    return { ok: false, error: 'channel does not support sendPhoto' };
  }
  const result = await channel.sendPhoto(jid, hostPath, caption, threadId);
  if (!result.ok) return { ok: false, error: result.error };
  const groupRootAbs = path.resolve(GROUPS_DIR, groupFolder);
  const relPath = path.relative(groupRootAbs, hostPath);
  // For paths outside the group root (extra-mounts), keep the absolute path —
  // matches send_file/recordOutgoingDocument behavior for trace recovery.
  const tracePath = relPath.startsWith('..') ? hostPath : relPath;
  recordOutgoing(jid, result.message_id, {
    content: `[Photo] (${tracePath})${caption ? ' ' + caption : ''}`,
    messageType: 'photo',
    filePath: tracePath,
  });
  return {
    ok: true,
    message_id: result.message_id,
    file_path: tracePath,
    message_type: 'photo',
  };
}

/**
 * Synthesize TTS audio and send as a voice message. Returns `{ ok, message_id }`
 * or `{ ok: false, error }`.
 */
async function synthesizeAndSendVoice(
  channel: Channel,
  jid: string,
  text: string,
  directive: VoiceDirectiveInput,
  threadId: string | undefined,
): Promise<{ ok: true; message_id: string } | { ok: false; error: string }> {
  if (!channel.sendVoice) {
    return { ok: false, error: 'channel does not support sendVoice' };
  }
  const resolved = buildVoiceDirective(directive);
  let audio: Buffer | null;
  try {
    audio = await synthesize(text, resolved);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (!audio) {
    return { ok: false, error: 'TTS not configured (no API key)' };
  }
  const result = await channel.sendVoice(jid, audio, threadId);
  if (!result.ok) return { ok: false, error: result.error };
  recordOutgoing(jid, result.message_id, {
    content: `[Voice] ${text}`,
    messageType: 'voice',
  });
  return { ok: true, message_id: result.message_id };
}

interface VoiceDirectiveInput {
  voice?: string;
  director?: string;
  profile?: string;
  scene?: string;
}

const onecli = new OneCLI({ url: ONECLI_URL });

function ensureOneCLIAgent(jid: string, group: RegisteredGroup): void {
  if (group.isMain) return;
  const identifier = group.folder.toLowerCase().replace(/_/g, '-');
  onecli.ensureAgent({ name: group.name, identifier }).then(
    (res) => {
      logger.info(
        { jid, identifier, created: res.created },
        'OneCLI agent ensured',
      );
    },
    (err) => {
      logger.debug(
        { jid, identifier, err: String(err) },
        'OneCLI agent ensure skipped',
      );
    },
  );
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateFile = path.join(
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  // Ensure a corresponding OneCLI agent exists (best-effort, non-blocking)
  ensureOneCLIAgent(jid, group);

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  const replyThreadId = missedMessages[missedMessages.length - 1].thread_id;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  // FED-9: per-turn state for outbound-mismatch detection (recap leak / silent
  // deadlock). processGroupMessages only runs when there are missed user
  // messages, so isUserFacing is always true on this path. Scheduled-task
  // turns use a different runAgent call (task-scheduler.ts) and skip the hook.
  const turnState = beginTurn(chatJid, {
    groupName: group.name,
    isUserFacing: true,
  });
  let rawAccumulated = '';

  try {
    const output = await runAgent(group, prompt, chatJid, async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        rawAccumulated += raw;
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
        if (text) {
          // FED-9 Class A: a prior outbound (MCP send_message etc.) already
          // ran this turn — this trailing plain text is a recap leak.
          checkClassA(turnState, text);
          await sendText(channel, chatJid, text, replyThreadId);
          turnState.outboundCount++;
          outputSentToUser = true;
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success') {
        queue.notifyIdle(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    });

    await channel.setTyping?.(chatJid, false);
    if (idleTimer) clearTimeout(idleTimer);

    // FED-9 Class B: user-facing turn that produced no outbound. Skip on error
    // — error path already logs separately and would create noisy duplicates.
    checkClassB(turnState, rawAccumulated, {
      hadError: hadError || output === 'error',
    });

    if (output === 'error' || hadError) {
      // If we already sent output to the user, don't roll back the cursor —
      // the user got their response and re-processing would send duplicates.
      if (outputSentToUser) {
        logger.warn(
          { group: group.name },
          'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
        );
        return true;
      }
      // Roll back cursor so retries can re-process these messages
      lastAgentTimestamp[chatJid] = previousCursor;
      saveState();
      logger.warn(
        { group: group.name },
        'Agent error, rolled back message cursor for retry',
      );
      return false;
    }

    return true;
  } finally {
    endTurn(chatJid);
  }
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      // Detect stale/corrupt session — clear it so the next retry starts fresh.
      // The session .jsonl can go missing after a crash mid-write, manual
      // deletion, or disk-full. The existing backoff in group-queue.ts
      // handles the retry; we just need to remove the broken session ID.
      const isStaleSession =
        sessionId &&
        output.error &&
        /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
          output.error,
        );

      if (isStaleSession) {
        logger.warn(
          { group: group.name, staleSessionId: sessionId, error: output.error },
          'Stale session detected — clearing for next retry',
        );
        delete sessions[group.folder];
        deleteSession(group.folder);
      }

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverCursor(chatJid),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  if (PROXY_BIND_HOST) {
    // Apple Container only attaches the host bridge (with PROXY_BIND_HOST)
    // while a container is running. Pin a long-lived keepalive container
    // first, then wait for the address to be bindable.
    ensureNetworkKeepalive();
    await waitForHostAddress(PROXY_BIND_HOST);
    await startCredentialProxy(CREDENTIAL_PROXY_PORT, PROXY_BIND_HOST);
  }
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Ensure OneCLI agents exist for all registered groups.
  // Recovers from missed creates (e.g. OneCLI was down at registration time).
  for (const [jid, group] of Object.entries(registeredGroups)) {
    ensureOneCLIAgent(jid, group);
  }

  restoreRemoteControl();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      const threadId = getLastIncomingThreadId(jid);
      if (text) await sendText(channel, jid, text, threadId);
    },
  });
  startIpcWatcher({
    sendMessage: async (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      const threadId = getLastIncomingThreadId(jid);
      await sendText(channel, jid, text, threadId);
      // FED-9: record outbound for the active turn so Class A leak detection
      // and Class B silent-finish detection see this delivery.
      recordOutbound(jid);
    },
    setReaction: async (jid, messageId, emoji) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (!channel.setReaction) {
        throw new Error('reactions not supported in this channel');
      }
      let resolvedId = messageId;
      if (!resolvedId) {
        resolvedId = getLastUserMessageId(jid);
        if (!resolvedId) {
          throw new Error('no recent user message to react to');
        }
      }
      await channel.setReaction(jid, resolvedId, emoji);
      return resolvedId;
    },
    autoClearEyeReaction: async (jid) => {
      const channel = findChannel(channels, jid);
      const cleared = await autoClearEyeIfSet(
        channel,
        getLastUserMessageId,
        jid,
      );
      if (cleared) {
        logger.info({ jid }, 'Auto-cleared 👀 reaction on turn end');
      }
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
    getMessage: (messageId, jid) => getMessageById(messageId, jid),
    searchMessages: (params) => searchMessages(params),
    getMessagesAroundTimestamp: (chatJid, timestamp, messageId, n) =>
      getMessagesAroundTimestamp(chatJid, timestamp, messageId, n),
    getLastIncomingThreadId: (jid) => getLastIncomingThreadId(jid),
    sendDocument: async (jid, hostPath, caption, filename, threadId) => {
      const channel = findChannel(channels, jid);
      if (!channel || !channel.sendDocument) {
        return { ok: false, error: 'send_file not supported on this channel' };
      }
      const result = await channel.sendDocument(
        jid,
        hostPath,
        caption,
        threadId,
        filename,
      );
      // FED-9: count successful document delivery against the active turn.
      if (result.ok) recordOutbound(jid);
      return result;
    },
    recordOutgoingDocument: (jid, messageId, args) => {
      recordOutgoing(jid, messageId, {
        content: args.caption
          ? `[Document] ${args.caption} (${args.tracePath})`
          : `[Document] (${args.tracePath})`,
        messageType: 'document',
        filePath: args.tracePath,
      });
    },
    generateImage: async (jid, prompt, presets, caption, threadId) => {
      const channel = findChannel(channels, jid);
      if (!channel) return { ok: false, error: 'no channel for jid' };
      const folder = registeredGroups[jid]?.folder;
      if (!folder) return { ok: false, error: 'group not registered' };
      const result = await generateAndDeliverImage(
        channel,
        jid,
        folder,
        prompt,
        presets,
        caption,
        threadId,
      );
      // FED-9: count successful image delivery against the active turn.
      if (result.ok) recordOutbound(jid);
      return result;
    },
    editImage: async (
      jid,
      sourceAbsPath,
      sourceMessageId,
      prompt,
      presets,
      caption,
      threadId,
    ) => {
      const channel = findChannel(channels, jid);
      if (!channel) return { ok: false, error: 'no channel for jid' };
      const folder = registeredGroups[jid]?.folder;
      if (!folder) return { ok: false, error: 'group not registered' };
      const result = await editAndDeliverImage(
        channel,
        jid,
        folder,
        sourceAbsPath,
        sourceMessageId,
        prompt,
        presets,
        caption,
        threadId,
      );
      // FED-9: count successful image edit delivery against the active turn.
      if (result.ok) recordOutbound(jid);
      return result;
    },
    sendImage: async (jid, hostPath, caption, threadId) => {
      const channel = findChannel(channels, jid);
      if (!channel) return { ok: false, error: 'no channel for jid' };
      const folder = registeredGroups[jid]?.folder;
      if (!folder) return { ok: false, error: 'group not registered' };
      const result = await sendImageFromPath(
        channel,
        jid,
        folder,
        hostPath,
        caption,
        threadId,
      );
      // FED-9: count successful image delivery against the active turn.
      if (result.ok) recordOutbound(jid);
      return result;
    },
    sendVoice: async (jid, text, directive, threadId) => {
      const channel = findChannel(channels, jid);
      if (!channel) return { ok: false, error: 'no channel for jid' };
      const result = await synthesizeAndSendVoice(
        channel,
        jid,
        text,
        directive,
        threadId,
      );
      // FED-9: count successful voice delivery against the active turn.
      if (result.ok) recordOutbound(jid);
      return result;
    },
    forwardMessage: async ({
      toJid,
      fromJid,
      messageId,
      mode,
      captionOverride,
      threadId,
      source,
    }) => {
      const targetChannel = findChannel(channels, toJid);
      if (!targetChannel || !targetChannel.forwardMessage) {
        return { ok: false, error: 'channel does not support forward' };
      }
      const sourceChannel = findChannel(channels, fromJid);
      if (!sourceChannel || sourceChannel.name !== targetChannel.name) {
        return {
          ok: false,
          error: 'cross-platform forward not supported in MVP',
        };
      }
      const result = await targetChannel.forwardMessage({
        toJid,
        fromJid,
        messageId,
        mode,
        captionOverride,
        threadId,
      });
      if (!result.ok) return result;
      const persistedType: 'text' | 'photo' | 'document' | 'voice' | 'video' =
        source.type === 'photo' ||
        source.type === 'document' ||
        source.type === 'voice' ||
        source.type === 'video'
          ? source.type
          : 'text';
      const persistedContent =
        mode === 'copy' && captionOverride !== undefined
          ? captionOverride
          : (source.text ?? '');
      recordOutgoing(toJid, result.message_id, {
        content: persistedContent,
        messageType: persistedType,
        filePath: source.file_path,
      });
      // FED-9: count successful forward delivery against the active turn.
      recordOutbound(toJid);
      return result;
    },
  });
  startSessionCleanup();
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
