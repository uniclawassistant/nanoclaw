import { afterEach, describe, expect, it } from 'vitest';
import {
  extractMermaidBlocks,
  mermaidEnabled,
  renderAndSplitMermaid,
} from './mermaid.js';

const DIAGRAM = 'graph TD\n  A --> B';
const fence = (code: string) => '```mermaid\n' + code + '\n```';

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
});

describe('renderAndSplitMermaid', () => {
  it('leaves text untouched when there is no mermaid block', async () => {
    const res = await renderAndSplitMermaid('hello world', async () => null);
    expect(res).toEqual({ text: 'hello world', diagrams: [] });
  });

  it('strips a rendered fence and returns its png path', async () => {
    const res = await renderAndSplitMermaid(
      `Flow:\n${fence(DIAGRAM)}`,
      async () => '/tmp/x/diagram.png',
    );
    expect(res.diagrams).toEqual(['/tmp/x/diagram.png']);
    expect(res.text).toBe('Flow:');
    expect(res.text).not.toContain('mermaid');
  });

  it('keeps a fence in place when rendering fails', async () => {
    const input = `Flow:\n${fence(DIAGRAM)}`;
    const res = await renderAndSplitMermaid(input, async () => null);
    expect(res.diagrams).toEqual([]);
    expect(res.text).toBe(input);
  });

  it('strips only the blocks that render successfully', async () => {
    const input = `${fence('A')}\nmid\n${fence('B')}`;
    const res = await renderAndSplitMermaid(input, async (code) =>
      code === 'A' ? '/tmp/a/diagram.png' : null,
    );
    expect(res.diagrams).toEqual(['/tmp/a/diagram.png']);
    expect(res.text).toContain('```mermaid\nB\n```');
    expect(res.text).not.toContain('```mermaid\nA\n```');
  });

  it('returns empty text when the message is only a diagram', async () => {
    const res = await renderAndSplitMermaid(
      fence(DIAGRAM),
      async () => '/tmp/x/diagram.png',
    );
    expect(res.text).toBe('');
    expect(res.diagrams).toHaveLength(1);
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
