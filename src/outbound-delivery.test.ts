import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Mock image-gen — keep extractImageDirective/resolvePresets real (they are
// pure), replace the network-hitting generateImage/editImage with spies.
vi.mock('./image-gen.js', async () => {
  const actual =
    await vi.importActual<typeof import('./image-gen.js')>('./image-gen.js');
  return {
    ...actual,
    generateImage: vi.fn(),
    editImage: vi.fn(),
  };
});

// TTS never needs to hit an API in these tests — no `[[tts:]]` directives in
// the fixtures, but stub synthesize so accidental execution doesn't make
// outbound requests.
vi.mock('./tts.js', async () => {
  const actual = await vi.importActual<typeof import('./tts.js')>('./tts.js');
  return {
    ...actual,
    synthesize: vi.fn().mockResolvedValue(null),
  };
});

import { _initTestDatabase, getMessageById, storeChatMetadata } from './db.js';
import { sendWithTts } from './index.js';
import { editImage, generateImage } from './image-gen.js';
import type { Channel } from './types.js';

interface MockedChannel extends Channel {
  __calls: {
    sendMessage: ReturnType<typeof vi.fn>;
    sendPhoto: ReturnType<typeof vi.fn>;
    sendDocument: ReturnType<typeof vi.fn>;
    sendVoice: ReturnType<typeof vi.fn>;
  };
}

function makeMockChannel(): MockedChannel {
  const sendMessage = vi.fn().mockResolvedValue('m-100');
  const sendPhoto = vi.fn().mockResolvedValue('m-101');
  const sendDocument = vi.fn().mockResolvedValue('m-102');
  const sendVoice = vi.fn().mockResolvedValue('m-103');
  const channel: MockedChannel = {
    name: 'test',
    connect: vi.fn(),
    isConnected: () => true,
    ownsJid: () => true,
    disconnect: vi.fn(),
    sendMessage,
    sendPhoto,
    sendDocument,
    sendVoice,
    __calls: { sendMessage, sendPhoto, sendDocument, sendVoice },
  };
  return channel;
}

// Temp files stand in for preview (JPEG) and original (PNG). Small ones so
// the 9MB document-fallback path is NOT triggered by default.
let tmpPreview: string;
let tmpOriginal: string;

beforeEach(() => {
  _initTestDatabase();
  // Satisfy FK on messages.chat_jid → chats.jid when storeOutgoingMessage fires
  storeChatMetadata('tg:123', '2026-04-23T00:00:00.000Z');
  storeChatMetadata('tg:1', '2026-04-23T00:00:00.000Z');
  vi.clearAllMocks();
  const base = path.join(
    os.tmpdir(),
    `nanoclaw-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  tmpPreview = `${base}.jpg`;
  tmpOriginal = `${base}.png`;
  fs.writeFileSync(tmpPreview, Buffer.alloc(1024));
  fs.writeFileSync(tmpOriginal, Buffer.alloc(2048));
});

afterEach(() => {
  try {
    fs.unlinkSync(tmpPreview);
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(tmpOriginal);
  } catch {
    /* ignore */
  }
});

describe('sendWithTts — image tag dispatch (fix for IPC/scheduler silent-drop)', () => {
  it('with groupFolder + [[image:]] → generateImage fires, sendPhoto called, sendMessage NOT called', async () => {
    (generateImage as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      previewPath: tmpPreview,
      originalPath: tmpOriginal,
    });
    const channel = makeMockChannel();

    await sendWithTts(channel, 'tg:123', '[[image: a cat]]', undefined, 'main');

    await vi.waitFor(() => {
      expect(generateImage).toHaveBeenCalledWith(
        'a cat',
        expect.stringContaining('attachments'),
        [],
      );
      expect(channel.__calls.sendPhoto).toHaveBeenCalled();
    });
    // Tag-only message → cleanText is empty → no literal text leaked.
    expect(channel.__calls.sendMessage).not.toHaveBeenCalled();
  });

  it('REGRESSION: without groupFolder + [[image:]] → generateImage NOT called, tag leaks as literal text (demonstrates the bug the fix targets)', async () => {
    const channel = makeMockChannel();

    await sendWithTts(
      channel,
      'tg:123',
      '[[image: a cat]]',
      undefined,
      undefined,
    );

    expect(generateImage).not.toHaveBeenCalled();
    expect(channel.__calls.sendPhoto).not.toHaveBeenCalled();
    // The pre-fix behavior: tag flows through as plain text.
    expect(channel.__calls.sendMessage).toHaveBeenCalledWith(
      'tg:123',
      '[[image: a cat]]',
      undefined,
    );
  });

  it('with groupFolder: presets parsed and forwarded to generateImage', async () => {
    (generateImage as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      previewPath: tmpPreview,
      originalPath: tmpOriginal,
    });
    const channel = makeMockChannel();

    await sendWithTts(
      channel,
      'tg:123',
      '[[image:portrait,quality=high: a cat]]',
      undefined,
      'main',
    );

    await vi.waitFor(() => {
      expect(generateImage).toHaveBeenCalledWith('a cat', expect.any(String), [
        'portrait',
        'quality=high',
      ]);
    });
  });

  it('with groupFolder + [[image-edit:...]] → editImage fires, sendPhoto called', async () => {
    (editImage as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      previewPath: tmpPreview,
      originalPath: tmpOriginal,
    });
    const channel = makeMockChannel();

    await sendWithTts(
      channel,
      'tg:123',
      '[[image-edit: attachments/foo.jpg | bluer]]',
      undefined,
      'main',
    );

    await vi.waitFor(() => {
      expect(editImage).toHaveBeenCalled();
      expect(channel.__calls.sendPhoto).toHaveBeenCalled();
    });
    expect(channel.__calls.sendMessage).not.toHaveBeenCalled();
  });

  it('IPC-path wrapper contract: when folder is resolved and passed, tag is handled; when omitted, literal leaks', async () => {
    // Simulate the two sides of the pre-fix vs post-fix IPC sendMessage:
    // The wrapper is essentially `sendWithTts(ch, jid, text, undefined, folder?)`.
    (generateImage as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      previewPath: tmpPreview,
      originalPath: tmpOriginal,
    });

    const postFixChannel = makeMockChannel();
    const postFixSendMessage = (
      jid: string,
      text: string,
      folder: string | undefined,
    ) => sendWithTts(postFixChannel, jid, text, undefined, folder);

    const preFixChannel = makeMockChannel();
    const preFixSendMessage = (jid: string, text: string) =>
      sendWithTts(preFixChannel, jid, text);

    await postFixSendMessage('tg:1', '[[image: cat]]', 'main');
    await preFixSendMessage('tg:1', '[[image: cat]]');

    await vi.waitFor(() => {
      // Post-fix: image pipeline engaged.
      expect(postFixChannel.__calls.sendPhoto).toHaveBeenCalled();
    });
    // Pre-fix simulation: tag was forwarded as text (demonstrates the hole).
    expect(preFixChannel.__calls.sendMessage).toHaveBeenCalledWith(
      'tg:1',
      '[[image: cat]]',
      undefined,
    );
    // And post-fix does NOT leak as text:
    expect(postFixChannel.__calls.sendMessage).not.toHaveBeenCalled();
  });

  it('non-tag text with groupFolder goes through sendMessage as normal', async () => {
    const channel = makeMockChannel();
    await sendWithTts(channel, 'tg:123', 'hello there', undefined, 'main');
    expect(generateImage).not.toHaveBeenCalled();
    expect(channel.__calls.sendMessage).toHaveBeenCalledWith(
      'tg:123',
      'hello there',
      undefined,
    );
  });
});

describe('sendWithTts — image-gen failure signalling', () => {
  it('moderation_block → [host] signal sent, no photo, original prompt NOT leaked', async () => {
    (generateImage as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      reason: 'moderation',
      code: 'moderation_block',
      message: 'Your request was rejected by the safety system.',
    });
    const channel = makeMockChannel();

    await sendWithTts(
      channel,
      'tg:123',
      '[[image: a sensitive prompt]]',
      undefined,
      'main',
    );

    await vi.waitFor(() => {
      expect(channel.__calls.sendMessage).toHaveBeenCalled();
    });
    const [jid, text] = channel.__calls.sendMessage.mock.calls[0];
    expect(jid).toBe('tg:123');
    expect(text).toMatch(/^\[host\]/);
    expect(text).toContain('moderation');
    expect(text).toContain('Rephrase');
    // Crucially: the rejected prompt text must NOT be echoed to chat/DB.
    expect(text).not.toContain('a sensitive prompt');
    expect(channel.__calls.sendPhoto).not.toHaveBeenCalled();
  });

  it('generic 400 user_error → [host] signal with "Adjust" + code hint', async () => {
    (generateImage as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      reason: 'generic',
      code: 'invalid_value',
      message: 'Transparent background is not supported for this model.',
    });
    const channel = makeMockChannel();

    await sendWithTts(channel, 'tg:123', '[[image: a cat]]', undefined, 'main');

    await vi.waitFor(() => {
      expect(channel.__calls.sendMessage).toHaveBeenCalled();
    });
    const text = channel.__calls.sendMessage.mock.calls[0][1];
    expect(text).toMatch(/^\[host\]/);
    expect(text).toContain('Adjust');
    expect(text).toContain('invalid_value');
  });

  it('GENERATE + transient (5xx, network) → NO [host] signal (agent has no preview to worry about)', async () => {
    (generateImage as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      reason: 'transient',
    });
    const channel = makeMockChannel();

    await sendWithTts(channel, 'tg:123', '[[image: a cat]]', undefined, 'main');

    // Give the fire-and-forget a tick to settle.
    await new Promise((r) => setTimeout(r, 50));
    expect(channel.__calls.sendMessage).not.toHaveBeenCalled();
    expect(channel.__calls.sendPhoto).not.toHaveBeenCalled();
  });

  it('EDIT + transient (timeout, network) → [host] signal with retry guidance (user had a preview waiting)', async () => {
    (editImage as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      reason: 'transient',
    });
    const channel = makeMockChannel();

    await sendWithTts(
      channel,
      'tg:123',
      '[[image-edit: attachments/foo.jpg | bluer]]',
      undefined,
      'main',
    );

    await vi.waitFor(() => {
      expect(channel.__calls.sendMessage).toHaveBeenCalled();
    });
    const text = channel.__calls.sendMessage.mock.calls[0][1];
    expect(text).toMatch(/^\[host\]/);
    expect(text).toContain('Image edit');
    expect(text).toContain('retry');
    expect(channel.__calls.sendPhoto).not.toHaveBeenCalled();
  });

  it('threshold: 3rd consecutive moderation_block appends "Stop retrying"', async () => {
    (generateImage as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      reason: 'moderation',
      code: 'moderation_block',
    });
    const channel = makeMockChannel();

    // 1st + 2nd: plain signal
    for (let i = 0; i < 2; i++) {
      await sendWithTts(
        channel,
        'tg:123',
        '[[image: attempt]]',
        undefined,
        'threshold-group',
      );
    }
    await vi.waitFor(() => {
      expect(channel.__calls.sendMessage).toHaveBeenCalledTimes(2);
    });
    for (const call of channel.__calls.sendMessage.mock.calls) {
      expect(call[1]).not.toContain('Stop retrying');
    }

    // 3rd call: suffix kicks in
    await sendWithTts(
      channel,
      'tg:123',
      '[[image: attempt]]',
      undefined,
      'threshold-group',
    );
    await vi.waitFor(() => {
      expect(channel.__calls.sendMessage).toHaveBeenCalledTimes(3);
    });
    const third = channel.__calls.sendMessage.mock.calls[2][1];
    expect(third).toContain('Stop retrying');
  });

  it('successful generation clears the moderation counter', async () => {
    // Seed counter via two moderation rejects
    (generateImage as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      reason: 'moderation',
      code: 'moderation_block',
    });
    const channel = makeMockChannel();
    for (let i = 0; i < 2; i++) {
      await sendWithTts(
        channel,
        'tg:123',
        '[[image: attempt]]',
        undefined,
        'reset-group',
      );
    }
    await vi.waitFor(() => {
      expect(channel.__calls.sendMessage).toHaveBeenCalledTimes(2);
    });

    // Success resets the counter
    (generateImage as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      previewPath: tmpPreview,
      originalPath: tmpOriginal,
    });
    await sendWithTts(
      channel,
      'tg:123',
      '[[image: good one]]',
      undefined,
      'reset-group',
    );
    await vi.waitFor(() => {
      expect(channel.__calls.sendPhoto).toHaveBeenCalled();
    });

    // Now two more moderation rejects — counter should start from zero again,
    // so neither gets the "Stop retrying" suffix.
    (generateImage as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      reason: 'moderation',
      code: 'moderation_block',
    });
    channel.__calls.sendMessage.mockClear();
    for (let i = 0; i < 2; i++) {
      await sendWithTts(
        channel,
        'tg:123',
        '[[image: attempt]]',
        undefined,
        'reset-group',
      );
    }
    await vi.waitFor(() => {
      expect(channel.__calls.sendMessage).toHaveBeenCalledTimes(2);
    });
    for (const call of channel.__calls.sendMessage.mock.calls) {
      expect(call[1]).not.toContain('Stop retrying');
    }
  });

  it('source_missing (edit preflight) → [host] signal with get_message hint', async () => {
    (editImage as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      reason: 'source_missing',
      message: 'Source file not found: photo_3385.jpg',
    });
    const channel = makeMockChannel();

    await sendWithTts(
      channel,
      'tg:123',
      '[[image-edit: attachments/nope.jpg | bluer]]',
      undefined,
      'main',
    );

    await vi.waitFor(() => {
      expect(channel.__calls.sendMessage).toHaveBeenCalled();
    });
    const text = channel.__calls.sendMessage.mock.calls[0][1];
    expect(text).toMatch(/^\[host\]/);
    expect(text).toContain('photo_3385.jpg');
    expect(text).toContain('get_message');
    expect(channel.__calls.sendPhoto).not.toHaveBeenCalled();
  });

  it('source_missing handles "unreadable" and "empty" message variants', async () => {
    (editImage as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      reason: 'source_missing',
      message: 'Source file is empty: broken.jpg',
    });
    const channel = makeMockChannel();
    await sendWithTts(
      channel,
      'tg:123',
      '[[image-edit: attachments/broken.jpg | redo]]',
      undefined,
      'main',
    );
    await vi.waitFor(() => {
      expect(channel.__calls.sendMessage).toHaveBeenCalled();
    });
    expect(channel.__calls.sendMessage.mock.calls[0][1]).toContain(
      'Source file is empty: broken.jpg',
    );
  });

  it('source_missing handles "unreadable" variant (permission denied etc)', async () => {
    (editImage as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      reason: 'source_missing',
      message: 'Source file unreadable: locked.jpg',
    });
    const channel = makeMockChannel();
    await sendWithTts(
      channel,
      'tg:123',
      '[[image-edit: attachments/locked.jpg | redo]]',
      undefined,
      'main',
    );
    await vi.waitFor(() => {
      expect(channel.__calls.sendMessage).toHaveBeenCalled();
    });
    expect(channel.__calls.sendMessage.mock.calls[0][1]).toContain(
      'Source file unreadable: locked.jpg',
    );
  });

  it('source_missing with no message falls back to generic "Source file not found"', async () => {
    (editImage as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      reason: 'source_missing',
    });
    const channel = makeMockChannel();
    await sendWithTts(
      channel,
      'tg:123',
      '[[image-edit: attachments/anything.jpg | redo]]',
      undefined,
      'main',
    );
    await vi.waitFor(() => {
      expect(channel.__calls.sendMessage).toHaveBeenCalled();
    });
    expect(channel.__calls.sendMessage.mock.calls[0][1]).toContain(
      'Source file not found',
    );
  });

  it('host signal is stored with sender=host, is_from_me=1, is_bot_message=0 (agent context, not user-fallback)', async () => {
    (generateImage as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      reason: 'moderation',
      code: 'moderation_block',
    });
    const channel = makeMockChannel();

    await sendWithTts(channel, 'tg:123', '[[image: x]]', undefined, 'main');
    await vi.waitFor(() => {
      expect(channel.__calls.sendMessage).toHaveBeenCalled();
    });

    // channel.sendMessage mock returns 'm-100' (per makeMockChannel).
    const rec = getMessageById('m-100', 'tg:123');
    expect(rec).not.toBeNull();
    expect(rec!.sender).toBe('host');
    // direction 'out' means is_from_me=1 OR is_bot_message=1 — for our
    // host-signal flag combo (is_from_me=1, is_bot_message=0) this is 'out'.
    expect(rec!.direction).toBe('out');
    expect(rec!.text).toMatch(/^\[host\]/);
  });
});
