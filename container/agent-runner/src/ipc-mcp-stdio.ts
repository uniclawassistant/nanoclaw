/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';
import allowedReactions from './telegram-allowed-reactions.json' with { type: 'json' };

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const RESPONSES_DIR = path.join(IPC_DIR, 'responses');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

const ALLOWED_REACTIONS: ReadonlySet<string> = new Set(allowedReactions);
const REACTION_RESPONSE_TIMEOUT_MS = 5_000;
const REACTION_POLL_INTERVAL_MS = 100;

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z
      .string()
      .optional()
      .describe(
        'Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.',
      ),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

const SEND_FILE_TIMEOUT_MS = 240_000;
const SEND_FILE_POLL_INTERVAL_MS = 250;

server.tool(
  'send_file',
  `Send a local file to the current chat as a channel-native document (Telegram sendDocument: no compression, original bytes preserved).

USE FOR: arbitrary attachments — markdown, pdf, json, csv, logs, zip, code dumps. NOT for images you generated or already have on disk (use \`generate_image\` / \`edit_image\` / \`send_image\` — those ship as compressed photos with native preview) or for voice (use \`send_voice\`).

PATH:
• Relative paths resolve from /workspace/group/ (your CWD).
• Absolute paths must be under /workspace/group/ or /workspace/extra/<mount>/. Anything else (including .. or symlink escapes) is rejected.
• File must exist and be readable.

CAPTION: optional plain-text caption shown under the document in the chat.
FILENAME: optional override for how the recipient sees the file. Defaults to the source basename.

LIMITS: Telegram Bot API rejects files >50MB with a clear error — surfaced back to you so you can split, compress, or skip. Other channels are not yet supported.

RETURN (JSON in tool output): { ok: true, message_id } on success — message_id is usable with get_message and react. { ok: false, error } on failure — error is the underlying API or path-validation reason (e.g. "path escapes its allowed root", "Bad Request: file is too big").`,
  {
    path: z
      .string()
      .describe(
        'File path. Relative is resolved from /workspace/group/; absolute must be under /workspace/group/ or /workspace/extra/<mount>/.',
      ),
    caption: z
      .string()
      .optional()
      .describe('Optional plain-text caption shown under the document.'),
    filename: z
      .string()
      .optional()
      .describe(
        'Optional override for the filename the recipient sees. Defaults to the source basename.',
      ),
  },
  async (args) => {
    const requestId = crypto.randomUUID();
    const data: Record<string, string | undefined> = {
      type: 'document',
      chatJid,
      sourcePath: args.path,
      caption: args.caption,
      filename: args.filename,
      requestId,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    const responsePath = path.join(RESPONSES_DIR, `${requestId}.json`);
    const deadline = Date.now() + SEND_FILE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (fs.existsSync(responsePath)) {
        try {
          const resp = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
          fs.unlinkSync(responsePath);
          const payload = resp.success
            ? { ok: true, message_id: resp.message_id }
            : { ok: false, error: resp.error ?? 'unknown error' };
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify(payload) },
            ],
            ...(resp.success ? {} : { isError: true as const }),
          };
        } catch (err) {
          return toolError(
            `Failed to read send_file response: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      await sleep(SEND_FILE_POLL_INTERVAL_MS);
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: false,
            error:
              'send_file request timed out after 240s — the upload may still be in flight on the host.',
          }),
        },
      ],
      isError: true as const,
    };
  },
);

function toolError(text: string): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MEDIA_TOOL_TIMEOUT_MS = 600_000; // 10 min hard ceiling for image gen + delivery
const MEDIA_TOOL_POLL_INTERVAL_MS = 250;

/**
 * Write a media-tool IPC request, wait up to MEDIA_TOOL_TIMEOUT_MS for the
 * host to write the response, return the MCP tool payload. Centralized so
 * the four media tools share the same request/response plumbing.
 */
async function dispatchMediaTool(
  type: 'generate_image' | 'edit_image' | 'send_image' | 'send_voice',
  fields: Record<string, unknown>,
  timeoutMs: number = MEDIA_TOOL_TIMEOUT_MS,
): Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: true;
}> {
  const requestId = crypto.randomUUID();
  const data: Record<string, unknown> = {
    type,
    chatJid,
    requestId,
    groupFolder,
    timestamp: new Date().toISOString(),
    ...fields,
  };
  writeIpcFile(MESSAGES_DIR, data);

  const responsePath = path.join(RESPONSES_DIR, `${requestId}.json`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(responsePath)) {
      try {
        const resp = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
        fs.unlinkSync(responsePath);
        // Host already shaped `data` for the agent on success; on failure it
        // sets success=false + error and we mirror the `send_file` pattern.
        if (resp.success) {
          const payload = resp.data ?? { ok: true, message_id: resp.message_id };
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify(payload) },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: resp.error ?? 'unknown error',
              }),
            },
          ],
          isError: true as const,
        };
      } catch (err) {
        return toolError(
          `Failed to read ${type} response: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    await sleep(MEDIA_TOOL_POLL_INTERVAL_MS);
  }
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          ok: false,
          error: `${type} request timed out after ${Math.round(timeoutMs / 1000)}s — the action may still be in flight on the host.`,
        }),
      },
    ],
    isError: true as const,
  };
}

server.tool(
  'generate_image',
  `Generate an image with GPT Image and ship it to the current chat as a compressed photo (Telegram sendPhoto with native preview).

USE FOR: any new image — illustrations, diagrams, mockups, photos, posters, logos. The result is BOTH delivered to the chat AND saved on disk under \`attachments/image_<timestamp>.<ext>\` so you can re-send it later via \`send_image\` or edit it via \`edit_image\` (the message_id returned here unlocks both).

PROMPT: free-form description. Cyrillic and other non-ASCII work fine.

PRESET (optional, array of tokens). Each token is one of:
  • named size: "portrait" (1024x1536) | "landscape" (1536x1024) | "square" (1024x1024) | "auto"
  • custom WxH (e.g. "1920x1088") — each edge ≤ 3840 and a multiple of 16; aspect ≤ 3:1; total pixels in 655360..8388608
  • key=value: format=jpeg|png|webp (default jpeg) | quality=low|medium|high (default medium) | compression=1..100 (jpeg/webp only, default 85) | size=<named or WxH>
Examples: ["portrait","quality=high"] | ["1536x1024","format=png","quality=high"] | ["compression=92"]
Unknown values warn-and-ignore on the host; pick another token instead of the whole call failing.

CAPTION (optional): plain-text caption shown under the photo in chat.

CHANNELS: image tools are Telegram-only today. On other channels the call returns \`{ ok: true, skipped: true, reason: "channel not supported" }\` and nothing is sent.

RETURN (JSON in tool output):
  • { ok: true, message_id, file_path, message_type } on success — message_id is usable with \`get_message\`, \`react\`, and \`edit_image\` (as source_message_id). file_path is the group-relative path of what shipped to chat.
  • { ok: false, error } on failure — common reasons: "moderation: ..." (rephrase prompt), "generic: ..." (bad params), "transient: ..." (retry), "channel does not support sendPhoto".`,
  {
    prompt: z.string().describe('What to generate. Free-form description.'),
    preset: z
      .array(z.string())
      .optional()
      .describe(
        'Optional preset tokens. See PRESET in the tool description for the full vocabulary.',
      ),
    caption: z
      .string()
      .optional()
      .describe('Optional plain-text caption shown under the photo.'),
  },
  async (args) => {
    return dispatchMediaTool('generate_image', {
      prompt: args.prompt,
      preset: args.preset,
      caption: args.caption,
    });
  },
);

server.tool(
  'edit_image',
  `Edit an existing image (one we previously sent or that the user sent us) and ship the edited result to the current chat as a compressed photo.

SOURCE_MESSAGE_ID: the channel-native message_id of the image to edit. Pass the message_id of:
  • a photo you previously generated with \`generate_image\` (returned in the success payload), or
  • a photo a user sent (use \`get_message\` to retrieve it from a recent reply / context).
The host resolves the source path automatically from the stored message — you do NOT pass a file path.

PROMPT: describe the changes you want. The edit endpoint is iterative — small focused asks ("make it bluer", "add a snow leopard", "remove the watermark") work better than full rewrites.

PRESET / CAPTION: same vocabulary as \`generate_image\`.

CHANNELS: Telegram-only; non-Telegram returns \`{ ok: true, skipped: true, reason: "channel not supported" }\`.

RETURN (JSON in tool output):
  • { ok: true, message_id, file_path, message_type } on success — message_id is the new edited photo's id.
  • { ok: false, error } on failure — common reasons: "source message X not found in this chat" (wrong message_id), "source message X has no attached image" (the message is text/document), "source_missing: ..." (file rotated off disk), "moderation: ...", "generic: ..." (bad prompt).`,
  {
    source_message_id: z
      .string()
      .describe(
        'channel-native message_id of the image to edit (from generate_image success payload or get_message lookup).',
      ),
    prompt: z
      .string()
      .describe('What to change about the source image.'),
    preset: z
      .array(z.string())
      .optional()
      .describe(
        'Optional preset tokens. Same vocabulary as generate_image.',
      ),
    caption: z
      .string()
      .optional()
      .describe('Optional plain-text caption shown under the edited photo.'),
  },
  async (args) => {
    return dispatchMediaTool('edit_image', {
      prompt: args.prompt,
      preset: args.preset,
      caption: args.caption,
      source_message_id: args.source_message_id,
    });
  },
);

server.tool(
  'send_image',
  `Send a local image file to the current chat as a compressed photo (Telegram sendPhoto with native preview).

USE FOR: re-sending an image you already have on disk — a previous generation, a downloaded asset, a screenshot. For arbitrary attachments without compression (markdown, pdf, json, code dumps, original bytes), use \`send_file\` instead.

PATH:
• Relative paths resolve from /workspace/group/ (your CWD).
• Absolute paths must be under /workspace/group/ or /workspace/extra/<mount>/. Anything else (including \`..\` or symlink escapes) is rejected.
• File must exist and be readable.

CAPTION (optional): plain-text caption shown under the photo.

CHANNELS: Telegram-only; non-Telegram returns \`{ ok: true, skipped: true, reason: "channel not supported" }\`.

RETURN (JSON in tool output):
  • { ok: true, message_id, file_path, message_type: "photo" } on success.
  • { ok: false, error } on failure — common reasons: "path escapes its allowed root", "Bad Request: file is too big" (Telegram caps photos at 10MB).`,
  {
    path: z
      .string()
      .describe(
        'Image path. Relative is resolved from /workspace/group/; absolute must be under /workspace/group/ or /workspace/extra/<mount>/.',
      ),
    caption: z
      .string()
      .optional()
      .describe('Optional plain-text caption shown under the photo.'),
  },
  async (args) => {
    return dispatchMediaTool('send_image', {
      sourcePath: args.path,
      caption: args.caption,
    });
  },
);

server.tool(
  'send_voice',
  `Synthesize TTS audio with Gemini 3.1 Flash and send it as a Telegram voice note.

USE FOR: voice replies — natural for casual chat, a short spoken summary, or staying in voice mode after the user sent a voice message. For mixed responses, send the spoken summary via this tool and include details in a follow-up text message via \`send_message\`.

TEXT: what should be spoken. Plain text — no markdown / code / bullets (they are read literally). Inline Gemini expression tags work inside the text: \`[laughs]\`, \`[whispers]\`, \`[sighs]\`, \`[gasp]\`, etc. Example: "Ну привет! [laughs] Как ты? [whispers] Это секрет."

VOICE (optional): named Gemini voice. Examples: Kore, Leda, Algenib, Puck, Enceladus, Zephyr. Unknown names warn-and-fall back to the instance default. Full catalog in the tts skill.

DIRECTOR (optional): prose-style stage direction applied to the whole utterance, e.g. "whispered, close to mic" or "warm storyteller tone, unhurried" or "tired late-night sarcasm".

PROFILE / SCENE (optional): persona / setting carried into the synthesis prompt. Use when you want a specific characterization beyond a one-liner director note.

CHANNELS: Telegram-only; non-Telegram returns \`{ ok: true, skipped: true, reason: "channel not supported" }\`.

RETURN (JSON in tool output):
  • { ok: true, message_id } on success — message_id is usable with \`get_message\` and \`react\`.
  • { ok: false, error } on failure — common reasons: "TTS not configured (no API key)", Gemini/OpenAI API errors, "channel does not support sendVoice".`,
  {
    text: z
      .string()
      .describe(
        'Plain text to speak. Inline Gemini expression tags ([laughs], [whispers], etc.) are honored.',
      ),
    voice: z
      .string()
      .optional()
      .describe(
        'Optional named Gemini voice (e.g. "Kore", "Leda"). Unknown names fall back to instance default.',
      ),
    director: z
      .string()
      .optional()
      .describe(
        'Optional prose-style stage direction applied to the utterance (e.g. "whispered, close to mic").',
      ),
    profile: z
      .string()
      .optional()
      .describe('Optional persona/audio profile.'),
    scene: z.string().optional().describe('Optional scene/setting context.'),
  },
  async (args) => {
    return dispatchMediaTool('send_voice', {
      text: args.text,
      voice: args.voice,
      director: args.director,
      profile: args.profile,
      scene: args.scene,
    });
  },
);

server.tool(
  'react',
  `Set or clear an emoji reaction on a Telegram message. Useful as a lightweight signal that you've received a request and it's being processed (e.g. 👀 while working, 👌 when done), instead of sending a noisy chat message.

WHEN TO USE:
• Task will take more than a couple of seconds — react with 👀 so the user sees you've picked it up.
• Replace with a different emoji to signal state changes (👀 → 👌 for done, 👀 → 💔 for failure, 👀 → 🤔 to ask for clarification).
• Pass \`emoji: null\` (JSON null, or empty string "") to remove the reaction entirely when no follow-up signal is needed. Any other value is validated against the allowlist.

DONE-EMOJI HINT: ✅ is NOT in the Telegram-bot-allowed list. For "done" use one of: 👌 (got it) / 🫡 (on it) / 💯 (solid) / ❤ (warm ack) / 🔥 (great).

LIFECYCLE (important):
• Use react within a single turn: \`react(👀)\` at the start, replace or \`react(null)\` before finishing the same response.
• The \`message_id\` fallback resolves to the most recent incoming user message on the host side. If the user sent another message between your 👀 and your clear/replace, a cross-turn call without explicit \`message_id\` will hit the NEW message, leaving the old 👀 orphaned. For any cross-turn use, pass \`message_id\` explicitly (the tool returns it in the success response so you can persist it).

GROUP CHATS: you MUST pass \`message_id\` explicitly in group chats. Without it the fallback picks the most recent non-bot message, which may be from someone else while you were working. In 1-on-1 DMs the fallback is safe.

LIMITATIONS:
• Telegram only. Other channels will return an error.
• Only emoji from the Telegram-bot-allowed list (👍 ❤ 🔥 👀 🎉 🤔 👌 🫡 💯 …). Unknown emoji returns an error.
• This tool is for your (the agent's) own use. Do not call it from hooks or automation.
• Replacing 👀 with 👌 is one call — do not remove then add separately.`,
  {
    emoji: z
      .string()
      .nullable()
      .describe(
        'Emoji to set, or null to remove any existing reaction. Must be in the Telegram-bot-allowed list.',
      ),
    message_id: z
      .string()
      .optional()
      .describe(
        'Telegram message_id to react to. Required in group chats. In DMs, defaults to the last incoming user message.',
      ),
  },
  async (args) => {
    if (!chatJid.startsWith('tg:')) {
      return toolError('Reactions are only supported in Telegram channels.');
    }

    const emoji = args.emoji === '' ? null : args.emoji;
    if (emoji !== null && !ALLOWED_REACTIONS.has(emoji)) {
      return toolError(
        `Emoji "${emoji}" not allowed for Telegram bot reactions. Examples: 👍 ❤ 🔥 👀 🎉 🤔. See Telegram Bot API docs for the full list.`,
      );
    }

    const numericChat = chatJid.slice(3);
    const isGroupChat = numericChat.startsWith('-');
    if (isGroupChat && !args.message_id) {
      return toolError(
        'In group chats you must pass message_id explicitly — the last-message fallback is unreliable because other participants may have written while you were working.',
      );
    }

    const requestId = crypto.randomUUID();
    const data: Record<string, string | null | undefined> = {
      type: 'reaction',
      chatJid,
      emoji,
      message_id: args.message_id ?? null,
      requestId,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    const responsePath = path.join(RESPONSES_DIR, `${requestId}.json`);
    const deadline = Date.now() + REACTION_RESPONSE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (fs.existsSync(responsePath)) {
        try {
          const resp = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
          fs.unlinkSync(responsePath);
          if (resp.success) {
            const idSuffix =
              typeof resp.message_id === 'string'
                ? ` on message ${resp.message_id}`
                : '';
            const summary =
              emoji === null
                ? `Reaction cleared${idSuffix}.`
                : `Reaction ${emoji} set${idSuffix}.`;
            return {
              content: [{ type: 'text' as const, text: summary }],
            };
          }
          return toolError(
            `Failed to set reaction: ${resp.error ?? 'unknown error'}`,
          );
        } catch (err) {
          return toolError(
            `Failed to read reaction response: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      await sleep(REACTION_POLL_INTERVAL_MS);
    }

    return toolError(
      'Reaction request timed out after 5s — it may still have been applied on the host.',
    );
  },
);

server.tool(
  'get_message',
  `Fetch a stored message by chat JID and message ID. Returns sender, timestamp, text, attachments, and any feature-specific metadata (e.g. the generation prompt for images we previously created).

WHEN TO USE:
• You see a reply_to_<id> marker in an incoming message and need the original's context.
• The user refers to "that image you sent", "my earlier message", etc. — query the message by id to get the exact text or attachment path.
• You need the generation prompt of an image you produced earlier (e.g. to re-run, edit, or explain it).

RETURN SHAPE (success case):
{ message_id, chat_jid, timestamp, sender, direction: "in"|"out", type: "text"|"photo"|"document"|"voice"|"video"|"sticker"|"system", text?, reply_to_message_id?, file_path? (group-relative), generation?: {prompt, preset?, original_png_path, source_message_id?}, reactions: [] }

\`generation.source_message_id\` is set on photos produced by \`edit_image\` and points at the message that was used as the edit source. Walk this chain backwards (recursively call \`get_message\` on each \`source_message_id\`) to recover the full generate→edit→edit history. It is absent on \`generate_image\` results and on user-uploaded photos.

Missing message returns { found: false, message_id, chat_jid } — not an error.

Don't spam calls — query only when you actually need the referenced message's content.`,
  {
    message_id: z
      .string()
      .describe(
        'The channel-native message_id to look up (string or stringified number).',
      ),
    jid: z
      .string()
      .optional()
      .describe('Chat JID. Defaults to the current chat if omitted.'),
  },
  async (args) => {
    const requestId = crypto.randomUUID();
    const data: Record<string, string> = {
      type: 'get_message',
      chatJid: args.jid ?? chatJid,
      message_id: args.message_id,
      requestId,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    const responsePath = path.join(RESPONSES_DIR, `${requestId}.json`);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (fs.existsSync(responsePath)) {
        try {
          const resp = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
          fs.unlinkSync(responsePath);
          if (!resp.success) {
            return toolError(
              `get_message failed: ${resp.error ?? 'unknown error'}`,
            );
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(resp.data, null, 2),
              },
            ],
          };
        } catch (err) {
          return toolError(
            `Failed to read get_message response: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      await sleep(100);
    }

    return toolError('get_message request timed out after 5s.');
  },
);

const SEARCH_MESSAGES_TIMEOUT_MS = 5_000;
const SEARCH_MESSAGES_POLL_INTERVAL_MS = 100;

server.tool(
  'search_messages',
  `Search stored chat history. Backed by an SQLite FTS5 index over message content, sender names, and (optionally) the prompts of images you generated.

WHEN TO USE:
• You wrote a memory/diary entry but want to fact-check it against the original message wording or timestamp.
• You need to recover an exact quote, attachment, or generation prompt the user referenced.
• Pair with \`get_message\` to dig deeper, or with \`forward_message\` (when available) to repost a found message.

QUERY MODES:
• Substring (default, \`is_regex: false\`): case-insensitive token-prefix match. "Cross" matches messages containing "Crosstalk". Multi-word queries match adjacent tokens.
• Regex (\`is_regex: true\`): JavaScript-style regex applied case-insensitively. Invalid regex returns isError. No FTS5 — slower on large history but flexible.

FILTERS:
• \`jid\` — single string or array of chat JIDs. Defaults to all chats you can read. Non-main groups can only search their own chat.
• \`since\` / \`until\` — ISO 8601 inclusive bounds.
• \`sender\` — display name (case-insensitive exact match).
• \`message_type\` — restrict to one of text/photo/voice/document/video/sticker, or "all" (default).
• \`include_generation\` — also search the prompts of images you produced. Default true.
• \`context\` — for each hit also return up to N neighboring messages before and after in the same chat (default 0).
• \`limit\` — max hits returned (default 20, max 100). Use \`total_matches\` + \`truncated\` to see if you should re-query with tighter filters.

RETURN SHAPE (success):
{
  results: [
    { message_id, chat_jid, timestamp, sender, direction: "in"|"out", type, snippet, matched_field: "content"|"generation_prompt"|"sender_name", file_path?, generation?, context_messages?: [{ message_id, timestamp, sender, direction, snippet }] }
  ],
  total_matches: number,
  truncated: boolean
}

\`snippet\` highlights the matched span with markdown **bold**. \`matched_field\` tells you whether the hit was on the message body, an image's generation prompt, or the sender's display name.`,
  {
    query: z
      .string()
      .min(1)
      .describe('Search text. Treated as substring (default) or regex (when is_regex=true).'),
    is_regex: z
      .boolean()
      .optional()
      .describe('When true, query is a JavaScript regex applied case-insensitively. Default false.'),
    jid: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe('Restrict to one or more chat JIDs. Defaults to chats the caller can read.'),
    since: z
      .string()
      .optional()
      .describe('ISO 8601 lower bound on message timestamp (inclusive).'),
    until: z
      .string()
      .optional()
      .describe('ISO 8601 upper bound on message timestamp (inclusive).'),
    sender: z
      .string()
      .optional()
      .describe('Filter by sender display name (case-insensitive exact match).'),
    message_type: z
      .enum(['text', 'photo', 'voice', 'document', 'video', 'sticker', 'all'])
      .optional()
      .describe('Restrict to a single message type. Default "all".'),
    include_generation: z
      .boolean()
      .optional()
      .describe('Also search image generation prompts. Default true.'),
    context: z
      .number()
      .int()
      .min(0)
      .max(20)
      .optional()
      .describe('For each hit also return up to N neighboring messages before and after. Default 0.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Max hits returned. Default 20, max 100.'),
  },
  async (args) => {
    const requestId = crypto.randomUUID();
    const data: Record<string, unknown> = {
      type: 'search_messages',
      requestId,
      groupFolder,
      query: args.query,
      is_regex: args.is_regex ?? false,
      include_generation: args.include_generation ?? true,
      context: args.context ?? 0,
      limit: args.limit ?? 20,
      timestamp: new Date().toISOString(),
    };
    if (args.jid !== undefined) data.jid = args.jid;
    if (args.since !== undefined) data.since = args.since;
    if (args.until !== undefined) data.until = args.until;
    if (args.sender !== undefined) data.sender = args.sender;
    if (args.message_type !== undefined) data.message_type = args.message_type;

    if (!isMain && args.jid === undefined) {
      data.jid = chatJid;
    }

    writeIpcFile(MESSAGES_DIR, data);

    const responsePath = path.join(RESPONSES_DIR, `${requestId}.json`);
    const deadline = Date.now() + SEARCH_MESSAGES_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (fs.existsSync(responsePath)) {
        try {
          const resp = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
          fs.unlinkSync(responsePath);
          if (!resp.success) {
            return toolError(
              `search_messages failed: ${resp.error ?? 'unknown error'}`,
            );
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(resp.data, null, 2),
              },
            ],
          };
        } catch (err) {
          return toolError(
            `Failed to read search_messages response: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      await sleep(SEARCH_MESSAGES_POLL_INTERVAL_MS);
    }

    return toolError('search_messages request timed out after 5s.');
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z
      .string()
      .describe(
        'What the agent should do when the task runs. For isolated mode, include all necessary context here.',
      ),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .describe(
        'cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time',
      ),
    schedule_value: z
      .string()
      .describe(
        'cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)',
      ),
    context_mode: z
      .enum(['group', 'isolated'])
      .default('group')
      .describe(
        'group=runs with chat history and memory, isolated=fresh session (include context in prompt)',
      ),
    target_group_jid: z
      .string()
      .optional()
      .describe(
        '(Main group only) JID of the group to schedule the task for. Defaults to the current group.',
      ),
    script: z
      .string()
      .optional()
      .describe(
        'Optional bash script to run before waking the agent. Script must output JSON on the last line of stdout: { "wakeAgent": boolean, "data"?: any }. If wakeAgent is false, the agent is not called. Test your script with bash -c "..." before scheduling.',
      ),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (
        /[Zz]$/.test(args.schedule_value) ||
        /[+-]\d{2}:\d{2}$/.test(args.schedule_value)
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid =
      isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      script: args.script || undefined,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}`,
        },
      ],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter(
            (t: { groupFolder: string }) => t.groupFolder === groupFolder,
          );

      if (tasks.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const formatted = tasks
        .map(
          (t: {
            id: string;
            prompt: string;
            schedule_type: string;
            schedule_value: string;
            status: string;
            next_run: string;
          }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return {
        content: [
          { type: 'text' as const, text: `Scheduled tasks:\n${formatted}` },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} pause requested.`,
        },
      ],
    };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} resume requested.`,
        },
      ],
    };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} cancellation requested.`,
        },
      ],
    };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .optional()
      .describe('New schedule type'),
    schedule_value: z
      .string()
      .optional()
      .describe('New schedule value (see schedule_task for format)'),
    script: z
      .string()
      .optional()
      .describe(
        'New script for the task. Set to empty string to remove the script.',
      ),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (
      args.schedule_type === 'cron' ||
      (!args.schedule_type && args.schedule_value)
    ) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Invalid cron: "${args.schedule_value}".`,
              },
            ],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}".`,
            },
          ],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.script !== undefined) data.script = args.script;
    if (args.schedule_type !== undefined)
      data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined)
      data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} update requested.`,
        },
      ],
    };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z
      .string()
      .describe(
        'The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")',
      ),
    name: z.string().describe('Display name for the group'),
    folder: z
      .string()
      .describe(
        'Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")',
      ),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
    requiresTrigger: z
      .boolean()
      .optional()
      .describe(
        'Whether messages must start with the trigger word. Default: false (respond to all messages). Set to true for busy groups with many participants where you only want the agent to respond when explicitly mentioned.',
      ),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can register new groups.',
          },
        ],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      requiresTrigger: args.requiresTrigger ?? false,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Group "${args.name}" registered. It will start receiving messages immediately.`,
        },
      ],
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
