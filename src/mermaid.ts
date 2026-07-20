import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { logger } from './logger.js';

// Matches a top-level fenced ```mermaid block and captures the diagram source.
// The opening and closing fences must each start a line (m flag + `^`), so an
// inline ``` inside prose can't be mistaken for a fence boundary. The info
// string may carry trailing spaces before the newline.
const MERMAID_FENCE = /^```mermaid[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;
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
// plain code block. Dependencies are imported dynamically so a missing/broken
// install disables the feature instead of crashing the host at boot. The
// browser is launched and closed here so a render timeout can't orphan a
// chromium process — closing the browser in `finally` aborts an in-flight
// render.
export async function renderMermaidToPng(code: string): Promise<string | null> {
  let dir: string | undefined;
  let browser: { close: () => Promise<void> } | undefined;
  try {
    const { renderMermaid } = await import('@mermaid-js/mermaid-cli');
    const { default: puppeteer } = await import('puppeteer');
    browser = await puppeteer.launch({ args: ['--no-sandbox'] });
    const { data } = await withTimeout(
      renderMermaid(browser as never, code, 'png', {
        backgroundColor: 'white',
      }),
      RENDER_TIMEOUT_MS,
    );
    dir = await mkdtemp(join(tmpdir(), 'mermaid-'));
    const output = join(dir, 'diagram.png');
    await writeFile(output, data);
    return output;
  } catch (err) {
    logger.debug(
      { err },
      'Mermaid render failed; leaving fenced block as text',
    );
    if (dir) await cleanupMermaidPng(join(dir, 'diagram.png'));
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
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
  let timer: NodeJS.Timeout;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error('mermaid render timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export interface MermaidOutboundDeps {
  render: (code: string) => Promise<string | null>;
  sendPhoto: (
    pngPath: string,
  ) => Promise<{ ok: true; message_id: string } | { ok: false; error: string }>;
  onPhotoSent: (messageId: string, pngPath: string) => void;
  cleanup?: (pngPath: string) => Promise<void>;
}

// Renders each ```mermaid fence and sends the PNG as a photo. A fence is
// stripped from the returned text ONLY after its photo is confirmed sent — if
// either the render or the send fails, the fence is kept so it degrades to a
// plain code block instead of vanishing. Returns the remaining prose (carrying
// any surviving fences) for the caller to send as text. Dependencies are
// injected so the orchestration is testable without a browser or a channel.
export async function renderMermaidOutbound(
  text: string,
  deps: MermaidOutboundDeps,
): Promise<{ text: string }> {
  const blocks = extractMermaidBlocks(text);
  if (blocks.length === 0) return { text };

  let out = text;
  let stripped = 0;
  for (const block of blocks) {
    const png = await deps.render(block.code);
    if (!png) continue;
    try {
      const res = await deps.sendPhoto(png);
      if (res.ok) {
        deps.onPhotoSent(res.message_id, png);
        out = out.replace(block.raw, '');
        stripped++;
      }
    } finally {
      if (deps.cleanup) await deps.cleanup(png);
    }
  }
  if (stripped > 0) out = out.replace(/\n{3,}/g, '\n\n').trim();
  return { text: out };
}
