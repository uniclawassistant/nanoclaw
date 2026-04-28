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
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  deleteSession,
  getAllTasks,
  getLastBotMessageTimestamp,
  getLastUserMessageId,
  getMessageById,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
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
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  detectOrphanImageTag,
  editImage,
  extractImageDirective,
  generateImage,
} from './image-gen.js';
import { extractTtsDirective, synthesize } from './tts.js';
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

function isPathWithinGroup(absPath: string, groupFolder: string): boolean {
  const groupRoot = path.resolve(GROUPS_DIR, groupFolder);
  const resolved = path.resolve(absPath);
  return resolved === groupRoot || resolved.startsWith(groupRoot + path.sep);
}

// Per-group consecutive moderation-block counter. Reset on any successful
// image generation, incremented on each moderation_block reject. Used to
// nudge the agent off a bad rewrite loop after 3+ in a row. In-memory only —
// resets on restart, which is fine: the whole point is in-session back-off.
const moderationBlocksByGroup = new Map<string, number>();
const MODERATION_LOOP_THRESHOLD = 3;

/**
 * Push a host-authored message into a chat when the image pipeline fails in
 * a way the agent should react to (moderation / bad user params). Written
 * with sender='host', is_from_me=1, is_bot_message=0 so that:
 *   - getMessagesSince INCLUDES it in the next prompt to the agent (agent sees it)
 *   - getLastUserMessageId EXCLUDES it (react tool won't land on it by accident)
 *   - recordOutgoing's message store is NOT touched (this isn't an agent message)
 * The stored content is ALWAYS the short signal — never the original prompt
 * that got rejected, so we don't forward potentially-unsafe content to chat
 * or DB.
 */
async function sendImageGenFailureSignal(
  channel: Channel,
  jid: string,
  threadId: string | undefined,
  groupFolder: string | undefined,
  outcome: Extract<Awaited<ReturnType<typeof generateImage>>, { ok: false }>,
  isEdit: boolean,
): Promise<void> {
  // For generate, transient (5xx/429/network) is pure noise — the user
  // hasn't seen an artifact yet, agent can retry silently. For edit, the
  // user ALREADY has a preview and expects a new one — silent drop leaves
  // them staring at nothing. Signal on edit-transient only.
  if (outcome.reason === 'transient' && !isEdit) return;

  let body: string;
  if (outcome.reason === 'moderation') {
    body =
      '[host] OpenAI declined image generation (moderation). Rephrase the prompt and try again.';
  } else if (outcome.reason === 'source_missing') {
    // Agent-side pre-flight failure for image-edit: path is wrong / file
    // got rotated / tag parsed weirdly and the path landed malformed.
    // Nudge the agent toward get_message, which returns the canonical
    // generation.original_png_path for any preview it has sent.
    const detail = outcome.message ?? 'Source file not found';
    body = `[host] Image edit failed: ${detail}. Call get_message on the preview you want to edit to get the correct generation.original_png_path, or verify the file exists under attachments/.`;
  } else if (outcome.reason === 'transient') {
    // Only reachable for isEdit === true (gated above). Network blip or
    // timeout on the edit call — source file is fine, agent should retry.
    // If it fails again, smaller size/quality/format will cut compute
    // time and fall under our clamp.
    body =
      '[host] Image edit timed out or network blipped. The source file is intact — retry the same tag. If it fails again, drop size/quality (high + large + png is slow and can exceed our 10-min ceiling).';
  } else {
    const codeHint = outcome.code ? ` reason: ${outcome.code}` : '';
    body = `[host] OpenAI declined image generation (${codeHint.trim() || 'user error'}). Adjust the request and try again.`;
  }

  if (groupFolder && outcome.reason === 'moderation') {
    const prev = moderationBlocksByGroup.get(groupFolder) ?? 0;
    const next = prev + 1;
    moderationBlocksByGroup.set(groupFolder, next);
    if (next >= MODERATION_LOOP_THRESHOLD) {
      body += ' Stop retrying with rewrites — switch topic or ask the user.';
    }
  }

  try {
    const msgId = await channel.sendMessage(jid, body, threadId);
    if (msgId) {
      // Store with sender='host', is_from_me=1 (not a user input) so
      // getLastUserMessageId skips it, is_bot_message=0 so getMessagesSince
      // feeds it into the agent's next prompt. See the doc comment above
      // for why this flag combination.
      storeMessage({
        id: msgId,
        chat_jid: jid,
        sender: 'host',
        sender_name: 'host',
        content: body,
        timestamp: new Date().toISOString(),
        is_from_me: true,
        is_bot_message: false,
      });
    }
  } catch (err) {
    logger.warn(
      { err, jid, reason: outcome.reason, code: outcome.code },
      'Failed to deliver image-gen failure signal',
    );
  }
}

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

export async function sendWithTts(
  channel: Channel,
  jid: string,
  text: string,
  threadId?: string,
  groupFolder?: string,
): Promise<void> {
  if (groupFolder) {
    const imgDirective = extractImageDirective(text);
    if (!imgDirective) {
      // No valid directive matched. If the text still contains an opener
      // (`[[image:`, `[[image-edit:`, `[[image-file:`) without a matching
      // `]]`, the agent dropped the second closing bracket — silent failure
      // mode where the literal tag ships to chat as text. Emit a [host]
      // signal so the agent gets corrective feedback on the next turn.
      const orphan = detectOrphanImageTag(text);
      if (orphan) {
        const body = `[host] Image tag opener "${orphan}" detected with no matching "]]" closer. Tag was sent as literal text, image NOT generated. Use exactly two closing brackets ("]]" not "]") — single bracket is a silent failure: parser ignores it, agent does not learn unless someone notices.`;
        void (async () => {
          try {
            const msgId = await channel.sendMessage(jid, body, threadId);
            if (msgId) {
              storeMessage({
                id: msgId,
                chat_jid: jid,
                sender: 'host',
                sender_name: 'host',
                content: body,
                timestamp: new Date().toISOString(),
                is_from_me: true,
                is_bot_message: false,
              });
            }
          } catch (err) {
            logger.warn(
              { err, jid, orphan },
              'Failed to deliver orphan-tag warning',
            );
          }
        })();
      }
    }
    if (imgDirective) {
      const attachmentsDir = path.join(GROUPS_DIR, groupFolder, 'attachments');
      const groupRootAbs = path.resolve(GROUPS_DIR, groupFolder);

      if (imgDirective.type === 'file' && imgDirective.sourcePath) {
        const sourceFull = path.resolve(groupRootAbs, imgDirective.sourcePath);
        if (!isPathWithinGroup(sourceFull, groupFolder)) {
          logger.warn(
            { jid, sourcePath: imgDirective.sourcePath },
            'image-file path escapes group folder, refusing',
          );
        } else {
          const relSource = imgDirective.sourcePath;
          // Fire-and-forget document delivery — same backpressure rationale as
          // the photo branch below.
          void (async () => {
            try {
              if (channel.sendDocument) {
                const result = await channel.sendDocument(
                  jid,
                  sourceFull,
                  undefined,
                  threadId,
                );
                if (result.ok) {
                  recordOutgoing(jid, result.message_id, {
                    content: `[Document] (${relSource})`,
                    messageType: 'document',
                    filePath: relSource,
                  });
                }
              }
            } catch (err) {
              logger.error(
                { err, jid, sourceFull },
                'Async image-file delivery failed',
              );
            }
          })();
        }
      } else {
        // Fire-and-forget: generation + delivery run in the background so the
        // agent loop is not blocked by OpenAI latency or Telegram retries (can
        // add up to several minutes in the worst case). Text ships immediately
        // through the TTS branch below; the photo lands when it lands.
        const genPrompt = imgDirective.prompt;
        const presets = imgDirective.presets;
        void (async () => {
          try {
            let outcome: Awaited<ReturnType<typeof generateImage>> = null;
            if (imgDirective.type === 'generate') {
              outcome = await generateImage(
                imgDirective.prompt,
                attachmentsDir,
                presets,
              );
            } else if (
              imgDirective.type === 'edit' &&
              imgDirective.sourcePath
            ) {
              const sourceFull = path.join(
                GROUPS_DIR,
                groupFolder,
                imgDirective.sourcePath,
              );
              outcome = await editImage(
                sourceFull,
                imgDirective.prompt,
                attachmentsDir,
                presets,
              );
            }
            if (outcome && outcome.ok === false) {
              await sendImageGenFailureSignal(
                channel,
                jid,
                threadId,
                groupFolder,
                outcome,
                imgDirective.type === 'edit',
              );
              return;
            }
            if (outcome && outcome.ok === true) {
              // Any successful generation clears the moderation-loop counter.
              moderationBlocksByGroup.delete(groupFolder);
              const result = outcome;
              const relOriginal = path.relative(
                groupRootAbs,
                result.originalPath,
              );
              const relPreview = path.relative(
                groupRootAbs,
                result.previewPath,
              );
              // Telegram's bot-API photo endpoint rejects files >10MB with
              // PHOTO_INVALID_DIMENSIONS. For oversized previews (large hd
              // renders, high-resolution custom sizes) fall back to sending
              // the original PNG as a document — full fidelity, no size cap.
              const previewSize = fs.statSync(result.previewPath).size;
              const PHOTO_SIZE_CAP = 9 * 1024 * 1024;
              if (previewSize > PHOTO_SIZE_CAP && channel.sendDocument) {
                logger.info(
                  { jid, previewSize, relOriginal },
                  'Preview exceeds photo size cap, falling back to document',
                );
                const docResult = await channel.sendDocument(
                  jid,
                  result.originalPath,
                  undefined,
                  threadId,
                );
                if (docResult.ok) {
                  recordOutgoing(jid, docResult.message_id, {
                    content: `[Document] (${relOriginal})`,
                    messageType: 'document',
                    filePath: relOriginal,
                    generation: {
                      prompt: genPrompt,
                      original_png_path: relOriginal,
                    },
                  });
                }
              } else if (channel.sendPhoto) {
                const msgId = await channel.sendPhoto(
                  jid,
                  result.previewPath,
                  undefined,
                  threadId,
                );
                recordOutgoing(jid, msgId, {
                  content: `[Photo] (${relPreview})`,
                  messageType: 'photo',
                  filePath: relPreview,
                  generation: {
                    prompt: genPrompt,
                    original_png_path: relOriginal,
                  },
                });
              }
            }
          } catch (err) {
            logger.error(
              { err, jid, type: imgDirective.type },
              'Async image delivery failed',
            );
          }
        })();
      }

      text = imgDirective.cleanText;
      if (!text) return;
    }
  }

  const directive = extractTtsDirective(text);
  if (directive && channel.sendVoice) {
    const audio = await synthesize(directive.ttsText, directive.directive);
    if (audio) {
      const msgId = await channel.sendVoice(jid, audio, threadId);
      recordOutgoing(jid, msgId, {
        content: `[Voice] ${directive.ttsText}`,
        messageType: 'voice',
      });
    }
    if (directive.cleanText) {
      const msgId = await channel.sendMessage(
        jid,
        directive.cleanText,
        threadId,
      );
      recordOutgoing(jid, msgId, {
        content: directive.cleanText,
        messageType: 'text',
      });
    }
  } else {
    const msgId = await channel.sendMessage(jid, text, threadId);
    recordOutgoing(jid, msgId, { content: text, messageType: 'text' });
  }
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

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
      if (text) {
        await sendWithTts(channel, chatJid, text, replyThreadId, group.folder);
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
      // Resolve folder from registered groups so [[image:...]] / [[image-edit:...]]
      // tags emitted by scheduled tasks hit the image-gen pipeline instead of
      // being sent as literal text. Mirror the IPC path below.
      const folder = registeredGroups[jid]?.folder;
      if (text) await sendWithTts(channel, jid, text, undefined, folder);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      // Same as the scheduler path: resolve folder so image tags emitted via
      // mcp__nanoclaw__send_message (and from any intermediate, non-final
      // assistant block) are processed instead of leaking as literal text.
      const folder = registeredGroups[jid]?.folder;
      return sendWithTts(channel, jid, text, undefined, folder);
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
    sendDocument: async (jid, hostPath, caption, filename) => {
      const channel = findChannel(channels, jid);
      if (!channel || !channel.sendDocument) {
        return { ok: false, error: 'send_file not supported on this channel' };
      }
      return channel.sendDocument(jid, hostPath, caption, undefined, filename);
    },
    recordOutgoingDocument: (jid, messageId, args) => {
      const display = args.groupRelative ?? args.filename;
      recordOutgoing(jid, messageId, {
        content: args.caption
          ? `[Document] ${args.caption} (${display})`
          : `[Document] (${display})`,
        messageType: 'document',
        filePath: args.groupRelative ?? undefined,
      });
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
