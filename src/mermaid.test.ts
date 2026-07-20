import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extractMermaidBlocks,
  mermaidEnabled,
  renderMermaidOutbound,
  type MermaidOutboundDeps,
} from './mermaid.js';

const DIAGRAM = 'graph TD\n  A --> B';
const fence = (code: string) => '```mermaid\n' + code + '\n```';

const okPhoto = (id = 'm1') =>
  vi.fn(async () => ({ ok: true as const, message_id: id }));

function deps(
  overrides: Partial<MermaidOutboundDeps> = {},
): MermaidOutboundDeps {
  return {
    render: async () => '/tmp/x/diagram.png',
    sendPhoto: okPhoto(),
    onPhotoSent: vi.fn(),
    cleanup: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('extractMermaidBlocks', () => {
  it('returns nothing when there is no mermaid fence', () => {
    expect(extractMermaidBlocks('just text')).toEqual([]);
    expect(extractMermaidBlocks('```js\nconst a = 1;\n```')).toEqual([]);
  });

  it('extracts a single block and trims its code', () => {
    const blocks = extractMermaidBlocks(`Here:\n${fence(DIAGRAM)}\ndone`);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].code).toBe(DIAGRAM);
    expect(blocks[0].raw).toBe(fence(DIAGRAM));
  });

  it('extracts multiple blocks in document order', () => {
    const blocks = extractMermaidBlocks(
      `${fence('graph TD\n A-->B')}\nmid\n${fence('sequenceDiagram\n X->>Y: hi')}`,
    );
    expect(blocks.map((b) => b.code)).toEqual([
      'graph TD\n A-->B',
      'sequenceDiagram\n X->>Y: hi',
    ]);
  });

  it('ignores an empty mermaid fence', () => {
    expect(extractMermaidBlocks('```mermaid\n\n```')).toEqual([]);
  });

  it('does not treat an inline ``` inside prose as a fence boundary', () => {
    // A properly-closed mermaid block followed by prose that mentions ``` must
    // not have its boundary confused by the inline backticks.
    const text = `${fence(DIAGRAM)}\nuse \`\`\`code\`\`\` inline`;
    const blocks = extractMermaidBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].code).toBe(DIAGRAM);
  });
});

describe('renderMermaidOutbound', () => {
  it('leaves text untouched when there is no mermaid block', async () => {
    const d = deps();
    const res = await renderMermaidOutbound('hello world', d);
    expect(res.text).toBe('hello world');
    expect(d.sendPhoto).not.toHaveBeenCalled();
  });

  it('strips a fence and records the photo once it is confirmed sent', async () => {
    const d = deps({ sendPhoto: okPhoto('mid-42') });
    const res = await renderMermaidOutbound(`Flow:\n${fence(DIAGRAM)}`, d);
    expect(res.text).toBe('Flow:');
    expect(res.text).not.toContain('mermaid');
    expect(d.onPhotoSent).toHaveBeenCalledWith('mid-42', '/tmp/x/diagram.png');
    expect(d.cleanup).toHaveBeenCalledWith('/tmp/x/diagram.png');
  });

  it('keeps the fence when the render fails', async () => {
    const input = `Flow:\n${fence(DIAGRAM)}`;
    const d = deps({ render: async () => null });
    const res = await renderMermaidOutbound(input, d);
    expect(res.text).toBe(input);
    expect(d.sendPhoto).not.toHaveBeenCalled();
    expect(d.onPhotoSent).not.toHaveBeenCalled();
  });

  it('keeps the fence (degrades to code block) when sendPhoto fails', async () => {
    // The blocker case: render succeeds but the photo send fails. The fence
    // must survive so the diagram is not lost — and the temp file is cleaned.
    const input = `Flow:\n${fence(DIAGRAM)}`;
    const d = deps({
      sendPhoto: vi.fn(async () => ({ ok: false as const, error: 'timeout' })),
    });
    const res = await renderMermaidOutbound(input, d);
    expect(res.text).toBe(input);
    expect(res.text).toContain('```mermaid');
    expect(d.onPhotoSent).not.toHaveBeenCalled();
    expect(d.cleanup).toHaveBeenCalledWith('/tmp/x/diagram.png');
  });

  it('strips only the blocks that were sent successfully', async () => {
    const input = `${fence('A')}\nmid\n${fence('B')}`;
    const d = deps({
      render: async (code) => `/tmp/${code}/diagram.png`,
      sendPhoto: vi.fn(async (png: string) =>
        png.includes('/A/')
          ? { ok: true as const, message_id: 'a' }
          : { ok: false as const, error: 'boom' },
      ),
    });
    const res = await renderMermaidOutbound(input, d);
    expect(res.text).toContain('```mermaid\nB\n```');
    expect(res.text).not.toContain('```mermaid\nA\n```');
  });

  it('returns empty text when the message is only a diagram', async () => {
    const res = await renderMermaidOutbound(fence(DIAGRAM), deps());
    expect(res.text).toBe('');
  });
});

describe('mermaidEnabled', () => {
  const prev = process.env.MERMAID_RENDER;
  afterEach(() => {
    if (prev === undefined) delete process.env.MERMAID_RENDER;
    else process.env.MERMAID_RENDER = prev;
  });

  it('is enabled by default', () => {
    delete process.env.MERMAID_RENDER;
    expect(mermaidEnabled()).toBe(true);
  });

  it('can be turned off via env', () => {
    for (const v of ['0', 'false', 'off', 'no']) {
      process.env.MERMAID_RENDER = v;
      expect(mermaidEnabled()).toBe(false);
    }
  });
});
