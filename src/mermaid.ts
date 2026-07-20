import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { logger } from './logger.js';

// Matches a fenced ```mermaid block and captures the diagram source. The info
// string may carry trailing spaces before the newline.
const MERMAID_FENCE = /```mermaid[ \t]*\r?\n([\s\S]*?)```/g;
const RENDER_TIMEOUT_MS = 30_000;

// Kill switch: rendering spawns a headless browser, so allow disabling it at
// runtime (MERMAID_RENDER=off) without a redeploy. Enabled by default.
export function mermaidEnabled(): boolean {
  return !/^(0|false|off|no)$/i.test(process.env.MERMAID_RENDER ?? '');
}

export interface MermaidBlock {
  raw: string;
  code: string;
}

export function extractMermaidBlocks(text: string): MermaidBlock[] {
  const blocks: MermaidBlock[] = [];
  for (const match of text.matchAll(MERMAID_FENCE)) {
    const code = match[1].trim();
    if (code) blocks.push({ raw: match[0], code });
  }
  return blocks;
}

// Renders one diagram to a PNG inside a fresh temp dir. Returns the PNG path on
// success, or null on any failure (missing dependency, chromium launch error,
// invalid diagram) so callers can fall back to leaving the fenced block as a
// plain code block. mermaid-cli is imported dynamically so a missing/broken
// install disables this feature instead of crashing the host at boot.
export async function renderMermaidToPng(code: string): Promise<string | null> {
  let dir: string | undefined;
  try {
    const { run } = await import('@mermaid-js/mermaid-cli');
    dir = await mkdtemp(join(tmpdir(), 'mermaid-'));
    const input = join(dir, 'diagram.mmd');
    const output = join(dir, 'diagram.png');
    await writeFile(input, code, 'utf8');
    await withTimeout(
      run(input, output as `${string}.png`, {
        quiet: true,
        outputFormat: 'png',
        puppeteerConfig: { args: ['--no-sandbox'] },
        parseMMDOptions: { backgroundColor: 'white' },
      }),
      RENDER_TIMEOUT_MS,
    );
    return output;
  } catch (err) {
    logger.debug(
      { err },
      'Mermaid render failed; leaving fenced block as text',
    );
    if (dir) await cleanupMermaidPng(join(dir, 'diagram.png'));
    return null;
  }
}

export async function cleanupMermaidPng(pngPath: string): Promise<void> {
  try {
    await rm(dirname(pngPath), { recursive: true, force: true });
  } catch (err) {
    logger.debug({ err, pngPath }, 'Mermaid temp cleanup failed');
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('mermaid render timeout')), ms),
    ),
  ]);
}

// Renders each ```mermaid block to a PNG and strips the successfully-rendered
// fences from the text, returning the PNG paths in document order. Blocks that
// fail to render are left in place so they degrade to a normal code block. The
// renderer is injectable so the splitting logic can be tested without a browser.
export async function renderAndSplitMermaid(
  text: string,
  render: (code: string) => Promise<string | null> = renderMermaidToPng,
): Promise<{ text: string; diagrams: string[] }> {
  const blocks = extractMermaidBlocks(text);
  if (blocks.length === 0) return { text, diagrams: [] };

  const diagrams: string[] = [];
  let out = text;
  for (const block of blocks) {
    const png = await render(block.code);
    if (!png) continue;
    diagrams.push(png);
    out = out.replace(block.raw, '');
  }
  if (diagrams.length > 0) out = out.replace(/\n{3,}/g, '\n\n').trim();
  return { text: out, diagrams };
}
