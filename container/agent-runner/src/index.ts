/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"...", deliveryId:"..."}.json
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Delivery acknowledgements use the same framing with deliveryAckId.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import {
  query,
  HookCallback,
  PreCompactHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';
import {
  handleQueryMessage,
  type AgentRunnerOutput,
  type QueryLoopState,
} from './handle-query-message.js';
import { createContextThresholdHook } from './context-threshold-hook.js';
import { buildInitialPrompt } from './initial-prompt.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  isWorkContinuation?: boolean;
  assistantName?: string;
  script?: string;
  contextThreshold?: number;
}

interface DeliveryAckOutput {
  status: 'success';
  result: null;
  deliveryAckId: string;
}

type ContainerOutput = AgentRunnerOutput | DeliveryAckOutput;

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
// FED-38: host-side `/stop` drops this sentinel to interrupt an in-flight run.
// Unlike `_close` (graceful, ends the input stream at the next turn boundary),
// this triggers `query.interrupt()` mid-turn — aborting the current tool call
// and halting the loop immediately while keeping the SDK session resumable. The
// file body, when non-empty, is the re-sync message to run as the next turn.
const IPC_INPUT_INTERRUPT_SENTINEL = path.join(IPC_INPUT_DIR, '_interrupt');
const INTERRUPT_FALLBACK_RESYNC =
  '⏹ The user interrupted you. Stop the current action. Do not continue or repeat it. Recognize that you may be out of sync and ask what went wrong or what they want instead.';
const IPC_POLL_MS = 500;

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: Array<{
    message: SDKUserMessage;
    deliveryIds: string[];
  }> = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string, deliveryIds: string[] = []): void {
    this.queue.push({
      message: {
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        session_id: '',
      },
      deliveryIds,
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        const next = this.queue.shift()!;
        acknowledgeDeliveries(next.deliveryIds);
        yield next.message;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function acknowledgeDeliveries(deliveryIds: string[]): void {
  for (const deliveryAckId of deliveryIds) {
    writeOutput({ status: 'success', result: null, deliveryAckId });
  }
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

/**
 * Snapshot the on-disk session transcript when a resume is rejected with the
 * 400 "thinking ... blocks cannot be modified" error. The live JSONL gets
 * overwritten by the next run, so without this the exact poisoned content
 * block (the thinking block whose signature no longer matches) is lost. Every
 * such 400 observed so far follows a mid-turn "Close sentinel detected during
 * query" — the stream was cut before the interleaved thinking block finalized.
 * Dumps to /home/node/.claude/poisoned-sessions/ (persists to host
 * data/sessions/<group>/.claude/). No-op for any other error.
 */
function dumpPoisonedSession(
  sessionId: string | undefined,
  errorMessage: string,
): void {
  if (!sessionId) return;
  if (!/thinking[\s\S]*blocks[\s\S]*cannot be modified/.test(errorMessage)) {
    return;
  }
  try {
    const projectsRoot = '/home/node/.claude/projects';
    let src: string | undefined;
    if (fs.existsSync(projectsRoot)) {
      for (const slug of fs.readdirSync(projectsRoot)) {
        const candidate = path.join(projectsRoot, slug, `${sessionId}.jsonl`);
        if (fs.existsSync(candidate)) {
          src = candidate;
          break;
        }
      }
    }
    if (!src) {
      log(`Poisoned-session dump: transcript for ${sessionId} not found`);
      return;
    }
    const reqId = (errorMessage.match(/req_[a-zA-Z0-9]+/) || ['noreq'])[0];
    const dumpDir = '/home/node/.claude/poisoned-sessions';
    fs.mkdirSync(dumpDir, { recursive: true });
    const dest = path.join(dumpDir, `${sessionId}-${reqId}.jsonl`);
    fs.copyFileSync(src, dest);
    fs.writeFileSync(`${dest}.error.txt`, errorMessage);
    log(`Poisoned-session dump written: ${dest}`);
  } catch (e) {
    log(
      `Poisoned-session dump failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function getSessionSummary(
  sessionId: string,
  transcriptPath: string,
): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(
      fs.readFileSync(indexPath, 'utf-8'),
    );
    const entry = index.entries.find((e) => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(
      `Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return null;
}

/**
 * Auto-clear 👀 on turn end. Writes a fire-and-forget IPC request to the host,
 * which checks the cached reaction state and clears it only if it's still 👀.
 * Non-👀 reactions (explicit done-signals set by the agent) are left as-is.
 */
function createAutoClearEyeHook(containerInput: ContainerInput): HookCallback {
  const ipcDir = '/workspace/ipc/messages';
  return async () => {
    try {
      fs.mkdirSync(ipcDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
      const filepath = path.join(ipcDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(
        tempPath,
        JSON.stringify({
          type: 'auto_clear_eye',
          chatJid: containerInput.chatJid,
          groupFolder: containerInput.groupFolder,
          timestamp: new Date().toISOString(),
        }),
      );
      fs.renameSync(tempPath, filepath);
    } catch (err) {
      log(
        `[stop hook] auto_clear_eye IPC write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return {};
  };
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(
        messages,
        summary,
        assistantName,
      );
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(
        `Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {};
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content
                .map((c: { text?: string }) => c.text || '')
                .join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {}
  }

  return messages;
}

function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  title?: string | null,
  assistantName?: string,
): string {
  const now = new Date();
  const formatDateTime = (d: Date) =>
    d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content =
      msg.content.length > 2000
        ? msg.content.slice(0, 2000) + '...'
        : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

/**
 * FED-38: consume the `_interrupt` sentinel dropped by host-side `/stop`.
 * Returns the sentinel body (the re-sync message to run next, possibly empty)
 * when present, or null when no interrupt is pending. Always removes the file
 * so the same sentinel can't fire twice.
 */
function consumeInterrupt(): string | null {
  if (!fs.existsSync(IPC_INPUT_INTERRUPT_SENTINEL)) return null;
  let body = '';
  try {
    body = fs.readFileSync(IPC_INPUT_INTERRUPT_SENTINEL, 'utf-8');
  } catch {
    /* ignore — treat as an empty-body interrupt */
  }
  try {
    fs.unlinkSync(IPC_INPUT_INTERRUPT_SENTINEL);
  } catch {
    /* ignore */
  }
  return body;
}

function interruptResync(body: string | undefined): string {
  return body?.trim() || INTERRUPT_FALLBACK_RESYNC;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
interface IpcInputMessage {
  text: string;
  deliveryId?: string;
}

function drainIpcInput(): IpcInputMessage[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: IpcInputMessage[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push({
            text: data.text,
            deliveryId:
              typeof data.deliveryId === 'string' ? data.deliveryId : undefined,
          });
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

interface PendingInput {
  text: string;
  stopResync: boolean;
  deliveryIds: string[];
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the next prompt with whether it must run as an isolated stop re-sync,
 * or null if _close.
 */
function waitForIpcMessage(): Promise<PendingInput | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      // FED-38: an interrupt wins the between-turn race. Deliver its re-sync
      // before touching queued user messages so a just-stopped action cannot be
      // relaunched by the next message; those messages remain for the next turn.
      const interruptBody = consumeInterrupt();
      if (interruptBody !== null) {
        log(
          'Interrupt sentinel detected between queries, prioritizing re-sync',
        );
        resolve({
          text: interruptResync(interruptBody),
          stopResync: true,
          deliveryIds: [],
        });
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve({
          text: messages.map((message) => message.text).join('\n'),
          stopResync: false,
          deliveryIds: messages.flatMap((message) =>
            message.deliveryId ? [message.deliveryId] : [],
          ),
        });
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
  stopResyncTurn = false,
  initialDeliveryIds: string[] = [],
): Promise<{
  newSessionId?: string;
  lastCompletedAssistantUuid?: string;
  closedDuringQuery: boolean;
  interrupted: boolean;
  resyncText?: string;
}> {
  const stream = new MessageStream();
  stream.push(prompt, initialDeliveryIds);

  // Poll IPC for follow-up messages, the _close sentinel, and the _interrupt
  // sentinel during the query. `agentQuery` (the Query handle) is created below
  // once the SDK options are assembled; the poller only dereferences it after
  // the first IPC_POLL_MS tick, by which point synchronous setup has run.
  let ipcPolling = true;
  let closedDuringQuery = false;
  let interrupted = false;
  let resyncText: string | undefined;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const interruptBody = consumeInterrupt();
    if (interruptBody !== null) {
      log('Interrupt sentinel detected during query, interrupting agent');
      interrupted = true;
      resyncText = interruptBody;
      ipcPolling = false;
      stream.end();
      // In streaming-input mode interrupt() only stops the active turn; it does
      // not close the Query generator. Close it after the control request is
      // acknowledged so queued prompts cannot start another turn.
      void agentQuery
        .interrupt()
        .catch((err) =>
          log(
            `interrupt() failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        )
        .finally(() => agentQuery.close());
      return;
    }
    if (!stopResyncTurn) {
      const messages = drainIpcInput();
      for (const message of messages) {
        log(
          `Piping IPC message into active query (${message.text.length} chars)`,
        );
        stream.push(
          message.text,
          message.deliveryId ? [message.deliveryId] : [],
        );
      }
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  const state: QueryLoopState = {
    messageCount: 0,
    resultCount: 0,
    assistantUsageMessageIds: new Set(),
  };
  const contextThresholdHook = createContextThresholdHook(
    state,
    containerInput.contextThreshold,
  );

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  // FED-38: the Query handle exposes interrupt() (a streaming-mode control
  // request) — the SDK's Ctrl+C primitive. It aborts the in-flight tool call
  // (killing bash children / fetch / MCP requests) and returns control while
  // leaving the on-disk session coherent and resumable, unlike a hard kill.
  const agentQuery = query({
    prompt: stream,
    options: {
      // Keep the [1m] suffix on whatever model runs here: it is how the Agent
      // SDK learns the 1M window — a bare id falls back to the SDK's internal
      // table (200k for new models) and auto-compacts at ~167k (FED-34).
      // No maxThinkingTokens: the SDK enables adaptive thinking by default.
      // The host forwards an instance-scoped override for canary rollouts;
      // services without one stay on the existing Opus default.
      model:
        process.env.NANOCLAW_DEFAULT_MODEL || 'claude-opus-5[1m]',
      cwd: '/workspace/group',
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: globalClaudeMd
        ? {
            type: 'preset' as const,
            preset: 'claude_code' as const,
            append: globalClaudeMd,
          }
        : undefined,
      allowedTools: [
        'Bash',
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
        'WebSearch',
        'WebFetch',
        'Task',
        'TaskOutput',
        'TaskStop',
        'TeamCreate',
        'TeamDelete',
        'SendMessage',
        'TodoWrite',
        'ToolSearch',
        'Skill',
        'NotebookEdit',
        'mcp__nanoclaw__*',
      ],
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      plugins: [
        {
          type: 'local',
          path: '/app/.claude/plugins/function-hooks-probe',
        },
      ],
      mcpServers: {
        nanoclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            NANOCLAW_CHAT_JID: containerInput.chatJid,
            NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
            NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
          },
        },
      },
      hooks: {
        PreCompact: [
          { hooks: [createPreCompactHook(containerInput.assistantName)] },
        ],
        Stop: [{ hooks: [createAutoClearEyeHook(containerInput)] }],
        PostToolUse: [{ hooks: [contextThresholdHook] }],
        PostToolUseFailure: [{ hooks: [contextThresholdHook] }],
      },
    },
  });

  for await (const message of agentQuery) {
    const queryMessage = message as { type: string } & Record<string, unknown>;
    handleQueryMessage(queryMessage, state, {
      emit: writeOutput,
      log,
    });
    if (stopResyncTurn && queryMessage.type === 'result') {
      log('Stop re-sync turn completed, ending isolated query');
      ipcPolling = false;
      stream.end();
    }
  }

  ipcPolling = false;
  log(
    `Query done. Messages: ${state.messageCount}, results: ${state.resultCount}, lastCompletedAssistantUuid: ${state.lastCompletedAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}, interrupted: ${interrupted}`,
  );
  return {
    newSessionId: state.newSessionId,
    lastCompletedAssistantUuid: state.lastCompletedAssistantUuid,
    closedDuringQuery,
    interrupted,
    resyncText,
  };
}

interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

const SCRIPT_TIMEOUT_MS = 30_000;

async function runScript(script: string): Promise<ScriptResult | null> {
  const scriptPath = '/tmp/task-script.sh';
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile(
      'bash',
      [scriptPath],
      {
        timeout: SCRIPT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (stderr) {
          log(`Script stderr: ${stderr.slice(0, 500)}`);
        }

        if (error) {
          log(`Script error: ${error.message}`);
          return resolve(null);
        }

        // Parse last non-empty line of stdout as JSON
        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        if (!lastLine) {
          log('Script produced no output');
          return resolve(null);
        }

        try {
          const result = JSON.parse(lastLine);
          if (typeof result.wakeAgent !== 'boolean') {
            log(
              `Script output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`,
            );
            return resolve(null);
          }
          resolve(result as ScriptResult);
        } catch {
          log(`Script output is not valid JSON: ${lastLine.slice(0, 200)}`);
          resolve(null);
        }
      },
    );
  });
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      /* may not exist */
    }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // Credentials are injected by the host's credential proxy via ANTHROPIC_BASE_URL.
  // No real secrets exist in the container environment.
  const sdkEnv: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '900000',
  };

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close / _interrupt sentinels from previous container runs
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(IPC_INPUT_INTERRUPT_SENTINEL);
  } catch {
    /* ignore */
  }

  // Build initial prompt (drain any pending IPC messages too)
  const pending = drainIpcInput();
  let prompt = buildInitialPrompt(
    containerInput.prompt,
    containerInput.isScheduledTask === true,
    containerInput.isWorkContinuation === true,
    pending.map((message) => message.text),
  );
  let deliveryIds = pending.flatMap((message) =>
    message.deliveryId ? [message.deliveryId] : [],
  );
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
  }

  // Script phase: run script before waking agent
  if (containerInput.script && containerInput.isScheduledTask) {
    log('Running task script...');
    const scriptResult = await runScript(containerInput.script);

    if (!scriptResult || !scriptResult.wakeAgent) {
      const reason = scriptResult
        ? 'wakeAgent=false'
        : 'script error/no output';
      log(`Script decided not to wake agent: ${reason}`);
      writeOutput({
        status: 'success',
        result: null,
      });
      return;
    }

    // Script says wake agent — enrich prompt with script data
    log(`Script wakeAgent=true, enriching prompt with data`);
    prompt = `[SCHEDULED TASK]\n\nScript output:\n${JSON.stringify(scriptResult.data, null, 2)}\n\nInstructions:\n${containerInput.prompt}`;
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  let stopResyncTurn = false;
  try {
    while (true) {
      log(
        `Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`,
      );

      const queryResult = await runQuery(
        prompt,
        sessionId,
        mcpServerPath,
        containerInput,
        sdkEnv,
        resumeAt,
        stopResyncTurn,
        deliveryIds,
      );
      deliveryIds = [];
      stopResyncTurn = false;
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastCompletedAssistantUuid) {
        resumeAt = queryResult.lastCompletedAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // FED-38: host `/stop` interrupted the in-flight run. Keep the session,
      // then run one isolated re-sync turn before any queued user messages.
      if (queryResult.interrupted) {
        log('Interrupted, starting isolated re-sync query immediately');
        prompt = interruptResync(queryResult.resyncText);
        stopResyncTurn = true;
        continue;
      }

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(
        `Got ${nextMessage.stopResync ? 'stop re-sync' : 'new message'} (${nextMessage.text.length} chars), starting new query`,
      );
      prompt = nextMessage.text;
      stopResyncTurn = nextMessage.stopResync;
      deliveryIds = nextMessage.deliveryIds;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    dumpPoisonedSession(sessionId, errorMessage);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
