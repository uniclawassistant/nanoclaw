import fs from 'fs';
import https from 'https';
import path from 'path';

import { Api, Bot, InputFile } from 'grammy';
import type { ReactionType } from 'grammy/types';

import { execSync } from 'child_process';

import { ASSISTANT_NAME, DATA_DIR, TRIGGER_PATTERN } from '../config.js';
import { getTasksForGroup } from '../db.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { transcribe } from '../stt.js';
import {
  filterTasksByStatus,
  parseTaskFilter,
  TaskFilter,
  taskStatusEmoji,
} from '../tasks-filter.js';
import { registerChannel, ChannelOpts } from './registry.js';
import largeContextModels from '../large-context-models.json' with { type: 'json' };
import allowedReactions from './telegram-allowed-reactions.json' with { type: 'json' };
import {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
  ScheduledTask,
  type MessageFormat,
} from '../types.js';

const ALLOWED_REACTIONS: ReadonlySet<string> = new Set(allowedReactions);
const REACTION_CACHE_CAP = 5000;

/**
 * Telegram drops a chat action after ~5s, so a turn that runs longer than that
 * (a subagent, a long tool call) looks like silence. Re-send just under the
 * expiry to keep "typing…" continuous for as long as the turn is in flight.
 */
const TYPING_REFRESH_MS = 4000;
/**
 * Safety net: a turn that never reports its end (container killed mid-flight)
 * must not leave the indicator running forever.
 */
const TYPING_MAX_MS = 15 * 60 * 1000;

const LARGE_CONTEXT_MODELS: ReadonlySet<string> = new Set(largeContextModels);

/**
 * True when the model id refers to a 1M-context Claude tier — either an
 * explicit `[1m]` suffix or a bare id that ships with 1M by default (Fable 5+,
 * or Opus 4.7+/Sonnet 4.6 spawned with `[1m]` — Anthropic strips the suffix
 * from response.model, so jsonl and SDK modelUsage only carry the bare id).
 * Display heuristic for /status only — the container-side mirror was removed
 * in FED-35 (agent-runner reports the SDK's contextWindow verbatim).
 */
export function isLargeContextModel(model: string): boolean {
  if (model.includes('[1m]')) return true;
  return LARGE_CONTEXT_MODELS.has(model);
}

/**
 * Map a Claude model id to its context window size in thousands of tokens, for
 * /status display. 1000 for 1M-tier models, otherwise 200K so percentages stay
 * conservative for older / unknown ids.
 */
export function contextWindowK(model: string): number {
  return isLargeContextModel(model) ? 1000 : 200;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatRelativeOffset(diffMs: number): string {
  const sign = diffMs >= 0 ? '~' : '-';
  const absMs = Math.abs(diffMs);
  const min = Math.round(absMs / 60000);
  if (min < 60) return `${sign}${min}m`;
  const hr = Math.round(absMs / 3600000);
  if (hr < 48) return `${sign}${hr}h`;
  const day = Math.round(absMs / 86400000);
  return `${sign}${day}d`;
}

const STOCKHOLM_TS_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Stockholm',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZoneName: 'short',
});

export function formatTaskTimestamp(iso: string | null, now: Date): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = STOCKHOLM_TS_FMT.formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const stamp = `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
  const tz = get('timeZoneName');
  return `${stamp} ${tz} (${formatRelativeOffset(d.getTime() - now.getTime())})`;
}

function decodeCron(expr: string): string | null {
  const trimmed = expr.trim();
  let m;
  if ((m = /^\*\/(\d+) \* \* \* \*$/.exec(trimmed))) {
    return `every ${m[1]} min`;
  }
  if (/^0 \* \* \* \*$/.test(trimmed)) return 'hourly';
  if ((m = /^0 (\d{1,2}) \* \* \*$/.exec(trimmed))) {
    return `daily at ${pad2(parseInt(m[1], 10))}:00`;
  }
  if ((m = /^0 (\d{1,2}) \* \* 1-5$/.exec(trimmed))) {
    return `weekdays at ${pad2(parseInt(m[1], 10))}:00`;
  }
  return null;
}

export function formatTaskSchedule(
  type: ScheduledTask['schedule_type'],
  value: string,
): string {
  if (type === 'cron') {
    const decoded = decodeCron(value);
    return decoded ? `\`${value}\` (${decoded})` : `\`${value}\``;
  }
  if (type === 'interval') {
    const ms = parseInt(value, 10);
    if (!Number.isFinite(ms) || ms <= 0) return value;
    if (ms % 3600000 === 0) return `every ${ms / 3600000}h`;
    if (ms % 60000 === 0) return `every ${ms / 60000}m`;
    if (ms % 1000 === 0) return `every ${ms / 1000}s`;
    return `every ${ms}ms`;
  }
  return value;
}

function escapeMarkdownV1(s: string): string {
  return s.replace(/([_*`[\]])/g, '\\$1');
}

function truncatePromptForList(s: string, max: number): string {
  const collapsed = s.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 1) + '…';
}

export function shortenTaskId(id: string): string {
  const idx = id.lastIndexOf('-');
  if (idx === -1) return id.slice(-6);
  const suffix = id.slice(idx + 1);
  if (suffix.length === 0) return id.slice(-6);
  return suffix;
}

export function formatTasksList(
  tasks: ScheduledTask[],
  now: Date,
  filter: TaskFilter = 'all',
): string {
  if (tasks.length === 0) {
    if (filter === 'active') return 'No active scheduled tasks for this group.';
    if (filter === 'paused') return 'No paused scheduled tasks for this group.';
    return 'No scheduled tasks for this group.';
  }
  return tasks
    .map((t) => {
      const idShort = shortenTaskId(t.id);
      const schedule = formatTaskSchedule(t.schedule_type, t.schedule_value);
      const next = formatTaskTimestamp(t.next_run, now);
      const last = formatTaskTimestamp(t.last_run, now);
      const prompt = escapeMarkdownV1(truncatePromptForList(t.prompt, 200));
      const emoji = taskStatusEmoji(t.status);
      return [
        `• ${emoji} #${idShort} — ${schedule} (${t.schedule_type}) — ${t.status}`,
        `  Next: ${next} · Last: ${last}`,
        `  Prompt: «${prompt}»`,
      ].join('\n');
    })
    .join('\n\n');
}

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  resetGroupSession?: (folder: string, mode: 'new' | 'restart') => void;
  stopGroupRun?: (folder: string) => 'interrupted' | 'idle' | 'none';
}

// Marker file used to notify a chat after /restart kickstart completes.
const RESTART_NOTIFY_FILE = path.join(DATA_DIR, 'restart-notify.json');

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
function richMessagesEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.TELEGRAM_RICH_MESSAGES ?? '');
}

type RichMessageApi = Pick<Api, 'sendMessage'> & {
  sendRichMessage?: (
    chatId: string | number,
    payload: { markdown: string },
    options?: { message_thread_id?: number },
  ) => Promise<{ message_id: number }>;
};

async function sendTelegramMessage(
  api: RichMessageApi,
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
  format: MessageFormat = 'markdown',
): Promise<{ message_id: number } | undefined> {
  if (format === 'rich' && richMessagesEnabled() && api.sendRichMessage) {
    try {
      return await api.sendRichMessage(chatId, { markdown: text }, options);
    } catch (err) {
      logger.debug(
        { err },
        'RichMessage send failed, falling back to Markdown',
      );
    }
  }

  try {
    return await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    return await api.sendMessage(chatId, text, options);
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private lastReactions = new Map<string, string | null>();
  private typingTimers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  /**
   * Download a Telegram file to the group's attachments directory.
   * Returns both the container-relative path (used by the agent — e.g.
   * /workspace/group/attachments/photo_123.jpg) and the host-side absolute
   * path (used by host-side post-processing like STT). Null on failure.
   */
  private async downloadFile(
    fileId: string,
    groupFolder: string,
    filename: string,
  ): Promise<{ containerPath: string; localPath: string } | null> {
    if (!this.bot) return null;

    try {
      const file = await this.bot.api.getFile(fileId);
      if (!file.file_path) {
        logger.warn({ fileId }, 'Telegram getFile returned no file_path');
        return null;
      }

      const groupDir = resolveGroupFolderPath(groupFolder);
      const attachDir = path.join(groupDir, 'attachments');
      fs.mkdirSync(attachDir, { recursive: true });

      // Sanitize filename and add extension from Telegram's file_path if missing
      const tgExt = path.extname(file.file_path);
      const localExt = path.extname(filename);
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const finalName = localExt ? safeName : `${safeName}${tgExt}`;
      const destPath = path.join(attachDir, finalName);

      const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
      const resp = await fetch(fileUrl);
      if (!resp.ok) {
        logger.warn(
          { fileId, status: resp.status },
          'Telegram file download failed',
        );
        return null;
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(destPath, buffer);

      logger.info({ fileId, dest: destPath }, 'Telegram file downloaded');
      return {
        containerPath: `/workspace/group/attachments/${finalName}`,
        localPath: destPath,
      };
    } catch (err) {
      logger.error({ fileId, err }, 'Failed to download Telegram file');
      return null;
    }
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Command to reset session — full reset, equivalent to mode='new' on
    // the resetGroupSession host helper. The shared helper covers container
    // stop, SDK JSONL delete, in-memory sessions clear, and DB session row
    // delete — see src/index.ts:resetGroupSession.
    this.bot.command('new', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const groups = this.opts.registeredGroups();
      const group = groups[chatJid];
      if (!group) {
        ctx.reply('Chat not registered.');
        return;
      }

      this.opts.resetGroupSession?.(group.folder, 'new');
      logger.info({ group: group.name }, '/new: session reset');
      ctx.reply('Session reset. Next message starts fresh.');
    });

    // Command to interrupt the in-flight run WITHOUT resetting the session
    // (FED-38). Unlike /new, the conversation/context is preserved — the agent
    // is aborted mid-turn and then re-oriented by a host-injected re-sync
    // message. The heavy lifting (query.interrupt() + re-sync) is host-side;
    // here we only resolve the group and relay the outcome.
    this.bot.command('stop', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const groups = this.opts.registeredGroups();
      const group = groups[chatJid];
      if (!group) {
        ctx.reply('Chat not registered.');
        return;
      }

      const result = this.opts.stopGroupRun?.(group.folder) ?? 'none';
      logger.info({ group: group.name, result }, '/stop: interrupt requested');
      if (result === 'interrupted') {
        ctx.reply('⏹ Interrupting — session kept.');
      } else {
        ctx.reply('Nothing to interrupt right now.');
      }
    });

    // Command to restart NanoClaw (kickstart via launchd)
    this.bot.command('restart', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const groups = this.opts.registeredGroups();
      const group = groups[chatJid];
      if (!group) {
        ctx.reply('Chat not registered.');
        return;
      }

      await ctx.reply(`${ASSISTANT_NAME} restarting…`);
      logger.warn(
        { group: group.name, triggeredBy: ctx.from?.id },
        '/restart: kickstart requested',
      );

      // Drop a marker so the next startup can ping the same chat when it's back.
      try {
        fs.writeFileSync(
          RESTART_NOTIFY_FILE,
          JSON.stringify({
            chatId: ctx.chat.id,
            threadId: ctx.message?.message_thread_id ?? null,
            requestedAt: new Date().toISOString(),
          }),
        );
      } catch (err) {
        logger.warn({ err }, '/restart: failed to write notify marker');
      }

      // Defer kickstart so the reply is flushed before launchd kills us.
      setTimeout(() => {
        try {
          const uid = process.getuid ? process.getuid() : 0;
          const label =
            process.env.NANOCLAW_LAUNCHD_LABEL || 'com.nanoclaw-unic';
          execSync(`launchctl kickstart -k gui/${uid}/${label}`);
        } catch (err) {
          logger.error({ err }, '/restart: kickstart failed');
        }
      }, 500);
    });

    // Command to show session status
    this.bot.command('status', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const groups = this.opts.registeredGroups();
      const group = groups[chatJid];
      if (!group) {
        ctx.reply('Chat not registered.');
        return;
      }

      const projectDir = path.join(
        DATA_DIR,
        'sessions',
        group.folder,
        '.claude',
        'projects',
        '-workspace-group',
      );
      if (!fs.existsSync(projectDir)) {
        ctx.reply('No active session.');
        return;
      }

      const jsonlFiles = fs
        .readdirSync(projectDir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => {
          const full = path.join(projectDir, f);
          return { full, mtime: fs.statSync(full).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
      if (jsonlFiles.length === 0) {
        ctx.reply('No active session.');
        return;
      }

      // Read last assistant entry with usage from the most recent JSONL
      const filePath = jsonlFiles[0].full;
      const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');

      let model = '?';
      let contextTokens = 0;
      let cacheRead = 0;
      let cacheCreation = 0;

      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const obj = JSON.parse(lines[i]);
          if (obj.type === 'assistant' && obj.message?.usage) {
            const u = obj.message.usage;
            model = obj.message.model || '?';
            cacheRead = u.cache_read_input_tokens || 0;
            cacheCreation = u.cache_creation_input_tokens || 0;
            contextTokens = (u.input_tokens || 0) + cacheRead + cacheCreation;
            break;
          }
        } catch {
          // skip malformed lines
        }
      }

      const contextK = Math.round(contextTokens / 1000);
      const maxK = contextWindowK(model);
      const pct = Math.round((contextTokens / (maxK * 1000)) * 100);
      const total = cacheRead + cacheCreation;
      const hitRate = total > 0 ? Math.round((cacheRead / total) * 100) : 0;

      ctx.reply(
        `🧠 Model: ${model}\n📚 Context: ~${contextK}k/${maxK}k (${pct}%)\n🗄️ Cache: ${hitRate}% hit`,
      );
    });

    this.bot.command('tasks', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const groups = this.opts.registeredGroups();
      const group = groups[chatJid];
      if (!group) {
        ctx.reply('Chat not registered.');
        return;
      }

      const { filter, unknownArg } = parseTaskFilter(ctx.match);
      const tasks = filterTasksByStatus(getTasksForGroup(group.folder), filter);
      const body = formatTasksList(tasks, new Date(), filter);
      const prefix = unknownArg
        ? `unknown filter "${unknownArg}", showing active. supported: all | paused\n\n`
        : '';
      ctx.reply(prefix + body, { parse_mode: 'Markdown' });
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set([
      'chatid',
      'ping',
      'new',
      'status',
      'restart',
      'tasks',
      'stop',
    ]);

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();
      const threadId = ctx.message.message_thread_id;

      const replyTo = ctx.message.reply_to_message;
      const replyToMessageId = replyTo?.message_id?.toString();
      const replyToContent = replyTo?.text || replyTo?.caption;
      const replyToQuotedText = ctx.message.quote?.text;
      const replyToSenderName = replyTo
        ? replyTo.from?.first_name ||
          replyTo.from?.username ||
          replyTo.from?.id?.toString() ||
          'Unknown'
        : undefined;

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }

        // Treat replies to the bot's own messages as trigger in groups
        if (
          replyTo?.from?.id === ctx.me.id &&
          ctx.chat.type !== 'private' &&
          !TRIGGER_PATTERN.test(content)
        ) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        thread_id: threadId ? threadId.toString() : undefined,
        reply_to_message_id: replyToMessageId,
        reply_to_message_content: replyToContent,
        reply_to_sender_name: replyToSenderName,
        reply_to_quoted_text: replyToQuotedText,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages: download files when possible, fall back to placeholders.
    const storeMedia = (
      ctx: any,
      placeholder: string,
      opts?: {
        fileId?: string;
        filename?: string;
        messageType?: NonNullable<NewMessage['message_type']>;
      },
    ) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      let needsTriggerPrefix = false;
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername && caption) {
        const entities = ctx.message.caption_entities || [];
        needsTriggerPrefix = entities.some(
          (e: any) =>
            e.type === 'mention' &&
            ctx.message
              .caption!.substring(e.offset, e.offset + e.length)
              .toLowerCase() === `@${botUsername}`,
        );
      }

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

      // Reply to bot's message in group = trigger
      const replyTo = ctx.message.reply_to_message;
      if (!needsTriggerPrefix && replyTo?.from?.id === ctx.me.id && isGroup) {
        needsTriggerPrefix = true;
      }
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      const deliver = (content: string, groupRelPath?: string) => {
        const final = needsTriggerPrefix
          ? `@${ASSISTANT_NAME} ${content}`
          : content;
        this.opts.onMessage(chatJid, {
          id: ctx.message.message_id.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content: final,
          timestamp,
          is_from_me: false,
          message_type: opts?.messageType,
          file_path: groupRelPath,
        });
      };

      // If we have a file_id, attempt to download; deliver asynchronously
      if (opts?.fileId) {
        const msgId = ctx.message.message_id.toString();
        const filename =
          opts.filename ||
          `${placeholder.replace(/[[\] ]/g, '').toLowerCase()}_${msgId}`;
        this.downloadFile(opts.fileId, group.folder, filename).then(
          async (downloaded) => {
            if (!downloaded) {
              deliver(`${placeholder}${caption}`);
              return;
            }
            // containerPath is what the agent sees inside the workspace
            // mount; strip the mount prefix to get the group-relative
            // file_path stored alongside the message row.
            const groupRel = downloaded.containerPath.replace(
              /^\/workspace\/group\//,
              '',
            );
            // Voice/audio: try host-side STT so the agent reads the
            // transcript inline instead of seeing a bare placeholder.
            // Failure is non-fatal — we just fall back to the placeholder.
            let label = placeholder;
            if (opts.messageType === 'voice') {
              const transcript = await transcribe(downloaded.localPath);
              if (transcript) {
                const inner = placeholder.slice(1, -1);
                label = `[${inner}: ${transcript}]`;
              }
            }
            deliver(
              `${label} (${downloaded.containerPath})${caption}`,
              groupRel,
            );
          },
        );
        return;
      }

      deliver(`${placeholder}${caption}`);
    };

    this.bot.on('message:photo', (ctx) => {
      // Telegram sends multiple sizes; last is largest
      const photos = ctx.message.photo;
      const largest = photos?.[photos.length - 1];
      storeMedia(ctx, '[Photo]', {
        fileId: largest?.file_id,
        filename: `photo_${ctx.message.message_id}`,
        messageType: 'photo',
      });
    });
    this.bot.on('message:video', (ctx) => {
      storeMedia(ctx, '[Video]', {
        fileId: ctx.message.video?.file_id,
        filename: `video_${ctx.message.message_id}`,
        messageType: 'video',
      });
    });
    this.bot.on('message:voice', (ctx) => {
      storeMedia(ctx, '[Voice message]', {
        fileId: ctx.message.voice?.file_id,
        filename: `voice_${ctx.message.message_id}`,
        messageType: 'voice',
      });
    });
    this.bot.on('message:audio', (ctx) => {
      const name =
        ctx.message.audio?.file_name || `audio_${ctx.message.message_id}`;
      storeMedia(ctx, '[Audio]', {
        fileId: ctx.message.audio?.file_id,
        filename: name,
        messageType: 'voice',
      });
    });
    this.bot.on('message:document', (ctx) => {
      const doc = ctx.message.document;
      const name = doc?.file_name || 'file';
      // Forwarded WAV/MP3 from other chats often arrives as a document
      // rather than message:audio (Telegram's classifier is inconsistent).
      // Route audio-mime documents through the STT path so the agent sees
      // the transcript instead of a bare [Document: ...] placeholder.
      const isAudio = (doc?.mime_type || '').startsWith('audio/');
      storeMedia(ctx, isAudio ? `[Audio: ${name}]` : `[Document: ${name}]`, {
        fileId: doc?.file_id,
        filename: name,
        messageType: isAudio ? 'voice' : 'document',
      });
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeMedia(ctx, `[Sticker ${emoji}]`, { messageType: 'sticker' });
    });
    this.bot.on('message:location', (ctx) => storeMedia(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeMedia(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          // FED-38 menu order: first (/status) and last (/stop) fixed, the rest
          // alphabetical between them.
          this.bot!.api.setMyCommands([
            { command: 'status', description: 'Show context usage' },
            { command: 'chatid', description: 'Show chat ID' },
            { command: 'new', description: 'Reset session' },
            { command: 'ping', description: 'Check if bot is online' },
            { command: 'restart', description: 'Restart NanoClaw' },
            { command: 'tasks', description: 'List scheduled tasks' },
            { command: 'stop', description: 'Interrupt agent now' },
          ]).catch((err) => logger.warn({ err }, 'Failed to set bot commands'));
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );

          // If we were just kickstarted via /restart, notify the requesting chat.
          if (fs.existsSync(RESTART_NOTIFY_FILE)) {
            try {
              const marker = JSON.parse(
                fs.readFileSync(RESTART_NOTIFY_FILE, 'utf-8'),
              );
              const opts: { message_thread_id?: number } = {};
              if (typeof marker.threadId === 'number') {
                opts.message_thread_id = marker.threadId;
              }
              this.bot!.api.sendMessage(
                marker.chatId,
                `${ASSISTANT_NAME} back online.`,
                opts,
              )
                .catch((err) =>
                  logger.warn({ err }, '/restart: failed to send back-online'),
                )
                .finally(() => {
                  try {
                    fs.unlinkSync(RESTART_NOTIFY_FILE);
                  } catch {
                    // ignore
                  }
                });
            } catch (err) {
              logger.warn({ err }, '/restart: failed to read notify marker');
              try {
                fs.unlinkSync(RESTART_NOTIFY_FILE);
              } catch {
                // ignore
              }
            }
          }

          resolve();
        },
      });
    });
  }

  async sendMessage(
    jid: string,
    text: string,
    threadId?: string,
    format: MessageFormat = 'markdown',
  ): Promise<string | undefined> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return undefined;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const options = threadId
        ? { message_thread_id: parseInt(threadId, 10) }
        : {};

      // Telegram has a 4096 character limit per message — split if needed.
      // We return the message_id of the FIRST chunk, which is how agents can
      // reference the logical send via get_message.
      const MAX_LENGTH = 4096;
      let firstMessageId: string | undefined;
      if (text.length <= MAX_LENGTH) {
        const sent = await sendTelegramMessage(
          this.bot.api,
          numericId,
          text,
          options,
          format,
        );
        firstMessageId = sent?.message_id?.toString();
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          const sent = await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
            options,
            format,
          );
          if (firstMessageId === undefined) {
            firstMessageId = sent?.message_id?.toString();
          }
        }
      }
      logger.info(
        { jid, length: text.length, threadId },
        'Telegram message sent',
      );
      return firstMessageId;
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
      return undefined;
    }
  }

  async setReaction(
    jid: string,
    messageId: string,
    emoji: string | null,
  ): Promise<void> {
    if (!this.bot) {
      throw new Error('Telegram bot not initialized');
    }

    const normalizedEmoji = emoji === '' ? null : emoji;
    const cacheKey = `${jid}:${messageId}`;
    if (this.lastReactions.get(cacheKey) === normalizedEmoji) {
      logger.debug(
        { jid, messageId, emoji: normalizedEmoji },
        'Telegram reaction idempotent cache hit, skipping API',
      );
      return;
    }

    if (normalizedEmoji !== null && !ALLOWED_REACTIONS.has(normalizedEmoji)) {
      throw new Error(
        `Emoji "${normalizedEmoji}" not allowed for Telegram bot reactions`,
      );
    }

    const numericId = jid.replace(/^tg:/, '');
    const numMsgId = parseInt(messageId, 10);
    if (Number.isNaN(numMsgId)) {
      throw new Error(`Invalid message_id: "${messageId}"`);
    }

    const reaction: ReactionType[] = normalizedEmoji
      ? ([
          { type: 'emoji', emoji: normalizedEmoji },
        ] as unknown as ReactionType[])
      : [];

    await this.bot.api.setMessageReaction(numericId, numMsgId, reaction);
    logger.info(
      { jid, messageId, emoji: normalizedEmoji },
      'Telegram reaction API called',
    );

    if (this.lastReactions.has(cacheKey)) {
      this.lastReactions.delete(cacheKey);
    }
    this.lastReactions.set(cacheKey, normalizedEmoji);
    while (this.lastReactions.size > REACTION_CACHE_CAP) {
      const oldestKey = this.lastReactions.keys().next().value;
      if (oldestKey === undefined) break;
      this.lastReactions.delete(oldestKey);
    }
  }

  getCachedReaction(jid: string, messageId: string): string | null | undefined {
    return this.lastReactions.get(`${jid}:${messageId}`);
  }

  getCachedEyeMessageIds(jid: string): string[] {
    const prefix = `${jid}:`;
    const ids: string[] = [];
    for (const [key, value] of this.lastReactions) {
      if (value === '👀' && key.startsWith(prefix)) {
        ids.push(key.slice(prefix.length));
      }
    }
    return ids;
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    for (const jid of [...this.typingTimers.keys()])
      this.stopTypingHeartbeat(jid);
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async sendVoice(
    jid: string,
    audio: Buffer,
    threadId?: string,
  ): Promise<{ ok: true; message_id: string } | { ok: false; error: string }> {
    if (!this.bot) return { ok: false, error: 'Telegram bot not initialized' };
    const numericId = jid.replace(/^tg:/, '');
    const options = threadId
      ? { message_thread_id: parseInt(threadId, 10) }
      : {};

    let lastError: string | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const sent = await this.bot.api.sendVoice(
          numericId,
          new InputFile(audio, 'voice.ogg'),
          options,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          AbortSignal.timeout(120_000) as any,
        );
        const id = sent?.message_id?.toString();
        if (id) {
          logger.info({ jid }, 'Telegram voice message sent');
          return { ok: true, message_id: id };
        }
        lastError = 'Telegram returned no message_id';
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        logger.warn({ jid, attempt, err }, 'sendVoice attempt failed');
        if (attempt < 2) await new Promise((r) => setTimeout(r, 2000));
      }
    }
    logger.error(
      { jid, lastError },
      'Failed to send Telegram voice after 3 attempts',
    );
    return { ok: false, error: lastError ?? 'unknown error' };
  }

  async sendPhoto(
    jid: string,
    filePath: string,
    caption?: string,
    threadId?: string,
  ): Promise<{ ok: true; message_id: string } | { ok: false; error: string }> {
    if (!this.bot) return { ok: false, error: 'Telegram bot not initialized' };
    const numericId = jid.replace(/^tg:/, '');
    const options: Record<string, unknown> = {};
    if (caption) options.caption = caption;
    if (threadId) options.message_thread_id = parseInt(threadId, 10);

    let lastError: string | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const sent = await this.bot.api.sendPhoto(
          numericId,
          new InputFile(fs.readFileSync(filePath), path.basename(filePath)),
          options,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          AbortSignal.timeout(120_000) as any,
        );
        const id = sent?.message_id?.toString();
        if (id) {
          logger.info({ jid }, 'Telegram photo sent');
          return { ok: true, message_id: id };
        }
        lastError = 'Telegram returned no message_id';
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        logger.warn({ jid, attempt, err }, 'sendPhoto attempt failed');
        if (attempt < 2) await new Promise((r) => setTimeout(r, 2000));
      }
    }
    logger.error(
      { jid, lastError },
      'Failed to send Telegram photo after 3 attempts',
    );
    return { ok: false, error: lastError ?? 'unknown error' };
  }

  async sendDocument(
    jid: string,
    filePath: string,
    caption?: string,
    threadId?: string,
    filename?: string,
  ): Promise<{ ok: true; message_id: string } | { ok: false; error: string }> {
    if (!this.bot) return { ok: false, error: 'Telegram bot not initialized' };
    const numericId = jid.replace(/^tg:/, '');
    const options: Record<string, unknown> = {};
    if (caption) options.caption = caption;
    if (threadId) options.message_thread_id = parseInt(threadId, 10);
    const sentName = filename ?? path.basename(filePath);

    // 180s — photo previews are ~200KB but documents ship full-resolution
    // PNGs (1-5MB on hd renders), so the upload tail needs headroom over the
    // photo timeout (120s).
    let lastError: string | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const sent = await this.bot.api.sendDocument(
          numericId,
          new InputFile(fs.readFileSync(filePath), sentName),
          options,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          AbortSignal.timeout(180_000) as any,
        );
        const id = sent?.message_id?.toString();
        if (id) {
          logger.info({ jid }, 'Telegram document sent');
          return { ok: true, message_id: id };
        }
        lastError = 'Telegram returned no message_id';
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        logger.warn({ jid, attempt, err }, 'sendDocument attempt failed');
        if (attempt < 2) await new Promise((r) => setTimeout(r, 2000));
      }
    }
    logger.error(
      { jid, lastError },
      'Failed to send Telegram document after 3 attempts',
    );
    return { ok: false, error: lastError ?? 'unknown error' };
  }

  async forwardMessage(args: {
    toJid: string;
    fromJid: string;
    messageId: string;
    mode: 'forward' | 'copy';
    captionOverride?: string;
    threadId?: string;
  }): Promise<{ ok: true; message_id: string } | { ok: false; error: string }> {
    if (!this.bot) return { ok: false, error: 'Telegram bot not initialized' };
    const toChatId = args.toJid.replace(/^tg:/, '');
    const fromChatId = args.fromJid.replace(/^tg:/, '');
    const numericMessageId = parseInt(args.messageId, 10);
    if (Number.isNaN(numericMessageId)) {
      return { ok: false, error: `invalid message_id: "${args.messageId}"` };
    }

    const baseOpts: Record<string, unknown> = {};
    if (args.threadId) {
      baseOpts.message_thread_id = parseInt(args.threadId, 10);
    }

    try {
      if (args.mode === 'forward') {
        const sent = await this.bot.api.forwardMessage(
          toChatId,
          fromChatId,
          numericMessageId,
          baseOpts,
        );
        return { ok: true, message_id: String(sent.message_id) };
      }
      const copyOpts = { ...baseOpts };
      if (typeof args.captionOverride === 'string') {
        (copyOpts as { caption?: string }).caption = args.captionOverride;
      }
      const sent = await this.bot.api.copyMessage(
        toChatId,
        fromChatId,
        numericMessageId,
        copyOpts,
      );
      return { ok: true, message_id: String(sent.message_id) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        {
          toJid: args.toJid,
          fromJid: args.fromJid,
          messageId: args.messageId,
          mode: args.mode,
          err,
        },
        'Telegram forward/copy failed',
      );
      return { ok: false, error: message };
    }
  }

  private async sendTypingAction(jid: string): Promise<void> {
    if (!this.bot) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }

  private stopTypingHeartbeat(jid: string): void {
    const timer = this.typingTimers.get(jid);
    if (!timer) return;
    clearInterval(timer);
    this.typingTimers.delete(jid);
  }

  /**
   * Show "typing…" for the whole turn, not just the ~5s Telegram keeps a single
   * chat action alive. `true` starts a heartbeat (repeat calls while one is
   * already running just re-assert the action — a message piped into a live
   * container does that), `false` stops it.
   */
  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) {
      this.stopTypingHeartbeat(jid);
      return;
    }
    if (!this.bot) return;

    await this.sendTypingAction(jid);
    if (this.typingTimers.has(jid)) return;

    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - startedAt >= TYPING_MAX_MS) {
        logger.debug({ jid }, 'Typing heartbeat hit max duration, stopping');
        this.stopTypingHeartbeat(jid);
        return;
      }
      void this.sendTypingAction(jid);
    }, TYPING_REFRESH_MS);
    // Never hold the process open on the indicator alone.
    timer.unref?.();
    this.typingTimers.set(jid, timer);
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
