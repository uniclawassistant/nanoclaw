import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, GROUPS_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from './container-runner.js';
import {
  createTask,
  deleteTask,
  getTaskById,
  MessageRecord,
  SearchMessagesParams,
  SearchMessagesResult,
  updateTask,
} from './db.js';
import { resolveContainerPathToHost } from './document-paths.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  setReaction?: (
    jid: string,
    messageId: string | null,
    emoji: string | null,
  ) => Promise<string>;
  autoClearEyeReaction?: (jid: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: () => void;
  getMessage: (messageId: string, jid: string) => MessageRecord | null;
  searchMessages?: (params: SearchMessagesParams) => SearchMessagesResult;
  getMessagesAroundTimestamp?: (
    chatJid: string,
    timestamp: string,
    messageId: string,
    n: number,
  ) => Array<{
    message_id: string;
    timestamp: string;
    sender: string;
    direction: 'in' | 'out';
    snippet: string;
  }>;
  // Resolves the topic the user most recently wrote in for this chat so
  // outbound IPC paths can reply into the same topic instead of General.
  // Returns undefined for plain chats and DMs.
  getLastIncomingThreadId?: (jid: string) => string | undefined;
  // Sends a local file as a channel-native document. Resolves to the
  // channel-native message_id on success, or an error string on failure.
  sendDocument?: (
    jid: string,
    hostPath: string,
    caption: string | undefined,
    filename: string | undefined,
    threadId: string | undefined,
  ) => Promise<{ ok: true; message_id: string } | { ok: false; error: string }>;
  // Persists an outgoing document into the message store so get_message
  // can recall it. tracePath is a portable container-notation path
  // ("note.md" for group files, "/workspace/extra/<mount>/<sub>" for
  // extra-mount sources) — stored as file_path so the agent can re-send
  // or reference the original via get_message.
  recordOutgoingDocument?: (
    jid: string,
    messageId: string,
    args: { caption?: string; tracePath: string; filename: string },
  ) => void;
  // Generates an image and ships it to chat. The caller already authorized
  // the source group → chatJid mapping; this only runs the API call and
  // delivery. tracePath in the success response is the group-relative path
  // of the delivered file.
  generateImage?: (
    jid: string,
    prompt: string,
    presets: string[] | undefined,
    caption: string | undefined,
    threadId: string | undefined,
  ) => Promise<
    | {
        ok: true;
        message_id: string;
        file_path: string;
        message_type: 'photo' | 'document';
      }
    | { ok: false; error: string }
  >;
  // Edits an existing image (sourceAbsPath already resolved + validated by
  // ipc-watcher) and ships the result. Same contract as generateImage.
  // sourceMessageId is the channel-native id of the original message — kept
  // so the delivered result can record `generation.source_message_id` and
  // the edit chain stays traversable from get_message alone.
  editImage?: (
    jid: string,
    sourceAbsPath: string,
    sourceMessageId: string,
    prompt: string,
    presets: string[] | undefined,
    caption: string | undefined,
    threadId: string | undefined,
  ) => Promise<
    | {
        ok: true;
        message_id: string;
        file_path: string;
        message_type: 'photo' | 'document';
      }
    | { ok: false; error: string }
  >;
  // Ships an existing image file as a compressed photo with optional caption.
  sendImage?: (
    jid: string,
    hostPath: string,
    caption: string | undefined,
    threadId: string | undefined,
  ) => Promise<
    | {
        ok: true;
        message_id: string;
        file_path: string;
        message_type: 'photo' | 'document';
      }
    | { ok: false; error: string }
  >;
  // Synthesizes TTS audio and sends as a voice message.
  sendVoice?: (
    jid: string,
    text: string,
    directive: {
      voice?: string;
      director?: string;
      profile?: string;
      scene?: string;
    },
    threadId: string | undefined,
  ) => Promise<{ ok: true; message_id: string } | { ok: false; error: string }>;
}

const RESPONSE_TTL_MS = 60_000;

function writeIpcResponse(
  responsesDir: string,
  requestId: string,
  payload: {
    success: boolean;
    error?: string;
    message_id?: string;
    data?: unknown;
  },
): void {
  fs.mkdirSync(responsesDir, { recursive: true });
  const responsePath = path.join(responsesDir, `${requestId}.json`);
  const tmpPath = `${responsePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify({ requestId, ...payload }));
  fs.renameSync(tmpPath, responsePath);
}

function sweepOrphanResponses(ipcBaseDir: string): void {
  let groupFolders: string[];
  try {
    groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
      const stat = fs.statSync(path.join(ipcBaseDir, f));
      return stat.isDirectory() && f !== 'errors';
    });
  } catch {
    return;
  }

  const cutoff = Date.now() - RESPONSE_TTL_MS;
  for (const folder of groupFolders) {
    const responsesDir = path.join(ipcBaseDir, folder, 'responses');
    if (!fs.existsSync(responsesDir)) continue;
    try {
      for (const file of fs.readdirSync(responsesDir)) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(responsesDir, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs < cutoff) {
            fs.unlinkSync(filePath);
          }
        } catch {
          // File already removed by container, ignore
        }
      }
    } catch (err) {
      logger.debug({ folder, err }, 'Error sweeping orphan IPC responses');
    }
  }
}

interface SearchMessagesIpc {
  type: 'search_messages';
  requestId: string;
  query: string;
  is_regex?: boolean;
  jid?: string | string[];
  since?: string;
  until?: string;
  sender?: string;
  message_type?: string;
  include_generation?: boolean;
  context?: number;
  limit?: number;
}

/**
 * Authorize the source group's requested jid set for search_messages, then
 * dispatch into deps.searchMessages and enrich each hit with surrounding
 * context messages. Mirrors the get_message authorization model: main can
 * search any registered jid; non-main is locked to its own jid.
 */
async function processSearchMessagesIpc(
  data: SearchMessagesIpc,
  sourceGroup: string,
  isMain: boolean,
  registeredGroups: Record<string, RegisteredGroup>,
  responsesDir: string,
  deps: IpcDeps,
): Promise<void> {
  if (!deps.searchMessages) {
    writeIpcResponse(responsesDir, data.requestId, {
      success: false,
      error: 'search_messages not supported on this host',
    });
    return;
  }

  const ownJids = Object.entries(registeredGroups)
    .filter(([, g]) => g.folder === sourceGroup)
    .map(([jid]) => jid);

  const requestedJids: string[] = (() => {
    if (Array.isArray(data.jid)) {
      return data.jid.filter((j) => typeof j === 'string' && j.length > 0);
    }
    if (typeof data.jid === 'string' && data.jid.length > 0) {
      return [data.jid];
    }
    return [];
  })();

  let effectiveJids: string[];
  if (isMain) {
    effectiveJids =
      requestedJids.length > 0 ? requestedJids : Object.keys(registeredGroups);
  } else {
    if (ownJids.length === 0) {
      writeIpcResponse(responsesDir, data.requestId, {
        success: false,
        error: 'unauthorized: caller has no registered chat',
      });
      return;
    }
    if (requestedJids.length === 0) {
      effectiveJids = ownJids;
    } else {
      const ownSet = new Set(ownJids);
      const outOfScope = requestedJids.filter((j) => !ownSet.has(j));
      if (outOfScope.length > 0) {
        logger.warn(
          { sourceGroup, requestedJids, outOfScope },
          'Unauthorized IPC search_messages attempt blocked',
        );
        writeIpcResponse(responsesDir, data.requestId, {
          success: false,
          error: 'unauthorized: cannot search outside own chat',
        });
        return;
      }
      effectiveJids = requestedJids;
    }
  }

  const messageTypes: string[] = [];
  if (typeof data.message_type === 'string' && data.message_type !== 'all') {
    messageTypes.push(data.message_type);
  }

  const limit = Math.max(
    1,
    Math.min(
      typeof data.limit === 'number' && Number.isFinite(data.limit)
        ? Math.floor(data.limit)
        : 20,
      100,
    ),
  );
  const contextN = Math.max(
    0,
    typeof data.context === 'number' && Number.isFinite(data.context)
      ? Math.floor(data.context)
      : 0,
  );

  let result: SearchMessagesResult;
  try {
    result = deps.searchMessages({
      query: data.query,
      isRegex: data.is_regex === true,
      jids: effectiveJids,
      since: typeof data.since === 'string' ? data.since : undefined,
      until: typeof data.until === 'string' ? data.until : undefined,
      sender: typeof data.sender === 'string' ? data.sender : undefined,
      messageTypes,
      includeGeneration: data.include_generation !== false,
      limit,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn({ sourceGroup, err: errMsg }, 'IPC search_messages failed');
    writeIpcResponse(responsesDir, data.requestId, {
      success: false,
      error: errMsg,
    });
    return;
  }

  const enriched = result.hits.map((hit) => {
    if (contextN <= 0 || !deps.getMessagesAroundTimestamp) {
      return hit;
    }
    const context_messages = deps.getMessagesAroundTimestamp(
      hit.chat_jid,
      hit.timestamp,
      hit.message_id,
      contextN,
    );
    return { ...hit, context_messages };
  });

  writeIpcResponse(responsesDir, data.requestId, {
    success: true,
    data: {
      results: enriched,
      total_matches: result.total_matches,
      truncated: result.total_matches > enriched.length,
    },
  });
}

type MediaToolIpc = {
  type: 'generate_image' | 'edit_image' | 'send_image' | 'send_voice';
  chatJid: string;
  requestId: string;
  prompt?: string;
  preset?: string[];
  caption?: string;
  source_message_id?: string;
  sourcePath?: string;
  text?: string;
  voice?: string;
  director?: string;
  profile?: string;
  scene?: string;
};

/**
 * Authorize the source group for the target chatJid, then dispatch the
 * media tool (generate_image / edit_image / send_image / send_voice) to
 * the appropriate dep. Always writes a response file so the container-side
 * MCP tool unblocks. Each handler returns { success, message_id|error,
 * file_path?, message_type? } shaped for the agent.
 */
async function processMediaToolIpc(
  data: MediaToolIpc,
  sourceGroup: string,
  isMain: boolean,
  registeredGroups: Record<string, RegisteredGroup>,
  ipcBaseDir: string,
  deps: IpcDeps,
): Promise<void> {
  const responsesDir = path.join(ipcBaseDir, sourceGroup, 'responses');
  const targetGroup = registeredGroups[data.chatJid];
  const authorized =
    isMain || (targetGroup && targetGroup.folder === sourceGroup);
  if (!authorized) {
    logger.warn(
      { chatJid: data.chatJid, sourceGroup, type: data.type },
      'Unauthorized IPC media-tool attempt blocked',
    );
    writeIpcResponse(responsesDir, data.requestId, {
      success: false,
      error: 'unauthorized',
    });
    return;
  }

  // Image / voice tools are Telegram-only at the moment. On other channels,
  // return ok+skipped so the agent can proceed without surfacing an error.
  if (!data.chatJid.startsWith('tg:')) {
    logger.info(
      { chatJid: data.chatJid, type: data.type },
      'Media tool skipped on non-Telegram channel',
    );
    writeIpcResponse(responsesDir, data.requestId, {
      success: true,
      data: { ok: true, skipped: true, reason: 'channel not supported' },
    });
    return;
  }

  const threadId = deps.getLastIncomingThreadId?.(data.chatJid);

  try {
    if (data.type === 'generate_image') {
      if (!deps.generateImage) {
        writeIpcResponse(responsesDir, data.requestId, {
          success: false,
          error: 'generate_image not supported on this host',
        });
        return;
      }
      if (typeof data.prompt !== 'string' || !data.prompt.trim()) {
        writeIpcResponse(responsesDir, data.requestId, {
          success: false,
          error: 'prompt is required',
        });
        return;
      }
      const result = await deps.generateImage(
        data.chatJid,
        data.prompt,
        data.preset,
        data.caption,
        threadId,
      );
      if (result.ok) {
        writeIpcResponse(responsesDir, data.requestId, {
          success: true,
          message_id: result.message_id,
          data: {
            ok: true,
            message_id: result.message_id,
            file_path: result.file_path,
            message_type: result.message_type,
          },
        });
      } else {
        writeIpcResponse(responsesDir, data.requestId, {
          success: false,
          error: result.error,
        });
      }
      return;
    }

    if (data.type === 'edit_image') {
      if (!deps.editImage) {
        writeIpcResponse(responsesDir, data.requestId, {
          success: false,
          error: 'edit_image not supported on this host',
        });
        return;
      }
      if (typeof data.prompt !== 'string' || !data.prompt.trim()) {
        writeIpcResponse(responsesDir, data.requestId, {
          success: false,
          error: 'prompt is required',
        });
        return;
      }
      if (
        typeof data.source_message_id !== 'string' ||
        !data.source_message_id
      ) {
        writeIpcResponse(responsesDir, data.requestId, {
          success: false,
          error: 'source_message_id is required',
        });
        return;
      }
      const record = deps.getMessage(data.source_message_id, data.chatJid);
      if (!record) {
        writeIpcResponse(responsesDir, data.requestId, {
          success: false,
          error: `source message ${data.source_message_id} not found in this chat`,
        });
        return;
      }
      // Prefer the full-fidelity original (PNG when format=png was used) so
      // the OpenAI edit endpoint gets max detail to work with.
      const sourceTrace =
        record.generation?.original_png_path ?? record.file_path;
      if (!sourceTrace) {
        writeIpcResponse(responsesDir, data.requestId, {
          success: false,
          error: `source message ${data.source_message_id} has no attached image (type=${record.type})`,
        });
        return;
      }
      const resolved = resolveContainerPathToHost(
        sourceTrace,
        sourceGroup,
        GROUPS_DIR,
        targetGroup,
        isMain,
      );
      if (!resolved.ok) {
        writeIpcResponse(responsesDir, data.requestId, {
          success: false,
          error: `source path rejected: ${resolved.error}`,
        });
        return;
      }
      const result = await deps.editImage(
        data.chatJid,
        resolved.hostPath,
        data.source_message_id,
        data.prompt,
        data.preset,
        data.caption,
        threadId,
      );
      if (result.ok) {
        writeIpcResponse(responsesDir, data.requestId, {
          success: true,
          message_id: result.message_id,
          data: {
            ok: true,
            message_id: result.message_id,
            file_path: result.file_path,
            message_type: result.message_type,
          },
        });
      } else {
        writeIpcResponse(responsesDir, data.requestId, {
          success: false,
          error: result.error,
        });
      }
      return;
    }

    if (data.type === 'send_image') {
      if (!deps.sendImage) {
        writeIpcResponse(responsesDir, data.requestId, {
          success: false,
          error: 'send_image not supported on this host',
        });
        return;
      }
      if (typeof data.sourcePath !== 'string' || !data.sourcePath) {
        writeIpcResponse(responsesDir, data.requestId, {
          success: false,
          error: 'path is required',
        });
        return;
      }
      const resolved = resolveContainerPathToHost(
        data.sourcePath,
        sourceGroup,
        GROUPS_DIR,
        targetGroup,
        isMain,
      );
      if (!resolved.ok) {
        writeIpcResponse(responsesDir, data.requestId, {
          success: false,
          error: resolved.error,
        });
        return;
      }
      const result = await deps.sendImage(
        data.chatJid,
        resolved.hostPath,
        data.caption,
        threadId,
      );
      if (result.ok) {
        writeIpcResponse(responsesDir, data.requestId, {
          success: true,
          message_id: result.message_id,
          data: {
            ok: true,
            message_id: result.message_id,
            file_path: result.file_path,
            message_type: result.message_type,
          },
        });
      } else {
        writeIpcResponse(responsesDir, data.requestId, {
          success: false,
          error: result.error,
        });
      }
      return;
    }

    if (data.type === 'send_voice') {
      if (!deps.sendVoice) {
        writeIpcResponse(responsesDir, data.requestId, {
          success: false,
          error: 'send_voice not supported on this host',
        });
        return;
      }
      if (typeof data.text !== 'string' || !data.text.trim()) {
        writeIpcResponse(responsesDir, data.requestId, {
          success: false,
          error: 'text is required',
        });
        return;
      }
      const result = await deps.sendVoice(
        data.chatJid,
        data.text,
        {
          voice: data.voice,
          director: data.director,
          profile: data.profile,
          scene: data.scene,
        },
        threadId,
      );
      if (result.ok) {
        writeIpcResponse(responsesDir, data.requestId, {
          success: true,
          message_id: result.message_id,
          data: { ok: true, message_id: result.message_id },
        });
      } else {
        writeIpcResponse(responsesDir, data.requestId, {
          success: false,
          error: result.error,
        });
      }
      return;
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { chatJid: data.chatJid, sourceGroup, type: data.type, err: errMsg },
      'IPC media-tool delivery threw',
    );
    writeIpcResponse(responsesDir, data.requestId, {
      success: false,
      error: errMsg,
    });
  }
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, data.text);
                  logger.info(
                    {
                      chatJid: data.chatJid,
                      sourceGroup,
                      thread: deps.getLastIncomingThreadId?.(data.chatJid),
                    },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              } else if (
                data.type === 'auto_clear_eye' &&
                typeof data.chatJid === 'string'
              ) {
                const targetGroup = registeredGroups[data.chatJid];
                const authorized =
                  isMain || (targetGroup && targetGroup.folder === sourceGroup);
                if (!authorized) {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC auto_clear_eye attempt blocked',
                  );
                } else if (deps.autoClearEyeReaction) {
                  try {
                    await deps.autoClearEyeReaction(data.chatJid);
                  } catch (err) {
                    logger.warn(
                      {
                        chatJid: data.chatJid,
                        sourceGroup,
                        err: err instanceof Error ? err.message : String(err),
                      },
                      'IPC auto_clear_eye failed',
                    );
                  }
                }
              } else if (
                data.type === 'get_message' &&
                typeof data.requestId === 'string' &&
                typeof data.message_id === 'string'
              ) {
                const queryJid =
                  typeof data.chatJid === 'string' && data.chatJid
                    ? data.chatJid
                    : null;
                const responsesDir = path.join(
                  ipcBaseDir,
                  sourceGroup,
                  'responses',
                );
                // Authorization: non-main callers may only read messages from
                // their own chat. Main may query any JID.
                let authorized = false;
                let effectiveJid: string | null = queryJid;
                if (queryJid) {
                  if (isMain) {
                    authorized = true;
                  } else {
                    const targetGroup = registeredGroups[queryJid];
                    authorized =
                      !!targetGroup && targetGroup.folder === sourceGroup;
                  }
                } else {
                  // No jid — default to the caller's own chat
                  const mine = Object.entries(registeredGroups).find(
                    ([, g]) => g.folder === sourceGroup,
                  );
                  if (mine) {
                    effectiveJid = mine[0];
                    authorized = true;
                  }
                }

                if (!authorized || !effectiveJid) {
                  logger.warn(
                    { queryJid, sourceGroup },
                    'Unauthorized IPC get_message attempt blocked',
                  );
                  writeIpcResponse(responsesDir, data.requestId, {
                    success: false,
                    error: 'unauthorized',
                  });
                } else {
                  const record = deps.getMessage(data.message_id, effectiveJid);
                  writeIpcResponse(responsesDir, data.requestId, {
                    success: true,
                    data: record
                      ? record
                      : {
                          found: false,
                          message_id: data.message_id,
                          chat_jid: effectiveJid,
                        },
                  });
                }
              } else if (
                data.type === 'search_messages' &&
                typeof data.requestId === 'string' &&
                typeof data.query === 'string'
              ) {
                const responsesDir = path.join(
                  ipcBaseDir,
                  sourceGroup,
                  'responses',
                );
                await processSearchMessagesIpc(
                  data,
                  sourceGroup,
                  isMain,
                  registeredGroups,
                  responsesDir,
                  deps,
                );
              } else if (
                data.type === 'reaction' &&
                data.chatJid &&
                typeof data.requestId === 'string'
              ) {
                const targetGroup = registeredGroups[data.chatJid];
                const authorized =
                  isMain || (targetGroup && targetGroup.folder === sourceGroup);
                const responsesDir = path.join(
                  ipcBaseDir,
                  sourceGroup,
                  'responses',
                );
                if (!authorized) {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC reaction attempt blocked',
                  );
                  writeIpcResponse(responsesDir, data.requestId, {
                    success: false,
                    error: 'unauthorized',
                  });
                } else if (!deps.setReaction) {
                  writeIpcResponse(responsesDir, data.requestId, {
                    success: false,
                    error: 'reactions not supported in this channel',
                  });
                } else {
                  try {
                    const resolvedMessageId = await deps.setReaction(
                      data.chatJid,
                      typeof data.message_id === 'string'
                        ? data.message_id
                        : null,
                      typeof data.emoji === 'string' ? data.emoji : null,
                    );
                    logger.info(
                      {
                        chatJid: data.chatJid,
                        sourceGroup,
                        emoji: data.emoji,
                        messageId: resolvedMessageId,
                      },
                      'IPC reaction applied',
                    );
                    writeIpcResponse(responsesDir, data.requestId, {
                      success: true,
                      message_id: resolvedMessageId,
                    });
                  } catch (err) {
                    const errMsg =
                      err instanceof Error ? err.message : String(err);
                    logger.warn(
                      { chatJid: data.chatJid, sourceGroup, err: errMsg },
                      'IPC reaction failed',
                    );
                    writeIpcResponse(responsesDir, data.requestId, {
                      success: false,
                      error: errMsg,
                    });
                  }
                }
              } else if (
                data.type === 'document' &&
                typeof data.chatJid === 'string' &&
                typeof data.sourcePath === 'string' &&
                typeof data.requestId === 'string'
              ) {
                const targetGroup = registeredGroups[data.chatJid];
                const authorized =
                  isMain || (targetGroup && targetGroup.folder === sourceGroup);
                const responsesDir = path.join(
                  ipcBaseDir,
                  sourceGroup,
                  'responses',
                );
                if (!authorized) {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC document attempt blocked',
                  );
                  writeIpcResponse(responsesDir, data.requestId, {
                    success: false,
                    error: 'unauthorized',
                  });
                } else if (!deps.sendDocument) {
                  writeIpcResponse(responsesDir, data.requestId, {
                    success: false,
                    error: 'send_file not supported on this channel',
                  });
                } else {
                  const resolved = resolveContainerPathToHost(
                    data.sourcePath,
                    sourceGroup,
                    GROUPS_DIR,
                    targetGroup,
                    isMain,
                  );
                  if (!resolved.ok) {
                    logger.warn(
                      {
                        chatJid: data.chatJid,
                        sourceGroup,
                        sourcePath: data.sourcePath,
                        error: resolved.error,
                      },
                      'IPC document path rejected',
                    );
                    writeIpcResponse(responsesDir, data.requestId, {
                      success: false,
                      error: resolved.error,
                    });
                  } else {
                    const caption =
                      typeof data.caption === 'string'
                        ? data.caption
                        : undefined;
                    const filename =
                      typeof data.filename === 'string' && data.filename
                        ? data.filename
                        : path.basename(resolved.hostPath);
                    const threadId = deps.getLastIncomingThreadId?.(
                      data.chatJid,
                    );
                    try {
                      const result = await deps.sendDocument(
                        data.chatJid,
                        resolved.hostPath,
                        caption,
                        filename,
                        threadId,
                      );
                      if (result.ok) {
                        if (deps.recordOutgoingDocument) {
                          deps.recordOutgoingDocument(
                            data.chatJid,
                            result.message_id,
                            {
                              caption,
                              tracePath: resolved.tracePath,
                              filename,
                            },
                          );
                        }
                        logger.info(
                          {
                            chatJid: data.chatJid,
                            sourceGroup,
                            filename,
                            messageId: result.message_id,
                            thread: threadId,
                          },
                          'IPC document sent',
                        );
                        writeIpcResponse(responsesDir, data.requestId, {
                          success: true,
                          message_id: result.message_id,
                        });
                      } else {
                        logger.warn(
                          {
                            chatJid: data.chatJid,
                            sourceGroup,
                            filename,
                            error: result.error,
                          },
                          'IPC document send failed',
                        );
                        writeIpcResponse(responsesDir, data.requestId, {
                          success: false,
                          error: result.error,
                        });
                      }
                    } catch (err) {
                      const errMsg =
                        err instanceof Error ? err.message : String(err);
                      logger.warn(
                        { chatJid: data.chatJid, sourceGroup, err: errMsg },
                        'IPC document delivery threw',
                      );
                      writeIpcResponse(responsesDir, data.requestId, {
                        success: false,
                        error: errMsg,
                      });
                    }
                  }
                }
              } else if (
                (data.type === 'generate_image' ||
                  data.type === 'edit_image' ||
                  data.type === 'send_image' ||
                  data.type === 'send_voice') &&
                typeof data.chatJid === 'string' &&
                typeof data.requestId === 'string'
              ) {
                await processMediaToolIpc(
                  data,
                  sourceGroup,
                  isMain,
                  registeredGroups,
                  ipcBaseDir,
                  deps,
                );
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    sweepOrphanResponses(ipcBaseDir);
    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    script?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          script: data.script || null,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.script !== undefined) updates.script = data.script || null;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC.
        // Preserve isMain from the existing registration so IPC config
        // updates (e.g. adding additionalMounts) don't strip the flag.
        const existingGroup = registeredGroups[data.jid];
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
          isMain: existingGroup?.isMain,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
