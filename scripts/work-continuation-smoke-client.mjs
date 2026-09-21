import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const sdkRoot =
  process.env.MCP_SDK_ROOT ??
  '/app/node_modules/@modelcontextprotocol/sdk/dist/esm';
const [{ Client }, { StdioClientTransport }] = await Promise.all([
  import(pathToFileURL(`${sdkRoot}/client/index.js`).href),
  import(pathToFileURL(`${sdkRoot}/client/stdio.js`).href),
]);

const required = [
  'SMOKE_RESULT_PATH',
  'SMOKE_WORK_ID',
  'SMOKE_REMAINING',
  'NANOCLAW_CHAT_JID',
  'NANOCLAW_GROUP_FOLDER',
];
for (const name of required) {
  if (!process.env[name]) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

const resultPath = process.env.SMOKE_RESULT_PATH;
const workId = process.env.SMOKE_WORK_ID;
const closeWorkId = process.env.SMOKE_CLOSE_WORK_ID ?? workId;
const result = {
  version: 1,
  startedAt: new Date().toISOString(),
  workId,
  closeWorkId,
  events: [],
};

function save() {
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
}

function textOf(response) {
  return (response?.content ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

function recordResponse(step, tool, response) {
  result.events.push({
    step,
    tool,
    response,
    responseJson: JSON.stringify(response),
    text: textOf(response),
    at: new Date().toISOString(),
  });
  save();
}

function recordException(step, tool, error) {
  result.events.push({
    step,
    tool,
    exception: error instanceof Error ? error.message : String(error),
    at: new Date().toISOString(),
  });
  save();
}

function successfulOpen(response) {
  if (response?.isError === true) return false;
  try {
    return JSON.parse(textOf(response)).ok === true;
  } catch {
    return false;
  }
}

function listContainsWork(response) {
  return textOf(response).includes(`[${workId}]`);
}

const client = new Client({
  name: 'nanoclaw-work-continuation-smoke',
  version: '1.0.0',
});
const serverEnv = {};
for (const name of [
  'HOME',
  'PATH',
  'NANOCLAW_CHAT_JID',
  'NANOCLAW_GROUP_FOLDER',
  'NANOCLAW_IS_MAIN',
]) {
  if (process.env[name] !== undefined) serverEnv[name] = process.env[name];
}

const transport = new StdioClientTransport({
  command: 'node',
  args: ['/app/dist/ipc-mcp-stdio.js'],
  // Deliberately do not forward the container environment. Inference keys are
  // neither needed nor allowed on this direct MCP path.
  env: serverEnv,
  stderr: 'pipe',
});
transport.stderr?.on('data', (chunk) => {
  result.serverStderr = `${result.serverStderr ?? ''}${chunk}`;
  save();
});

let exitCode = 0;
save();
try {
  await client.connect(transport);

  let opened;
  try {
    opened = await client.callTool({
      name: 'open_work',
      arguments: { id: workId, remaining: process.env.SMOKE_REMAINING },
    });
    recordResponse('open_work', 'open_work', opened);
  } catch (error) {
    recordException('open_work', 'open_work', error);
    exitCode = 20;
  }

  if (opened && successfulOpen(opened)) {
    try {
      const listed = await client.callTool({
        name: 'list_work',
        arguments: {},
      });
      recordResponse('list_work', 'list_work', listed);
    } catch (error) {
      recordException('list_work', 'list_work', error);
      exitCode ||= 21;
    }

    try {
      const closed = await client.callTool({
        name: 'close_work',
        arguments: { id: closeWorkId },
      });
      recordResponse('close_work', 'close_work', closed);
    } catch (error) {
      recordException('close_work', 'close_work', error);
      exitCode ||= 22;
    }

    let listedAfterClose;
    try {
      listedAfterClose = await client.callTool({
        name: 'list_work',
        arguments: {},
      });
      recordResponse(
        listContainsWork(listedAfterClose)
          ? 'post_close_list_initial'
          : 'post_close_list',
        'list_work',
        listedAfterClose,
      );
    } catch (error) {
      recordException('post_close_list_initial', 'list_work', error);
      exitCode ||= 23;
    }

    // A deliberately wrong close id is useful for a red acceptance run, and a
    // real close may itself fail. If the row is still visible, make one safety
    // cleanup call for the real id through MCP only; never write the DB.
    if (!listedAfterClose || listContainsWork(listedAfterClose)) {
      try {
        const cleanup = await client.callTool({
          name: 'close_work',
          arguments: { id: workId },
        });
        recordResponse('cleanup_close_work', 'close_work', cleanup);
      } catch (error) {
        recordException('cleanup_close_work', 'close_work', error);
        exitCode ||= 24;
      }
      try {
        const finalList = await client.callTool({
          name: 'list_work',
          arguments: {},
        });
        recordResponse('post_close_list', 'list_work', finalList);
      } catch (error) {
        recordException('post_close_list', 'list_work', error);
        exitCode ||= 25;
      }
    }
  }
} catch (error) {
  result.topLevelException = error instanceof Error ? error.message : String(error);
  exitCode ||= 26;
} finally {
  try {
    await client.close();
  } catch (error) {
    result.clientCloseException =
      error instanceof Error ? error.message : String(error);
    exitCode ||= 27;
  }
  result.finishedAt = new Date().toISOString();
  result.exitCode = exitCode;
  save();
}

process.exitCode = exitCode;
